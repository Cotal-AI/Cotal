/**
 * shard-stability.check.ts: does a commit RE-SHARD the smoke chain?
 *
 * WHY THIS EXISTS. `bin/smoke/ci-suites.txt` is consumed by `shard.mjs` as round-robin
 * `index % count`. Inserting a line mid-file therefore moves every suite below it to a
 * DIFFERENT RUNNER, while membership, count, and duplicate checks all stay green.
 *
 * `smoke:gate-inventory` checks membership, duplicates, and non-emptiness. It does NOT
 * check ORDER. That is the invariant that actually failed in production:
 *
 *   7837b64c -> d1aeafc3   a two-line PURE REORDER (387 -> 387, added 0, removed 0)
 *   moved 263 of 387 suites to a different shard at the 4-shard config CI runs.
 *
 * The observed consequence: the same two deterministic failures appeared on different
 * shards across runs, and a reviewer was one step from filing CI non-determinism against
 * a system behaving perfectly. There was no flakiness. The registry was edited between
 * observations.
 *
 *   smoke:artifact-store     idx 234 -> 232   shard 2 -> 0   (matched live CI)
 *   smoke:cross-path-dedup   idx 179 -> 177   shard 3 -> 1   (matched live CI)
 *
 * NOTE THE EVIDENCE CLASS: this static computation predicted a remote runner's observed
 * behaviour on two independent data points. The computation and runner logs are independent
 * evidence.
 *
 * USAGE:  pnpm check:shard-stability <base-sha> <head-sha>   (shard counts read from ci.yml)
 *   Both commits supply their own shard count. A third argument is accepted only so a
 *   disagreement with the head topology can be caught and refused; DO NOT PASS IT from a
 *   gate. Hardcoding it at the call site restores the coincidence-coupling this tool exists
 *   to remove and permanently silences the mismatch abort below.
 * Run from inside a worktree of the repo. Exits 1 if any pre-existing suite changes shard.
 *
 * CONTROLS BUILT IN, because a bare zero is not evidence. All twelve run on every invocation:
 *   - a forced mid-file insert must report non-zero (the instrument responds at all)
 *   - identity (base vs base) must report 0
 *   - an unchanged 20-item registry under 4 -> 5 shards must move 16 items
 *   - the reverse 5 -> 4 topology change must also move 16 items
 *   - a comment containing a fake shard row must not shadow the active matrix
 *   - the matrix and runner command must not disagree on the count
 *   - matrix indices must not repeat or leave gaps
 *   - an empty matrix must not masquerade as shard zero
 *   - extra matrix content must not remove or duplicate jobs
 *   - the smoke job must not carry an execution condition
 *   - the shard step must not carry an execution condition
 *   - the shard runner must refuse tracked files changed after checkout
 * Any failed control ABORTS with exit 2 rather than emitting a verdict.
 *
 * A third line once sat here claiming "the known production re-shard 7837b64c->d1aeafc3
 * reports 263 when both shas exist". THAT CONTROL DOES NOT EXIST IN THIS CODE. It was a
 * true fact about the repo listed under CONTROLS BUILT IN, where a reader takes it as
 * something the program enforces. It was removed before landing. This is the same class as
 * the exit-2 a previous README promised and the code never emitted, and as
 * `dist-freshness` naming a guarantee its mtime comparison cannot provide. Removed rather
 * than implemented: a control that only applies when two specific shas are present is
 * worse than none, because it reads as coverage on every other run.
 */
import { execFileSync } from "node:child_process";

// FIRST LINE OF OUTPUT, BEFORE ANY WORK: a gate can grep for this to prove the detector
// actually ran. `npx tsx <missing-file>` exits 1, which is indistinguishable from
// RE-SHARD DETECTED, so a typo'd script path would otherwise report a defect that does
// not exist. An exit code is not an observation of what a program decided.
//
// THE BANNER ALONE IS NOT ENOUGH. MUTANT D crashes after startup. A git failure,
// bad worktree, or OOM can do the same: print the banner, exit 1, and look like a real
// finding on both signals. The banner proves the process LAUNCHED, not that it REACHED A
// DECISION. Every exit path below therefore goes through `verdict()`, which prints a
// TERMINAL marker on the decision path itself:
//
//   gate on:  banner present  AND  one and only one `shard-stability: <TOKEN>` line
//
// Either alone is fakeable by a failure mode CI will actually produce.
console.log("shard-stability.check v1 starting");

