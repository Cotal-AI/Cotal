#!/usr/bin/env node

const API_VERSION = "2022-11-28";

/** @param {unknown} value @param {string} name @returns {string} */
function required(value, name) {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

/** @param {unknown} value @param {string} name @returns {number} */
function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** @param {string[]} argv @returns {Record<string, string>} */
function argsOf(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

/**
 * @typedef {{ kind: "not-cancelled" } | { kind: "superseded", supersedingRunId: number } |
 * { kind: "self-timeout", durationSeconds: number, timeoutSeconds: number } |
 * { kind: "unexplained-cancellation", durationSeconds: number }} LiveConclusion
 * @typedef {{ result: string, repo: string, runId: number, attempt: number, workflow: string,
 * job: string, timeoutSeconds: number, event: string, prNumber: number, headRef: string }} LiveConclusionOptions
 */

/** @param {{ result: string, durationSeconds: number, timeoutSeconds: number, supersedingRunId?: number }} input @returns {LiveConclusion} */
export function classifyLiveConclusion({ result, durationSeconds, timeoutSeconds, supersedingRunId }) {
  if (result !== "cancelled") return { kind: "not-cancelled" };
  if (supersedingRunId !== undefined) return { kind: "superseded", supersedingRunId };
  if (durationSeconds >= timeoutSeconds)
    return { kind: "self-timeout", durationSeconds, timeoutSeconds };
  return { kind: "unexplained-cancellation", durationSeconds };
}

/** @param {{ started_at?: unknown, completed_at?: unknown }} job @returns {number} */
function elapsedSeconds(job) {
  const started = Date.parse(required(job.started_at, "live.started_at"));
  const completed = Date.parse(required(job.completed_at, "live.completed_at"));
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started)
    throw new Error("live job carries invalid start/completion timestamps");
  return Math.round((completed - started) / 1000);
}

/** @param {string} path @param {string} token @param {typeof fetch} fetchImpl @returns {Promise<any>} */
async function githubJson(path, token, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

/** @param {LiveConclusionOptions} opts @param {string} token @param {typeof fetch} fetchImpl @returns {Promise<number | undefined>} */
async function supersedingPullRequestRun(opts, token, fetchImpl) {
  if (opts.event !== "pull_request" || opts.prNumber === 0) return undefined;
  const current = await githubJson(`/repos/${opts.repo}/actions/runs/${opts.runId}`, token, fetchImpl);
  const branch = opts.headRef ? `&branch=${encodeURIComponent(opts.headRef)}` : "";
  const runs = await githubJson(
    `/repos/${opts.repo}/actions/workflows/${encodeURIComponent(opts.workflow)}/runs?event=pull_request&per_page=100${branch}`,
    token,
    fetchImpl,
  );
  const currentCreated = Date.parse(required(current.created_at, "current run created_at"));
  const newer = runs.workflow_runs
    .filter((/** @type {any} */ run) => run.id !== opts.runId && Date.parse(run.created_at) > currentCreated)
    .filter((/** @type {any} */ run) => run.pull_requests?.some((/** @type {any} */ pr) => pr.number === opts.prNumber))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  return newer?.id;
}

/** @param {LiveConclusionOptions} opts @param {string} token @param {typeof fetch} [fetchImpl] @returns {Promise<LiveConclusion>} */
export async function inspectLiveConclusion(opts, token, fetchImpl = fetch) {
  if (opts.result !== "cancelled") return { kind: "not-cancelled" };
  const jobs = await githubJson(
    `/repos/${opts.repo}/actions/runs/${opts.runId}/attempts/${opts.attempt}/jobs?per_page=100`,
    token,
    fetchImpl,
  );
  const matches = jobs.jobs.filter((/** @type {any} */ job) => job.name === opts.job);
  if (matches.length !== 1) throw new Error(`expected exactly one ${JSON.stringify(opts.job)} job in this run attempt, found ${matches.length}`);
  const supersedingRunId = await supersedingPullRequestRun(opts, token, fetchImpl);
  // A PR revision may be superseded while live is still queued, in which case GitHub records no
  // started/completed timestamps. The newer same-PR run is already sufficient evidence; never make
  // an intentionally cancelled revision look broken merely because work had not started yet.
  if (supersedingRunId !== undefined) return { kind: "superseded", supersedingRunId };
  const durationSeconds = elapsedSeconds(matches[0]);
  return classifyLiveConclusion({
    result: opts.result,
    durationSeconds,
    timeoutSeconds: opts.timeoutSeconds,
    supersedingRunId: undefined,
  });
}

/** @param {string} message @returns {string} */
function annotation(message) {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

async function main() {
  const raw = argsOf(process.argv.slice(2));
  const opts = {
    result: required(raw.result, "--result"),
    repo: required(raw.repo, "--repo"),
    runId: positiveInt(raw["run-id"], "--run-id"),
    attempt: positiveInt(raw.attempt, "--attempt"),
    workflow: required(raw.workflow, "--workflow"),
    job: required(raw.job, "--job"),
    timeoutSeconds: positiveInt(raw["timeout-seconds"], "--timeout-seconds"),
    event: required(raw.event, "--event"),
    prNumber: Number(raw["pr-number"] ?? 0),
    headRef: raw["head-ref"] ?? "",
  };
  if (!Number.isSafeInteger(opts.prNumber) || opts.prNumber < 0) throw new Error("--pr-number must be a non-negative integer");
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const verdict = await inspectLiveConclusion(opts, token);
  if (verdict.kind === "not-cancelled") {
    console.log(`live result is ${opts.result}; no cancellation diagnosis needed`);
    return;
  }
  if (verdict.kind === "superseded") {
    console.log(`live was cancelled because PR run ${verdict.supersedingRunId} superseded this revision`);
    return;
  }
  const message = verdict.kind === "self-timeout"
    ? `live hit its own ${verdict.timeoutSeconds}s job deadline after ${verdict.durationSeconds}s; this is a CI failure, not a superseded run`
    : `live was cancelled after ${verdict.durationSeconds}s with no newer run for this PR; the cancellation is unexplained and must not look like an intentional supersession`;
  console.error(`::error title=Live job did not finish::${annotation(message)}`);
  throw new Error(message);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
