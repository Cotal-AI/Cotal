#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { coldResultNames, verifyColdResults } from "./verify-cold-results.mjs";
import { publicationDeadline, remainingBudget, withinPublicationBudget } from "./publication-budget.mjs";
import { isMainEntry } from "./main-entry.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workflow = ".github/workflows/cold-setup.yml";
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const artifactNames = () => ["cold-candidate", "cold-qualified", ...coldResultNames()].sort();
const CONTROL_ROOT = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const positiveId = (value) => { assert(/^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)), "qualification needs a positive run or artifact ID"); return Number(value); };

async function githubJson(path, env, deadline, fetchImpl) {
  assert(typeof env.GH_TOKEN === "string" && env.GH_TOKEN.length > 0, "qualification needs the workflow's actions-read credential");
  return withinPublicationBudget(async (signal) => {
    const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "manual", signal,
    });
    assert.equal(response.status, 200, "qualification API read failed");
    return response.json();
  }, deadline);
}

function publicationContext({ publisherRoot, env, exec, deadline }) {
  assert(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main", "promotion is restricted to a main-only publication dispatch");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1", "publication reruns cannot retry unknown writes; inspect the original outcomes read-only");
  assert(sha.test(env.RELEASE_SOURCE ?? "") && sha.test(env.GITHUB_SHA ?? ""), "promotion needs its requested main source and publisher source");
  const options = { cwd: publisherRoot, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 };
  const publisherSource = exec("git", ["rev-parse", "HEAD"], options).trim();
  assert.equal(publisherSource, env.GITHUB_SHA, "publisher controls differ from the main workflow source");
  if (env.RELEASE_SOURCE !== publisherSource) {
    const lineage = exec("git", ["rev-list", "--first-parent", `${env.RELEASE_SOURCE}^..${publisherSource}`], { ...options, timeout: remainingBudget(deadline) }).trim().split("\n");
    assert(lineage.includes(env.RELEASE_SOURCE), "requested release source is not a first-parent main commit");
  }
  return publisherSource;
}

export function checkoutReleaseSource({ publisherRoot = CONTROL_ROOT, env = process.env, exec = execFileSync, deadline }) {
  publicationContext({ publisherRoot, env, exec, deadline });
  assert(env.RUNNER_TEMP && env.RELEASE_ROOT, "release source checkout needs its owned runner directory");
  const root = resolve(env.RELEASE_ROOT);
  assert.equal(root, resolve(env.RUNNER_TEMP, "release-source"), "release worktree must stay in its owned runner directory");
  assert(!existsSync(root), "refusing to overwrite an existing release worktree");
  exec("git", ["worktree", "add", "--detach", root, env.RELEASE_SOURCE], { cwd: publisherRoot, timeout: remainingBudget(deadline), killSignal: "SIGKILL", stdio: "pipe" });
  return root;
}

export function recordQualification({ root, directory, results, output, env = process.env, exec = execFileSync }) {
  const source = exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceTree = exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(source, env.GITHUB_SHA, "qualification checkout differs from its workflow source");
  assert(sha.test(source) && sha.test(sourceTree), "qualification needs its source and tree");
  const bytes = readFileSync(join(directory, "manifest.json"));
  assert.equal(JSON.parse(bytes).source, source, "qualification candidate belongs to another checkout");
  const receipt = {
    v: 1, repository: env.GITHUB_REPOSITORY, runId: positiveId(env.GITHUB_RUN_ID), runAttempt: positiveId(env.GITHUB_RUN_ATTEMPT),
    source, sourceTree, candidateSha256: hash(bytes), snapshot: env.SNAPSHOT ?? "",
    resultCount: verifyColdResults(results, source, hash(bytes)),
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return receipt;
}

export async function selectQualification({ runId, env = process.env, deadline, fetchImpl = fetch }) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? ""), "qualification repository is invalid");
  runId = positiveId(runId);
  const run = await githubJson(`actions/runs/${runId}`, env, deadline, fetchImpl);
  assert.equal(run.id, runId);
  assert.equal(run.repository?.full_name, env.GITHUB_REPOSITORY, "qualification is from another repository");
  assert.equal(run.head_repository?.full_name, env.GITHUB_REPOSITORY, "fork qualifications cannot publish");
  assert.equal(run.path, workflow, "qualification ran another workflow");
  assert(run.event === "pull_request" || (run.event === "workflow_dispatch" && run.head_branch === "main"), "qualification needs a same-repository PR or a main dispatch");
  assert(run.status === "completed" && run.conclusion === "success", "qualification has not completed successfully");
  // A full fresh run avoids mixing v4 artifacts left by earlier attempts of a partial rerun.
  assert.equal(run.run_attempt, 1, "qualification reruns are not promotable; prepare a fresh run before publish-go");
  assert(sha.test(run.head_sha), "qualification has no exact head");
  const requested = Date.parse(env.RELEASE_REQUESTED_AT);
  assert(Number.isFinite(requested) && Number.isFinite(Date.parse(run.updated_at)) && Date.parse(run.updated_at) <= requested, "qualification did not finish before the original publish request");
  const listing = await githubJson(`actions/runs/${runId}/artifacts?per_page=100`, env, deadline, fetchImpl);
  assert(Number.isSafeInteger(listing.total_count) && listing.total_count <= 100 && listing.total_count === listing.artifacts?.length, "qualification artifact listing is incomplete");
  const artifacts = artifactNames().map((name) => {
    const matches = listing.artifacts.filter((artifact) => artifact.name === name);
    assert.equal(matches.length, 1, `qualification needs one immutable ${name} artifact`);
    const artifact = matches[0];
    assert(artifact.expired === false && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ""), "qualification artifact is expired or lacks its immutable digest");
    assert.equal(artifact.workflow_run?.id, runId, "qualification artifact belongs to another run");
    assert.equal(artifact.workflow_run?.head_sha, run.head_sha, "qualification artifact belongs to another head");
    assert(Date.parse(artifact.created_at) <= requested, "qualification artifact appeared after publish-go");
    return { id: positiveId(artifact.id), name, digest: artifact.digest };
  });
  assert.equal(new Set(artifacts.map(({ id }) => id)).size, artifacts.length, "qualification repeats an artifact ID");
  return { v: 1, repository: env.GITHUB_REPOSITORY, runId, runAttempt: run.run_attempt, event: run.event, head: run.head_sha, artifacts };
}

