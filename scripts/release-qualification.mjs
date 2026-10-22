#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { coldResultNames, verifyColdResults } from "./verify-cold-results.mjs";
import { publicationDeadline, publicationStartedAt, remainingBudget, withinPublicationBudget } from "./publication-budget.mjs";
import { isMainEntry } from "./main-entry.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workflow = ".github/workflows/cold-setup.yml";
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const releaseVersion = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
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
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.source, source, "qualification candidate belongs to another checkout");
  const versions = new Set(manifest.packages.map(({ version }) => version));
  assert(versions.size === 1 && typeof [...versions][0] === "string" && releaseVersion.test([...versions][0]), "qualification needs one supported release version");
  const receipt = {
    v: 2, version: [...versions][0], repository: env.GITHUB_REPOSITORY, runId: positiveId(env.GITHUB_RUN_ID), runAttempt: positiveId(env.GITHUB_RUN_ATTEMPT),
    source, sourceTree, candidateSha256: hash(bytes), snapshot: env.SNAPSHOT ?? "",
    resultCount: verifyColdResults(results, source, hash(bytes)),
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return receipt;
}

export async function verifyPublicationRequest({ env = process.env, deadline, fetchImpl = fetch }) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? ""), "publication request repository is invalid");
  assert(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main", "publication requests require a main dispatch");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1", "publication reruns cannot replace the original request");
  assert(releaseVersion.test(env.RELEASE_VERSION ?? ""), "publication needs its prepared release version");
  assert(digest.test(env.RELEASE_CANDIDATE_SHA256 ?? "") && sha.test(env.RELEASE_SOURCE ?? "") && /^[A-Za-z][A-Za-z0-9._-]*$/.test(env.RELEASE_TAG ?? ""), "publication request scope is invalid");
  const qualificationRun = positiveId(env.RELEASE_QUALIFICATION_RUN);
  const id = positiveId(env.GITHUB_RUN_ID);
  const current = await githubJson(`actions/runs/${id}`, env, deadline, fetchImpl);
  const releaseWorkflow = ".github/workflows/changesets.yml";
  const validate = (run) => {
    assert(run.repository?.full_name === env.GITHUB_REPOSITORY && run.head_repository?.full_name === env.GITHUB_REPOSITORY && run.path === releaseWorkflow && run.event === "workflow_dispatch" && run.head_branch === "main", "publication request belongs to another workflow or repository");
    positiveId(run.id); positiveId(run.run_number);
  };
  validate(current);
  assert.equal(current.id, id);
  assert.equal(current.head_sha, env.GITHUB_SHA, "publication request differs from the main publisher source");
  assert.equal(current.run_attempt, 1, "publication request was rerun");
  const until = Date.parse(current.created_at);
  assert(Number.isFinite(until), "publication request has no server creation time");
  const history = async (from, to) => {
    const query = new URLSearchParams({ event: "workflow_dispatch", branch: "main", created: `${new Date(from).toISOString()}..${new Date(to).toISOString()}`, per_page: "100" });
    const path = `actions/workflows/changesets.yml/runs?${query}`;
    const first = await githubJson(path + "&page=1", env, deadline, fetchImpl);
    assert(Number.isSafeInteger(first.total_count) && first.total_count >= 0 && Array.isArray(first.workflow_runs) && first.workflow_runs.length <= 100, "publication request history is invalid");
    // GitHub caps a filtered search at 1000 results. Partition server time rather than
    // treating a truncated page as proof that an older request never existed.
    if (first.total_count >= 1_000) {
      const middle = Math.floor((from + to) / 2_000) * 1_000;
      assert(middle > from && middle < to, "publication request history cannot be enumerated completely");
      const combined = [...await history(from, middle), ...await history(middle, to)];
      const unique = new Map();
      for (const run of combined) {
        const earlier = unique.get(run.id);
        if (earlier) assert(earlier.run_number === run.run_number && earlier.display_title === run.display_title && earlier.head_sha === run.head_sha, "publication request history changed during enumeration");
        unique.set(run.id, run);
      }
      assert(unique.size >= first.total_count, "publication request history is incomplete");
      return [...unique.values()];
    }
    const rows = [...first.workflow_runs];
    for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
      const next = await githubJson(path + `&page=${page}`, env, deadline, fetchImpl);
      assert(next.total_count === first.total_count && Array.isArray(next.workflow_runs) && next.workflow_runs.length <= 100, "publication request history changed during enumeration");
      rows.push(...next.workflow_runs);
    }
    assert(rows.length === first.total_count && new Set(rows.map(({ id }) => id)).size === rows.length, "publication request history is incomplete");
    return rows;
  };
  const runs = await history(0, until);
  assert(runs.some((run) => run.id === id), "publication request is not yet present in complete server history");
  const requests = [];
  for (const run of runs) {
    validate(run);
    if (run.run_number > current.run_number || !run.display_title?.startsWith(`publication-v1 ${env.RELEASE_VERSION} `)) continue;
    const match = /^publication-v1 ([0-9A-Za-z][0-9A-Za-z.+-]{0,127}) ([a-f0-9]{64}) ([a-f0-9]{40}) ([1-9]\d*) ([A-Za-z][A-Za-z0-9._-]*) (\S+)$/.exec(run.display_title);
    assert(match, "publication request record is malformed");
    publicationStartedAt(match[6]);
    assert(Math.floor(Date.parse(match[6]) / 1_000) <= Date.parse(run.created_at) / 1_000, "publication request timestamp follows its server dispatch");
    requests.push({ id: run.id, number: run.run_number, candidateSha256: match[2], source: match[3], qualificationRun: positiveId(match[4]), tag: match[5], requestedAt: match[6] });
  }
  requests.sort((a, b) => a.number - b.number);
  const first = requests[0];
  assert(first, "publication has no server-recorded version and original timestamp");
  assert.equal(current.display_title, `publication-v1 ${env.RELEASE_VERSION} ${env.RELEASE_CANDIDATE_SHA256} ${env.RELEASE_SOURCE} ${qualificationRun} ${env.RELEASE_TAG} ${env.RELEASE_REQUESTED_AT}`, "publication inputs differ from their server request record");
  assert.equal(env.RELEASE_REQUESTED_AT, first.requestedAt, "fresh publication dispatch cannot replace the original command timestamp for this version");
  assert(first.candidateSha256 === env.RELEASE_CANDIDATE_SHA256 && first.source === env.RELEASE_SOURCE && first.qualificationRun === qualificationRun && first.tag === env.RELEASE_TAG, "fresh publication dispatch cannot replace the original requested candidate, source, qualification or tag");
  publicationDeadline(first.requestedAt);
  return { v: 1, version: env.RELEASE_VERSION, firstRunId: first.id, requestedAt: first.requestedAt, candidateSha256: first.candidateSha256, source: first.source, qualificationRun, tag: first.tag };
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

