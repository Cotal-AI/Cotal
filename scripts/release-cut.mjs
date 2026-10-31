#!/usr/bin/env node
/**
 * The release owner's publish command.
 *
 * Usage: pnpm release:cut <main-sha>
 *
 * Refuses a commit that is not main's head or carries no changeset. Waits for a packed version PR
 * based on that commit, refusing source drift instead of selecting a newer release. Merges the
 * version PR by its head commit; the merge's push run publishes that pack. Then follows the run and
 * polls npm for the new `cotal-ai` version until it answers.
 *
 * The final main check and GitHub merge are separate operations, not an atomic base assertion.
 * The merged-tree check below still guards the packed source after the merge.
 *
 * Each line is one point on the release timeline, in UTC: command, ready, merged, run, published,
 * rerun (after a failed publish job), visible, run rc. The ten-minute budget runs from `command` to
 * `visible`. A command given before `ready` also waits for the preparation that the merge of the fix
 * started.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BRANCH = "changeset-release/main";
const POLL_MS = 10_000;
const READY_DEADLINE_MS = 20 * 60_000;
const RUN_DEADLINE_MS = 40 * 60_000;
const MAX_RERUNS = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const time = () => new Date().toISOString().slice(11, 19) + "Z";
const short = (sha) => sha.slice(0, 9);

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function attempt(cmd, args) {
  try {
    return run(cmd, args);
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.log(message);
  process.exit(1);
}

const isAncestor = (a, b) => attempt("git", ["merge-base", "--is-ancestor", a, b]) !== undefined;

function requireRequestedMain(sha) {
  const main = run("git", ["rev-parse", "origin/main"]);
  if (main !== sha) fail(`refused: requested source ${short(sha)} differs from current main ${short(main)}; nothing was merged`);
}

function changesets(sha) {
  return run("git", ["ls-tree", "--name-only", sha, ".changeset/"])
    .split("\n")
    .filter((path) => path.endsWith(".md") && path !== ".changeset/README.md");
}

/** The latest push run of this workflow for `sha`, or undefined until GitHub lists it. */
function pushRun(sha) {
  const out = attempt("gh", ["run", "list", "--workflow", "changesets.yml", "--event", "push", "--branch", "main",
    "--commit", sha, "--limit", "1", "--json", "databaseId,status,conclusion"]);
  return out ? JSON.parse(out)[0] : undefined;
}

/** The run's status and attempt, with the publish job of that attempt; undefined if gh fails. */
function runState(runId) {
  const out = attempt("gh", ["api", `repos/{owner}/{repo}/actions/runs/${runId}`, "--jq", "{status, conclusion, attempt: .run_attempt}"]);
  const job = attempt("gh", ["api", `repos/{owner}/{repo}/actions/runs/${runId}/jobs`, "--jq", '.jobs[] | select(.name == "publish") | {status, conclusion}']);
  return out ? { ...JSON.parse(out), publish: job ? JSON.parse(job) : undefined } : undefined;
}

const want = process.argv[2];
if (!want) fail("usage: pnpm release:cut <main-sha>");

console.log(`command ${time()}`);
run("git", ["fetch", "-q", "origin", "main"]);
const sha = attempt("git", ["rev-parse", "--verify", `${want}^{commit}`]);
if (!sha) fail(`refused: ${want} is not a known commit`);
requireRequestedMain(sha);
if (changesets(sha).length === 0) fail(`refused: ${short(sha)} carries no changeset, so there is nothing to release`);