export async function verifyQualification({ root, publisherRoot = CONTROL_ROOT, directory, results, selectionFile, tag, env = process.env, exec = execFileSync, deadline, fetchImpl = fetch }) {
  const publisherSource = publicationContext({ publisherRoot, env, exec, deadline });
  assert(digest.test(env.RELEASE_CANDIDATE_SHA256 ?? ""), "promotion needs the pinned candidate digest");
  const source = exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL" }).trim();
  const sourceTree = exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL" }).trim();
  assert.equal(source, env.RELEASE_SOURCE, "release checkout differs from the requested immutable source");
  const selected = readJson(selectionFile);
  const live = await selectQualification({ runId: env.RELEASE_QUALIFICATION_RUN, env, deadline, fetchImpl });
  assert.deepEqual(selected, live, "qualification identity or immutable artifact selection changed");
  const qualified = readJson(join(directory, "..", "cold-qualified", "qualification.json"));
  assert.equal(qualified.v, 1);
  for (const field of ["repository", "runId", "runAttempt"]) assert.equal(qualified[field], live[field], `qualification ${field} differs`);
  assert(sha.test(qualified.source ?? ""), "qualification source is invalid");
  assert.equal(qualified.sourceTree, sourceTree, "qualified source tree differs from the approved publication tree");
  const original = await githubJson(`git/commits/${qualified.source}`, env, deadline, fetchImpl);
  assert.equal(original.sha, qualified.source);
  assert.equal(original.tree?.sha, sourceTree, "qualification tree claim differs from its Git object");
  if (live.event === "pull_request") {
    assert(original.parents?.length === 2 && original.parents[1].sha === live.head, "qualification is not the run's PR merge snapshot");
  } else assert.equal(qualified.source, live.head, "qualification is not the run's dispatch head");
  assert.equal(tag, qualified.snapshot || "latest", "publication tag differs from qualification");
  // Snapshot version replay is already commit-bound. Do not relabel its native build records.
  if (qualified.snapshot) assert.equal(qualified.source, source, "snapshot qualification must use this main commit");
  const bytes = readFileSync(join(directory, "manifest.json"));
  assert.equal(hash(bytes), env.RELEASE_CANDIDATE_SHA256, "publication candidate differs from the requested immutable bytes");
  assert.equal(qualified.candidateSha256, hash(bytes), "qualification covered another archive set");
  assert.equal(JSON.parse(bytes).source, qualified.source, "candidate rewrote its original build source");
  assert.equal(qualified.resultCount, coldResultNames().length);
  assert.equal(verifyColdResults(results, qualified.source, hash(bytes)), qualified.resultCount);
  return { ...qualified, promotionSource: source, publisherSource, artifacts: live.artifacts };
}

if (isMainEntry(import.meta.url)) {
  const root = resolve(process.env.RELEASE_ROOT ?? CONTROL_ROOT);
  const [operation, first, second, third, fourth] = process.argv.slice(2);
  (async () => {
    if (operation === "record") return recordQualification({ root: CONTROL_ROOT, directory: first, results: second, output: third });
    const deadline = publicationDeadline(process.env.RELEASE_REQUESTED_AT);
    if (operation === "checkout") return checkoutReleaseSource({ deadline });
    if (operation === "select") {
      const selected = await selectQualification({ runId: process.env.RELEASE_QUALIFICATION_RUN, deadline });
      writeFileSync(first, JSON.stringify(selected, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      appendFileSync(process.env.GITHUB_OUTPUT, `artifact-ids=${selected.artifacts.map(({ id }) => id).join(",")}\n`);
      return;
    }
    if (operation === "verify") return verifyQualification({ root, selectionFile: first, directory: second, results: third, tag: fourth || "latest", deadline });
    throw new Error("usage: release-qualification.mjs record <candidate> <results> <output> | checkout | select <selection> | verify <selection> <candidate> <results> [tag]");
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