/**
 * The only way out. Prints a terminal marker so a crash cannot impersonate a decision.
 *
 * THE TOKEN CARRIES ITS OWN EXIT CODE. THE CODE, NOT THE ORDERING, IS THE DEFENCE.
 * MUTANT E threw between the token and the exit and produced `token=STABLE=0` with exit 1.
 * Printing the message first removed one window; `console.log(token)` and
 * `process.exit(code)` are still two statements, so a window remains and MUTANT E2 still
 * forges a contradiction. An earlier version of this comment claimed "nothing can run
 * after the token except the exit itself"; that was intent, not an enforced property.
 *
 * What actually holds: the code travels INSIDE the claim, so a forged or truncated run is
 * DETECTABLE by comparing one string against `$?`. It is not detected unless the caller
 * compares them; see MUTANT F in the README, where a swallowed exit code ships a
 * 263-suite re-shard past any gate reading only `$?`. Embedding makes the comparison
 * cheap; it does not perform it. THE GATE MUST STILL CHECK AGREEMENT.
 */
const verdict: (
  token: "RESHARD" | "STABLE" | "ABORT",
  message: string,
  code: 0 | 1 | 2,
) => never = (token, message, code) => {
  (code === 0 ? console.log : console.error)(message);
  console.log(`shard-stability: ${token}=${code}`);
  process.exit(code);
};