export function verifyBuildAttestation({ manifestFile, bundleFile, qualified, env = process.env, exec = execFileSync, deadline }) {
  assert(lstatSync(manifestFile).isFile(), "qualification attestation subject must be a regular file");
  const bundle = lstatSync(bundleFile);
  assert(bundle.isFile() && bundle.size <= 2 * 1024 * 1024, "qualification attestation needs a regular bundle no larger than two MiB");
  let output;
  try {
    output = exec("gh", ["attestation", "verify", manifestFile, "--bundle", bundleFile, "--repo", env.GITHUB_REPOSITORY,
      "--source-digest", qualified.source, "--signer-digest", qualified.source,
      "--signer-workflow", `${env.GITHUB_REPOSITORY}/${workflow}`, "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners", "--format", "json"], {
      env: { ...env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" }, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) { throw new Error(`qualification build attestation verification failed (${error.status ?? error.code ?? "unknown"})`); }
  const verified = JSON.parse(output);
  const invocation = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${qualified.runId}/attempts/${qualified.runAttempt}`;
  assert(Array.isArray(verified) && verified.some((row) => row.verificationResult?.signature?.certificate?.runInvocationURI === invocation), "qualification attestation certificate belongs to another run or attempt");
}

export async function verifyQualification({ root, publisherRoot = CONTROL_ROOT, directory, results, selectionFile, tag, env = process.env, exec = execFileSync, deadline, fetchImpl = fetch }) {
  const publisherSource = publicationContext({ publisherRoot, env, exec, deadline });
  const request = await verifyPublicationRequest({ env, deadline, fetchImpl });
  assert.equal(tag, request.tag, "publication tag differs from its original request record");
  assert(digest.test(env.RELEASE_CANDIDATE_SHA256 ?? ""), "promotion needs the pinned candidate digest");
  const source = exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL" }).trim();
  const sourceTree = exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL" }).trim();
  assert.equal(source, env.RELEASE_SOURCE, "release checkout differs from the requested immutable source");
  const selected = readJson(selectionFile);
  const live = await selectQualification({ runId: env.RELEASE_QUALIFICATION_RUN, env, deadline, fetchImpl });
  assert.deepEqual(selected, live, "qualification identity or immutable artifact selection changed");
  const qualified = readJson(join(directory, "..", "cold-qualified", "qualification.json"));
  assert.equal(qualified.v, 2, "qualification needs a certificate-bound v2 receipt");
  assert.equal(qualified.version, request.version, "qualification belongs to another requested release version");
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
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.source, qualified.source, "candidate rewrote its original build source");
  assert(manifest.packages.every(({ version }) => version === qualified.version), "candidate versions differ from the recorded publication request");
  verifyBuildAttestation({ manifestFile: join(directory, "manifest.json"), bundleFile: join(directory, "qualification.sigstore.json"), qualified, env, exec, deadline });
  assert.equal(qualified.resultCount, coldResultNames().length);
  assert.equal(verifyColdResults(results, qualified.source, hash(bytes)), qualified.resultCount);
  return { ...qualified, request, promotionSource: source, publisherSource, artifacts: live.artifacts };
}

if (isMainEntry(import.meta.url)) {
  const root = resolve(process.env.RELEASE_ROOT ?? CONTROL_ROOT);
  const [operation, first, second, third, fourth] = process.argv.slice(2);
  (async () => {
    if (operation === "record") return recordQualification({ root: CONTROL_ROOT, directory: first, results: second, output: third });
    const deadline = publicationDeadline(process.env.RELEASE_REQUESTED_AT);
    if (operation === "checkout") return checkoutReleaseSource({ deadline });
    if (operation === "select") {
      await verifyPublicationRequest({ deadline });
      const selected = await selectQualification({ runId: process.env.RELEASE_QUALIFICATION_RUN, deadline });
      writeFileSync(first, JSON.stringify(selected, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      appendFileSync(process.env.GITHUB_OUTPUT, `artifact-ids=${selected.artifacts.map(({ id }) => id).join(",")}\n`);
      return;
    }
    if (operation === "verify") return verifyQualification({ root, selectionFile: first, directory: second, results: third, tag: fourth || "latest", deadline });
    throw new Error("usage: release-qualification.mjs record <candidate> <results> <output> | checkout | select <selection> | verify <selection> <candidate> <results> [tag]");
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