let rel;
let base;
const readyBy = Date.now() + READY_DEADLINE_MS;
for (;;) {
  attempt("git", ["fetch", "-q", "origin", "main", RELEASE_BRANCH]);
  requireRequestedMain(sha);
  rel = attempt("git", ["rev-parse", "--verify", `origin/${RELEASE_BRANCH}^{commit}`]);
  base = rel && run("git", ["rev-parse", `${rel}^`]);
  if (rel && base !== sha && isAncestor(sha, rel)) {
    fail(`refused: requested source ${short(sha)} differs from version PR base ${short(base)}; nothing was merged`);
  }
  if (rel && base === sha && changesets(rel).length === 0) {
    const prepared = pushRun(base);
    if (prepared?.conclusion === "success") {
      const artifacts = run("gh", ["api", `repos/{owner}/{repo}/actions/runs/${prepared.databaseId}/artifacts`, "--jq", ".artifacts[].name"]);
      if (artifacts.split("\n").includes("release-candidate")) break;
      fail(`push run ${prepared.databaseId} for ${short(base)} made no release-candidate; nothing was merged`);
    }
    if (prepared?.status === "completed") {
      fail(`push run ${prepared.databaseId} for ${short(base)} ended ${prepared.conclusion}; nothing was merged`);
    }
  }
  if (Date.now() > readyBy) fail(`the version PR was not packed for ${short(sha)} within ${READY_DEADLINE_MS / 60_000} minutes; nothing was merged`);
  await sleep(POLL_MS);
}
const version = JSON.parse(run("git", ["show", `${rel}:bin/package.json`])).version;
console.log(`ready ${time()} main=${short(base)} rel=${short(rel)} ver=${version}`);

const pr = run("gh", ["pr", "list", "--head", RELEASE_BRANCH, "--state", "open", "--json", "number", "--jq", ".[0].number"]);
run("git", ["fetch", "-q", "origin", "main"]);
requireRequestedMain(sha);
try {
  run("gh", ["pr", "merge", pr, "--squash", "--match-head-commit", rel]);
} catch (err) {
  fail(`merge failed pr=${pr}: ${String(err.stderr ?? err.message).trim()}`);
}
run("git", ["fetch", "-q", "origin", "main"]);
const merged = run("git", ["rev-parse", "origin/main"]);
console.log(`merged ${time()} pr=${pr} main ${run("git", ["log", "--oneline", "-1", merged])}`);
if (run("git", ["rev-parse", `${merged}^{tree}`]) !== run("git", ["rev-parse", `${rel}^{tree}`])) {
  fail(`main ${short(merged)} does not hold the packed tree of ${short(rel)}; its push run will refuse to publish`);
}

const runBy = Date.now() + RUN_DEADLINE_MS;
let id;
while (!(id = pushRun(merged)?.databaseId)) {
  if (Date.now() > runBy) fail(`no push run appeared for ${short(merged)}`);
  await sleep(POLL_MS / 2);
}
console.log(`run ${id} started ${time()}`);

// A rerun skips every version npm already holds, staged or visible, so a failed publish job (a Rekor
// conflict, a registry error) is re-run instead of waiting for someone to notice.
let visible = false;
let published;
let conclusion;
let reported = 0;
let reruns = 0;
let rerunAttempt = 0;
for (;;) {
  if (!visible && attempt("npm", ["view", `cotal-ai@${version}`, "version", "--prefer-online"]) === version) {
    visible = true;
    console.log(`npm cotal-ai ${version} visible ${time()}`);
  }
  const view = runState(id) ?? { attempt: 0 };
  const job = view.publish;
  if (view.attempt > reported && job?.status === "completed") {
    reported = view.attempt;
    published = job.conclusion;
    console.log(`published rc=${published} ${time()}`);
  }
  if (view.status === "completed" && view.attempt > rerunAttempt && (!job || job.status === "completed") && !conclusion) {
    if (published === "failure" && reruns < MAX_RERUNS) {
      reruns++;
      rerunAttempt = view.attempt;
      published = undefined;
      run("gh", ["run", "rerun", String(id), "--failed"]);
      console.log(`rerun ${reruns} ${time()}`);
    } else {
      conclusion = view.conclusion;
      console.log(`run rc=${conclusion} ${time()}`);
      if (published !== "success" && !visible) fail(`the publish job ${published ? `ended ${published}` : "did not run"}; inspect the registry before another retry`);
    }
  }
  if (visible && conclusion) break;
  if (Date.now() > runBy) fail(`deadline: visible=${visible} publish=${published ?? "running"} run=${conclusion ?? "running"}`);
  await sleep(POLL_MS);
}
console.log(attempt("npm", ["view", "cotal-ai", "time", "--json"])?.split("\n").find((l) => l.includes(`"${version}"`))?.trim() ?? "");
process.exit(published === "success" && conclusion === "success" ? 0 : 1);