const [, , base, head, countArg] = process.argv;
if (!base || !head) {
  verdict("ABORT", "usage: check:shard-stability <base-sha> <head-sha>", 2);
}
// BOTH SHARD TOPOLOGIES COME FROM the smoke job in ci.yml.
// A count change is itself a runner reassignment: comparing both registries under the
// head count hides every move. The matrix and the shard runner's modulo count are two
// independent facts, so both must describe the complete index set 0..N-1. The smoke job
// and shard step must also keep the execution shape this parser models, including a
// clean-tree guard that binds the runner to the committed inputs graded here. Comments and
// other jobs are not topology either. Any unsupported shape aborts instead of guessing.
const shardCountFromWorkflow = (yml: string, requireCommittedInputs = true): number | null => {
  const lines = yml.split("\n");
  const smokeStart = lines.findIndex((line) => /^  smoke:\s*(?:#.*)?$/.test(line));
  if (smokeStart < 0) return null;
  const smokeEnd = lines.findIndex((line, index) => index > smokeStart && /^  \S/.test(line));
  const smoke = lines.slice(smokeStart + 1, smokeEnd < 0 ? undefined : smokeEnd);
  const jobLines = smoke.filter((line) => /^    \S/.test(line) && !/^    #/.test(line));
  const jobKeys = jobLines
    .map((line) => /^    ([a-z][a-z0-9-]*):/i.exec(line)?.[1] ?? null)
    .filter((key): key is string => key !== null);
  const allowedJobKeys = new Set(["name", "timeout-minutes", "runs-on", "strategy", "steps"]);
  if (
    jobKeys.length !== jobLines.length ||
    jobKeys.some((key) => !allowedJobKeys.has(key)) ||
    new Set(jobKeys).size !== jobKeys.length
  ) return null;

  const strategyStart = smoke.findIndex((line) => /^    strategy:\s*(?:#.*)?$/.test(line));
  if (strategyStart < 0) return null;
  const strategyEnd = smoke.findIndex((line, index) => index > strategyStart && /^    \S/.test(line));
  const strategy = smoke.slice(strategyStart + 1, strategyEnd < 0 ? undefined : strategyEnd);
  const strategyLines = strategy.filter((line) => /^      \S/.test(line) && !/^      #/.test(line));
  const strategyKeys = strategyLines
    .map((line) => /^      ([a-z][a-z0-9-]*):/i.exec(line)?.[1] ?? null)
    .filter((key): key is string => key !== null);
  const allowedStrategyKeys = new Set(["fail-fast", "matrix"]);
  if (
    strategyKeys.length !== strategyLines.length ||
    strategyKeys.some((key) => !allowedStrategyKeys.has(key)) ||
    new Set(strategyKeys).size !== strategyKeys.length
  ) return null;

  const matrixStart = strategy.findIndex((line) => /^      matrix:\s*(?:#.*)?$/.test(line));
  if (matrixStart < 0) return null;
  const matrixEnd = strategy.findIndex((line, index) => index > matrixStart && /^      \S/.test(line));
  const matrix = strategy.slice(matrixStart + 1, matrixEnd < 0 ? undefined : matrixEnd);
  const activeMatrix = matrix.filter((line) => !/^\s*(?:#.*)?$/.test(line));
  if (activeMatrix.length !== 1) return null;
  const row = /^        shard:\s*\[([0-9,\s]+)\]\s*(?:#.*)?$/.exec(activeMatrix[0]);
  if (!row) return null;
  const tokens = row[1].split(",").map((value) => value.trim());
  if (tokens.length === 0 || tokens.some((value) => !/^(?:0|[1-9][0-9]*)$/.test(value))) {
    return null;
  }
  const indices = tokens.map(Number);
  if (indices.some((value, index) => value !== index)) return null;

  const stepsStart = smoke.findIndex((line) => /^    steps:\s*(?:#.*)?$/.test(line));
  if (stepsStart < 0) return null;
  const stepsEnd = smoke.findIndex((line, index) => index > stepsStart && /^    \S/.test(line));
  const steps = smoke.slice(stepsStart + 1, stepsEnd < 0 ? undefined : stepsEnd);
  const stepStarts = steps
    .map((line, index) => /^      - \S/.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (stepStarts.length === 0) return null;
  if (steps.slice(0, stepStarts[0]).some((line) => !/^\s*(?:#.*)?$/.test(line))) return null;
  const stepBlocks = stepStarts.map((start, index) =>
    steps.slice(start, stepStarts[index + 1] ?? steps.length)
  );
  const guardedInvocationPattern = /^        run:\s*git diff --exit-code "\$GITHUB_SHA" -- \. && node bin\/smoke\/shard\.mjs \$\{\{ matrix\.shard \}\} ([1-9][0-9]*)\s*(?:#.*)?$/;
  const legacyInvocationPattern = /^        run:\s*node bin\/smoke\/shard\.mjs \$\{\{ matrix\.shard \}\} ([1-9][0-9]*)\s*(?:#.*)?$/;
  const invocationPatterns = requireCommittedInputs
    ? [guardedInvocationPattern]
    : [guardedInvocationPattern, legacyInvocationPattern];
  const invocationOf = (line: string): RegExpExecArray | null =>
    invocationPatterns.map((pattern) => pattern.exec(line)).find((match) => match !== null) ?? null;
  const shardSteps = stepBlocks.filter((block) => block.some((line) => invocationOf(line) !== null));
  if (shardSteps.length !== 1) return null;
  const activeShardStep = shardSteps[0].filter((line) => !/^\s*(?:#.*)?$/.test(line));
  const invocations = activeShardStep
    .map(invocationOf)
    .filter((match): match is RegExpExecArray => match !== null);
  if (
    activeShardStep.length !== 2 ||
    !/^      - name:\s*\S/.test(activeShardStep[0]) ||
    invocations.length !== 1
  ) return null;
  const commandCount = Number(invocations[0][1]);
  return commandCount === indices.length ? commandCount : null;
};

const ciShardCount = (sha: string, requireCommittedInputs: boolean): number | null => {
  try {
    const yml = execFileSync("git", ["show", `${sha}:.github/workflows/ci.yml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return shardCountFromWorkflow(yml, requireCommittedInputs);
  } catch {
    return null;
  }
};

const baseCount = ciShardCount(base, false);
const declaredHeadCount = ciShardCount(head, true);
if (baseCount === null) {
  verdict("ABORT", `cannot read a complete smoke shard topology from .github/workflows/ci.yml at '${base}'`, 2);
}
if (declaredHeadCount === null) {
  verdict("ABORT", `cannot read a complete smoke shard topology from .github/workflows/ci.yml at '${head}'`, 2);
}
const headCount = countArg !== undefined ? Number(countArg) : declaredHeadCount;
if (!Number.isInteger(headCount) || headCount < 1) {
  verdict("ABORT", `shard count must be a positive integer, got '${countArg}'`, 2);
}
if (headCount !== declaredHeadCount) {
  verdict("ABORT", `shard count ${headCount} disagrees with ci.yml's matrix of ${declaredHeadCount} at '${head}'. A verdict for a topology CI does not run is worse than no verdict.`, 2);
}
console.log(`shard counts ${baseCount} -> ${headCount}, read from ci.yml at ${base.slice(0, 8)} and ${head.slice(0, 8)}`);

const read = (sha: string): string[] => {
  // EXIT 2, NOT 1, when the input cannot be read. Exit 1 means "re-shard detected";
  // a bad sha must not be indistinguishable from a real defect, or a CI job wiring
  // this in reports a typo as a production finding. The bogus-sha control once returned
  // exit 1 where the README promised 2.
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${sha}:bin/smoke/ci-suites.txt`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    verdict("ABORT", `cannot read bin/smoke/ci-suites.txt at '${sha}' (bad sha, or not a worktree of this repo)`, 2);
  }
  const list = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (list.length === 0) {
    verdict("ABORT", `chain at '${sha}' parsed to 0 suites; refusing to compare an empty chain`, 2);
  }
  return list;
};

const shardOf = (list: string[], count: number) => {
  const m = new Map<string, number>();
  list.forEach((suite, index) => { if (!m.has(suite)) m.set(suite, index % count); });
  return m;
};

const moved = (a: string[], b: string[], aCount: number, bCount: number): string[] => {
  const sa = shardOf(a, aCount), sb = shardOf(b, bCount);
  return [...sa.keys()].filter((suite) => sb.has(suite) && sa.get(suite) !== sb.get(suite));
};

const A = read(base), B = read(head);
const changed = moved(A, B, baseCount, headCount);

// --- controls, printed before the verdict ---
const forced = moved(A, [...A.slice(0, 10), "smoke:FORCED-CONTROL", ...A.slice(10)], baseCount, baseCount);
const identity = moved(A, A, baseCount, baseCount);
const topologyProbe = Array.from({ length: 20 }, (_, index) => `smoke:TOPOLOGY-CONTROL-${index}`);
const countIncrease = moved(topologyProbe, topologyProbe, 4, 5);
const countDecrease = moved(topologyProbe, topologyProbe, 5, 4);
const commentShadowCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        # historical note: shard: [0, 1]
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 4
  other:
    runs-on: ubuntu-latest
`);
const commandMismatchCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 5
`);
const duplicateMatrixCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 2]
    steps:
      - name: Run shard
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 4
`);
const emptyMatrixCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [ ]
    steps:
      - name: Run shard
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 1
`);
const excludedMatrixCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
        exclude:
          - shard: 3
    steps:
      - name: Run shard
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 4
`);
const conditionalJobCount = shardCountFromWorkflow(`jobs:
  smoke:
    if: \${{ false }}
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 4
`);
const conditionalStepCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        if: \${{ false }}
        run: git diff --exit-code "$GITHUB_SHA" -- . && node bin/smoke/shard.mjs \${{ matrix.shard }} 4
`);
const unguardedRunnerCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        run: node bin/smoke/shard.mjs \${{ matrix.shard }} 4
`);
console.log(`CONTROL forced mid-file insert -> ${forced.length} moved  (must be > 0)`);
console.log(`CONTROL identity               -> ${identity.length} moved  (must be 0)`);
console.log(`CONTROL shard count 4 -> 5     -> ${countIncrease.length} moved  (must be 16)`);
console.log(`CONTROL shard count 5 -> 4     -> ${countDecrease.length} moved  (must be 16)`);
console.log(`CONTROL matrix comment shadow  -> ${commentShadowCount ?? "unreadable"} shards (must be 4)`);
console.log(`CONTROL command count mismatch -> ${commandMismatchCount ?? "refused"}       (must be refused)`);
console.log(`CONTROL duplicate matrix index -> ${duplicateMatrixCount ?? "refused"}       (must be refused)`);
console.log(`CONTROL empty matrix           -> ${emptyMatrixCount ?? "refused"}       (must be refused)`);
console.log(`CONTROL excluded matrix shard  -> ${excludedMatrixCount ?? "refused"}       (must be refused)`);
console.log(`CONTROL conditional smoke job  -> ${conditionalJobCount ?? "refused"}       (must be refused)`);
console.log(`CONTROL conditional shard step -> ${conditionalStepCount ?? "refused"}       (must be refused)`);
console.log(`CONTROL unguarded shard runner  -> ${unguardedRunnerCount ?? "refused"}       (must be refused)`);
if (
  forced.length === 0 || identity.length !== 0 || countIncrease.length !== 16 ||
  countDecrease.length !== 16 || commentShadowCount !== 4 ||
  commandMismatchCount !== null || duplicateMatrixCount !== null || emptyMatrixCount !== null || excludedMatrixCount !== null ||
  conditionalJobCount !== null || conditionalStepCount !== null || unguardedRunnerCount !== null
) {
  verdict("ABORT", "controls failed, this run cannot be trusted", 2);
}

const added = B.filter((suite) => !A.includes(suite));
const removed = A.filter((suite) => !B.includes(suite));
console.log(`\n${base.slice(0, 8)} -> ${head.slice(0, 8)}  @${baseCount}->${headCount} shards`);
console.log(`  suites: ${A.length} -> ${B.length} · added ${added.length} · removed ${removed.length}`);
console.log(`  pre-existing suites CHANGING SHARD: ${changed.length} of ${A.length}`);
if (changed.length > 0) {
  console.log(`  first few: ${changed.slice(0, 5).join(", ")}`);
  const remedy = baseCount === headCount
    ? "Append new suites at the END of ci-suites.txt."
    : `The shard matrix changed ${baseCount} -> ${headCount}; review every reassignment as deliberate.`;
  verdict("RESHARD", `RE-SHARD DETECTED. ${remedy}`, 1);
}
verdict("STABLE", "STABLE - no pre-existing suite changes runner.", 0);
