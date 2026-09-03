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
 * Run from inside a worktree of the repo. Exits 1 if any pre-existing suite changes shard,
 * and likewise when a NEW entry's comment claims "Appended" while the entry sits before a
 * pre-existing suite: the claim sentence is validated against position instead of trusted (#1011).
 *
 * CONTROLS BUILT IN, because a bare zero is not evidence. All nineteen run on every invocation:
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
 *   - the shard runner must compare execution inputs directly with committed blobs
 *   - replacement refs must not redirect the streamed verifier or its committed input reads
 *   - duplicate step IDs declared after another step key must be refused
 *   - duplicate step IDs declared as the first step key must also be refused
 *   - the complete head workflow must parse under the next shard count and still refuse both duplicates
 *   - a NEW entry claiming "Appended" while inserted mid-file must be named as a violation
 *   - the same claim on a true tail append must report nothing
 *   - "Appended" claims on PRE-EXISTING entries must be ignored (history is not re-graded)
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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSuiteIndices } from "./shard-stability.mjs";

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
// and shard step must also keep the execution shape this parser models, including an
// immutable verifier whose blob hash is pinned here, binds the runner to committed inputs,
// checks the captured CI toolchain, and launches the shard under a clean environment.
// Comments and other jobs are not topology either. Unsupported shapes abort instead of guessing.
const shardCountFromWorkflow = (yml: string, requireCommittedInputs = true, requireToolPrelude = false): number | null => {
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
  const activeStepBlocks = stepBlocks.map((block) =>
    block.filter((line) => !/^\s*(?:#.*)?$/.test(line))
  );
  if (requireToolPrelude) {
    const expectedPrelude = [
      ["      - uses: actions/checkout@v6"],
      [
        "      - uses: pnpm/action-setup@v6.0.8",
        "        with:",
        "          standalone: true",
      ],
      [
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          node-version: 22",
        "          cache: pnpm",
      ],
      [
        "      - name: Capture smoke toolchain",
        "        id: smoke-tools",
        "        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}",
        "        run: |",
        '          node_path="$(command -v node)"',
        '          pnpm_path="$(command -v pnpm)"',
        '          node_target="$(/usr/bin/readlink -f "$node_path")"',
        '          pnpm_target="$(/usr/bin/readlink -f "$pnpm_path")"',
        '          echo "node_path=$node_path" >> "$GITHUB_OUTPUT"',
        '          echo "node_target=$node_target" >> "$GITHUB_OUTPUT"',
        `          echo "node_sha=$(/usr/bin/sha256sum "$node_target" | /usr/bin/cut -d' ' -f1)" >> "$GITHUB_OUTPUT"`,
        '          echo "pnpm_path=$pnpm_path" >> "$GITHUB_OUTPUT"',
        '          echo "pnpm_target=$pnpm_target" >> "$GITHUB_OUTPUT"',
        `          echo "pnpm_sha=$(/usr/bin/sha256sum "$pnpm_target" | /usr/bin/cut -d' ' -f1)" >> "$GITHUB_OUTPUT"`,
      ],
    ];
    if (expectedPrelude.some((expected, index) =>
      activeStepBlocks[index]?.join("\n") !== expected.join("\n")
    )) return null;
    const allowedStepKeys = new Set([
      "name", "uses", "run", "shell", "with", "env", "id", "if",
      "continue-on-error", "timeout-minutes", "working-directory",
    ]);
    const stepEntries: Array<Array<{ key: string; value: string }>> = [];
    for (const block of activeStepBlocks) {
      const keyLines = block.filter((line, index) =>
        index === 0 || /^        \S/.test(line)
      );
      const entries: Array<{ key: string; value: string }> = [];
      for (const line of keyLines) {
        const pattern = line === block[0]
          ? /^      - (["']?)([a-z][a-z0-9-]*)\1:\s*(.*)$/i
          : /^        (["']?)([a-z][a-z0-9-]*)\1:\s*(.*)$/i;
        const match = pattern.exec(line);
        if (!match || !allowedStepKeys.has(match[2])) return null;
        entries.push({ key: match[2], value: match[3] });
      }
      if (new Set(entries.map(({ key }) => key)).size !== entries.length) return null;
      stepEntries.push(entries);
    }
    const idValues = stepEntries.flatMap((entries) =>
      entries.filter(({ key }) => key === "id").map(({ value }) => value)
    );
    const ids = idValues
      .map((value) => /^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*(?:#.*)?$/.exec(value)?.[2] ?? null)
      .filter((id): id is string => id !== null);
    if (ids.length !== idValues.length || new Set(ids).size !== ids.length) return null;
  }
  const guardedShell = "        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}";
  const guardedInvocationPattern = /^        run:\s*\/usr\/bin\/git --no-replace-objects show "\$GITHUB_SHA:bin\/smoke\/verify-shard-inputs\.sh" \| \/usr\/bin\/bash --noprofile --norc -s -- "\$GITHUB_SHA" \$\{\{ matrix\.shard \}\} ([1-9][0-9]*) ci "\$\{\{ steps\.smoke-tools\.outputs\.node_path \}\}" "\$\{\{ steps\.smoke-tools\.outputs\.node_target \}\}" "\$\{\{ steps\.smoke-tools\.outputs\.node_sha \}\}" "\$\{\{ steps\.smoke-tools\.outputs\.pnpm_path \}\}" "\$\{\{ steps\.smoke-tools\.outputs\.pnpm_target \}\}" "\$\{\{ steps\.smoke-tools\.outputs\.pnpm_sha \}\}"\s*(?:#.*)?$/;
  const legacyInvocationPattern = /^        run:\s*node bin\/smoke\/shard\.mjs \$\{\{ matrix\.shard \}\} ([1-9][0-9]*)\s*(?:#.*)?$/;
  const shardSteps = stepBlocks.filter((block) => block.some((line) =>
    guardedInvocationPattern.test(line) || legacyInvocationPattern.test(line)
  ));
  if (shardSteps.length !== 1) return null;
  const activeShardStep = shardSteps[0].filter((line) => !/^\s*(?:#.*)?$/.test(line));
  const guardedInvocations = activeShardStep
    .map((line) => guardedInvocationPattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  const legacyInvocations = activeShardStep
    .map((line) => legacyInvocationPattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  const named = /^      - name:\s*\S/.test(activeShardStep[0]);
  const guarded = activeShardStep.length === 3 && named &&
    activeShardStep[1] === guardedShell && guardedInvocations.length === 1;
  const legacy = activeShardStep.length === 2 && named && legacyInvocations.length === 1;
  if (requireCommittedInputs ? !guarded : !guarded && !legacy) return null;
  const invocation = guarded ? guardedInvocations[0] : legacyInvocations[0];
  const commandCount = Number(invocation[1]);
  return commandCount === indices.length ? commandCount : null;
};

const ciShardCount = (sha: string, requireCommittedInputs: boolean): number | null => {
  try {
    const yml = execFileSync("git", ["--no-replace-objects", "show", `${sha}:.github/workflows/ci.yml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return shardCountFromWorkflow(yml, requireCommittedInputs, requireCommittedInputs);
  } catch {
    return null;
  }
};

const verifierMatches = (sha: string): boolean => {
  try {
    const source = execFileSync("git", ["--no-replace-objects", "show", `${sha}:bin/smoke/verify-shard-inputs.sh`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const actual = createHash("sha256").update(source).digest("hex");
    return actual === "117791a37fdaf0e0bb453546621ae3a2051fc85114ace53c3f28f7384ec5292f";
  } catch {
    return false;
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
if (!verifierMatches(head)) {
  verdict("ABORT", `verifier blob at '${head}' does not match the fail-closed implementation pinned by this detector`, 2);
}
const headCount = countArg !== undefined ? Number(countArg) : declaredHeadCount;
if (!Number.isInteger(headCount) || headCount < 1) {
  verdict("ABORT", `shard count must be a positive integer, got '${countArg}'`, 2);
}
if (headCount !== declaredHeadCount) {
  verdict("ABORT", `shard count ${headCount} disagrees with ci.yml's matrix of ${declaredHeadCount} at '${head}'. A verdict for a topology CI does not run is worse than no verdict.`, 2);
}
console.log(`shard counts ${baseCount} -> ${headCount}, read from ci.yml at ${base.slice(0, 8)} and ${head.slice(0, 8)}`);

const readBlob = (sha: string, path: string): string => {
  // EXIT 2, NOT 1, when the input cannot be read. Exit 1 means "re-shard detected";
  // a bad sha must not be indistinguishable from a real defect, or a CI job wiring
  // this in reports a typo as a production finding. The bogus-sha control once returned
  // exit 1 where the README promised 2.
  try {
    return execFileSync("git", ["--no-replace-objects", "show", `${sha}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    verdict("ABORT", `cannot read ${path} at '${sha}' (bad sha, or not a worktree of this repo)`, 2);
  }
};

const readRaw = (sha: string): string => readBlob(sha, "bin/smoke/ci-suites.txt");

const read = (sha: string): string[] => {
  const raw = readRaw(sha);
  const list = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (list.length === 0) {
    verdict("ABORT", `chain at '${sha}' parsed to 0 suites; refusing to compare an empty chain`, 2);
  }
  return list;
};

const fragmentPaths = (sha: string): string[] => {
  try {
    return execFileSync(
      "git",
      ["--no-replace-objects", "ls-tree", "-r", "--name-only", sha, "--", "bin/smoke/ci-suites.d"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".txt")).sort();
  } catch {
    verdict("ABORT", `cannot enumerate bin/smoke/ci-suites.d at '${sha}'`, 2);
  }
};

const fragments = (sha: string): string[] => fragmentPaths(sha).map((path) => {
  const list = readBlob(sha, path).split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (list.length !== 1)
    verdict("ABORT", `${path} at '${sha}' must contain exactly one suite, got ${list.length}`, 2);
  return list[0];
});

const shardOf = (list: string[], count: number) => {
  const m = new Map<string, number>();
  list.forEach((suite, index) => { if (!m.has(suite)) m.set(suite, index % count); });
  return m;
};

const moved = (a: string[], b: string[], aCount: number, bCount: number): string[] => {
  const sa = shardOf(a, aCount), sb = shardOf(b, bCount);
  return [...sa.keys()].filter((suite) => sb.has(suite) && sa.get(suite) !== sb.get(suite));
};

const fragmentShard = (suite: string, count: number): number =>
  createHash("sha256").update(suite).digest().readUInt32BE(0) % count;

const assignment = (legacy: string[], fragmentSuites: string[], count: number): Map<string, number> => {
  const out = shardOf(legacy, count);
  for (const suite of fragmentSuites) if (!out.has(suite)) out.set(suite, fragmentShard(suite, count));
  return out;
};

const movedRegistry = (
  aLegacy: string[], aFragments: string[], bLegacy: string[], bFragments: string[], aCount: number, bCount: number,
): string[] => {
  const a = assignment(aLegacy, aFragments, aCount), b = assignment(bLegacy, bFragments, bCount);
  return [...a.keys()].filter((suite) => b.has(suite) && a.get(suite) !== b.get(suite));
};

// #1011: every ci-suites.txt entry ends its comment with the same sentence, "Appended;
// shard assignments unchanged." That sentence is both the rule and the claim, and nothing
// checked the claim against the entry's POSITION: a new entry inserted mid-file carried it
// verbatim while re-sharding a third of the file. Validate the sentence instead of trusting
// it. A NEW entry (absent at base) whose comment block claims "Appended" must sit after
// every pre-existing suite. Claims on pre-existing entries are history and are not re-graded.
const appendedClaimViolations = (baseList: string[], headRaw: string): string[] => {
  const baseSet = new Set(baseList);
  const entries: Array<{ name: string; line: number; comment: string }> = [];
  let pending: string[] = [];
  headRaw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) { pending.push(trimmed); return; }
    if (trimmed.length === 0) { pending = []; return; }
    entries.push({ name: trimmed, line: index + 1, comment: pending.join("\n") });
    pending = [];
  });
  let lastPre = -1;
  entries.forEach((entry, position) => { if (baseSet.has(entry.name)) lastPre = position; });
  return entries
    .filter((entry, position) =>
      !baseSet.has(entry.name) && position < lastPre && /\bAppended\b/i.test(entry.comment))
    .map((entry) => `${entry.name} (line ${entry.line})`);
};

const replaceRefRuntimeControl = (): boolean => {
  const root = mkdtempSync(join(tmpdir(), "shard-replace-control-"));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("COTAL_")) delete env[name];
  }
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "GIT_NO_REPLACE_OBJECTS"]) {
    delete env[name];
  }
  try {
    mkdirSync(join(root, "bin/smoke/ci-suites.d"), { recursive: true });
    const verifier = execFileSync(
      "git",
      ["--no-replace-objects", "show", `${head}:bin/smoke/verify-shard-inputs.sh`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const inputs = new Map([
      ["bin/smoke/ci-suites.txt", "smoke:first\nsmoke:second\n"],
      ["bin/smoke/ci-suites.d/control.txt", "smoke:fragment\n"],
      ["bin/smoke/ci-suites.mjs", "export {};\n"],
      ["bin/smoke/shard.mjs", "export {};\n"],
      ["bin/smoke/reap-smoke-brokers.mjs", "export {};\n"],
      ["package.json", "{}\n"],
      ["pnpm-workspace.yaml", "packages: []\n"],
    ]);
    for (const [path, source] of inputs) {
      writeFileSync(join(root, path), source);
    }
    writeFileSync(join(root, "bin/smoke/verify-shard-inputs.sh"), verifier);
    const git = (args: string[]): string => execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    git(["init", "-q"]);
    git(["config", "user.name", "Shard control"]);
    git(["config", "user.email", "shard-control@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-qm", "control: original tree"]);
    const original = git(["rev-parse", "HEAD"]);

    writeFileSync(join(root, "bin/smoke/ci-suites.txt"), "smoke:first\n");
    writeFileSync(join(root, "bin/smoke/ci-suites.d/control.txt"), "smoke:changed-fragment\n");
    writeFileSync(
      join(root, "bin/smoke/verify-shard-inputs.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    git(["add", "bin/smoke/ci-suites.txt", "bin/smoke/ci-suites.d/control.txt", "bin/smoke/verify-shard-inputs.sh"]);
    const tree = git(["write-tree"]);
    const replacement = git(["commit-tree", tree, "-p", original, "-m", "control: replacement tree"]);
    git(["replace", original, replacement]);
    if (
      git(["show", `${original}:bin/smoke/ci-suites.txt`]) !== "smoke:first" ||
      git(["--no-replace-objects", "show", `${original}:bin/smoke/ci-suites.txt`]) !==
        "smoke:first\nsmoke:second"
    ) return false;

    const result = spawnSync(
      "/bin/bash",
      [
        "-o", "pipefail", "-c",
        '/usr/bin/git --no-replace-objects show "$1:bin/smoke/verify-shard-inputs.sh" | /bin/bash --noprofile --norc -s -- "$1"',
        "shard-replace-control",
        original,
      ],
      { cwd: root, env, encoding: "utf8" },
    );
    return result.status === 2 && /tracked shard (?:input|fragment inventory) changed after checkout/.test(result.stderr);
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const A = read(base), B = read(head);
const AF = fragments(base), BF = fragments(head);
const changed = movedRegistry(A, AF, B, BF, baseCount, headCount);
const indices = changedSuiteIndices(A, B) as { changed: string[]; examined: number };

// --- controls, printed before the verdict ---
const forced = moved(A, [...A.slice(0, 10), "smoke:FORCED-CONTROL", ...A.slice(10)], baseCount, baseCount);
const identity = moved(A, A, baseCount, baseCount);
const topologyProbe = Array.from({ length: 20 }, (_, index) => `smoke:TOPOLOGY-CONTROL-${index}`);
const indexRotation = changedSuiteIndices(
  topologyProbe,
  [...topologyProbe.slice(4), ...topologyProbe.slice(0, 4)],
) as { changed: string[]; examined: number };
const indexIdentity = changedSuiteIndices(topologyProbe, topologyProbe) as { changed: string[]; examined: number };
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
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 4 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
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
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 5 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
`);
const duplicateMatrixCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 2]
    steps:
      - name: Run shard
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 4 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
`);
const emptyMatrixCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [ ]
    steps:
      - name: Run shard
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 1 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
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
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 4 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
`);
const conditionalJobCount = shardCountFromWorkflow(`jobs:
  smoke:
    if: \${{ false }}
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 4 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
`);
const conditionalStepCount = shardCountFromWorkflow(`jobs:
  smoke:
    strategy:
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run shard
        if: \${{ false }}
        shell: /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS /usr/bin/bash --noprofile --norc -e -o pipefail {0}
        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- "$GITHUB_SHA" \${{ matrix.shard }} 4 ci "\${{ steps.smoke-tools.outputs.node_path }}" "\${{ steps.smoke-tools.outputs.node_target }}" "\${{ steps.smoke-tools.outputs.node_sha }}" "\${{ steps.smoke-tools.outputs.pnpm_path }}" "\${{ steps.smoke-tools.outputs.pnpm_target }}" "\${{ steps.smoke-tools.outputs.pnpm_sha }}"
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
const guardedInvocationPrefix = '        run: /usr/bin/git --no-replace-objects show "$GITHUB_SHA:bin/smoke/verify-shard-inputs.sh" | /usr/bin/bash --noprofile --norc -s -- ';
const duplicateMappedStep = `      - name: Re-capture smoke toolchain
        id: smoke-tools
        run: echo "pnpm_sha=forged" >> "$GITHUB_OUTPUT"
`;
const duplicateLeadingStep = `      - id: smoke-tools
        name: Re-capture smoke toolchain
        run: echo "pnpm_sha=forged" >> "$GITHUB_OUTPUT"
`;
const headWorkflowForControls = (() => {
  try {
    return execFileSync("git", ["--no-replace-objects", "show", `${head}:.github/workflows/ci.yml`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
})();
const smokeJobBounds = (lines: string[]): [number, number] | null => {
  const start = lines.findIndex((line) => /^  smoke:\s*(?:#.*)?$/.test(line));
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && /^  \S/.test(line));
  return [start, next < 0 ? lines.length : next];
};
const guardedInvocationIndex = (lines: string[]): number | null => {
  const bounds = smokeJobBounds(lines);
  if (!bounds) return null;
  const [start, end] = bounds;
  const invocations = lines
    .map((line, index) => index > start && index < end && line.startsWith(guardedInvocationPrefix) ? index : -1)
    .filter((index) => index >= 0);
  return invocations.length === 1 ? invocations[0] : null;
};
const gradeDuplicateStepId = (yml: string | null, duplicate: string) => {
  if (yml === null || !duplicate.endsWith("\n")) return { injected: false, count: null };
  const lines = yml.split("\n");
  const invocation = guardedInvocationIndex(lines);
  if (invocation === null) return { injected: false, count: null };
  let stepStart = invocation;
  while (stepStart >= 0 && !/^      - \S/.test(lines[stepStart])) stepStart -= 1;
  if (stepStart < 0) return { injected: false, count: null };
  lines.splice(stepStart, 0, ...duplicate.slice(0, -1).split("\n"));
  return {
    injected: true,
    count: shardCountFromWorkflow(lines.join("\n"), true, true),
  };
};
const bumpWorkflowTopology = (yml: string, count: number): string | null => {
  const lines = yml.split("\n");
  const bounds = smokeJobBounds(lines);
  if (!bounds) return null;
  const [start, end] = bounds;
  const matrixRows: Array<{ index: number; match: RegExpExecArray }> = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = /^(        shard:\s*\[)([0-9,\s]+)(\]\s*(?:#.*)?)$/.exec(lines[index]);
    if (!match) continue;
    const indices = match[2].split(",").map((value) => value.trim()).map(Number);
    if (indices.length === count && indices.every((value, position) => value === position)) {
      matrixRows.push({ index, match });
    }
  }
  if (matrixRows.length !== 1) return null;
  const nextCount = count + 1;
  const row = matrixRows[0];
  const nextIndices = Array.from({ length: nextCount }, (_, index) => index).join(", ");
  lines[row.index] = `${row.match[1]}${nextIndices}${row.match[3]}`;
  const invocation = guardedInvocationIndex(lines);
  if (invocation === null) return null;
  const countToken = ' ${{ matrix.shard }} ' + count + ' ci ';
  if (lines[invocation].split(countToken).length !== 2) return null;
  lines[invocation] = lines[invocation].replace(
    countToken,
    ' ${{ matrix.shard }} ' + nextCount + ' ci ',
  );
  const oldLabel = '(shard ${{ matrix.shard }}/' + count + ')';
  const nextLabel = '(shard ${{ matrix.shard }}/' + nextCount + ')';
  for (let index = start + 1; index < end; index += 1) {
    lines[index] = lines[index].replace(oldLabel, nextLabel);
  }
  return lines.join("\n");
};
const duplicateMappedIdControl = gradeDuplicateStepId(headWorkflowForControls, duplicateMappedStep);
const duplicateLeadingIdControl = gradeDuplicateStepId(headWorkflowForControls, duplicateLeadingStep);
const completeTopologyWorkflow = headWorkflowForControls === null
  ? null
  : bumpWorkflowTopology(headWorkflowForControls, headCount);
const completeTopologyCount = completeTopologyWorkflow === null
  ? null
  : shardCountFromWorkflow(completeTopologyWorkflow, true, true);
const completeTopologyMappedId = gradeDuplicateStepId(completeTopologyWorkflow, duplicateMappedStep);
const completeTopologyLeadingId = gradeDuplicateStepId(completeTopologyWorkflow, duplicateLeadingStep);
const completeTopologyDuplicatesRefused =
  completeTopologyMappedId.injected && completeTopologyMappedId.count === null &&
  completeTopologyLeadingId.injected && completeTopologyLeadingId.count === null;
const replaceRefRefused = replaceRefRuntimeControl();
const claimControlBase = ["smoke:a", "smoke:b", "smoke:c"];
const claimSentence = "# Appended; shard assignments unchanged.";
const claimMidFile = appendedClaimViolations(claimControlBase,
  `smoke:a\n\n${claimSentence}\nsmoke:NEW-CONTROL\n\nsmoke:b\nsmoke:c\n`);
const claimTail = appendedClaimViolations(claimControlBase,
  `smoke:a\nsmoke:b\nsmoke:c\n\n${claimSentence}\nsmoke:NEW-CONTROL\n`);
const claimHistorical = appendedClaimViolations(claimControlBase,
  `${claimSentence}\nsmoke:a\n${claimSentence}\nsmoke:b\n${claimSentence}\nsmoke:c\n`);
console.log(`CONTROL forced mid-file insert -> ${forced.length} moved  (must be > 0)`);
console.log(`CONTROL identity               -> ${identity.length} moved  (must be 0)`);
console.log(`CONTROL same-shard reindex     -> ${indexRotation.changed.length} of ${indexRotation.examined} examined  (must be 20 of 20)`);
console.log(`CONTROL index identity         -> ${indexIdentity.changed.length} of ${indexIdentity.examined} examined  (must be 0 of 20)`);
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
console.log(`CONTROL Git replacement ref     -> ${replaceRefRefused ? "refused" : "accepted"}       (must be refused)`);
console.log(`CONTROL duplicate mapped step id -> ${duplicateMappedIdControl.injected ? duplicateMappedIdControl.count ?? "refused" : "unreadable"}       (must be refused)`);
console.log(`CONTROL duplicate leading step id -> ${duplicateLeadingIdControl.injected ? duplicateLeadingIdControl.count ?? "refused" : "unreadable"}       (must be refused)`);
console.log(`CONTROL complete workflow ${headCount} -> ${headCount + 1} -> ${completeTopologyCount ?? "unreadable"} shards, duplicate ids ${completeTopologyDuplicatesRefused ? "refused" : "accepted"}       (must be ${headCount + 1}, refused)`);
console.log(`CONTROL mid-file "Appended" claim -> ${claimMidFile.length} named  (must be 1)`);
console.log(`CONTROL tail "Appended" claim     -> ${claimTail.length} named  (must be 0)`);
console.log(`CONTROL historical claims         -> ${claimHistorical.length} named  (must be 0)`);
if (
  forced.length === 0 || identity.length !== 0 ||
  indexRotation.changed.length !== 20 || indexRotation.examined !== 20 ||
  indexIdentity.changed.length !== 0 || indexIdentity.examined !== 20 || countIncrease.length !== 16 ||
  countDecrease.length !== 16 || commentShadowCount !== 4 ||
  commandMismatchCount !== null || duplicateMatrixCount !== null || emptyMatrixCount !== null || excludedMatrixCount !== null ||
  conditionalJobCount !== null || conditionalStepCount !== null || unguardedRunnerCount !== null || !replaceRefRefused ||
  !duplicateMappedIdControl.injected || duplicateMappedIdControl.count !== null ||
  !duplicateLeadingIdControl.injected || duplicateLeadingIdControl.count !== null ||
  completeTopologyCount !== headCount + 1 || !completeTopologyDuplicatesRefused ||
  claimMidFile.length !== 1 || claimTail.length !== 0 || claimHistorical.length !== 0
) {
  verdict("ABORT", "controls failed, this run cannot be trusted", 2);
}

const allA = [...A, ...AF], allB = [...B, ...BF];
const added = allB.filter((suite) => !allA.includes(suite));
const removed = allA.filter((suite) => !allB.includes(suite));
const claimViolations = appendedClaimViolations(A, readRaw(head));
console.log(`\n${base.slice(0, 8)} -> ${head.slice(0, 8)}  @${baseCount}->${headCount} shards`);
console.log(`  suites: ${allA.length} -> ${allB.length} · added ${added.length} · removed ${removed.length}`);
console.log(`  frozen legacy suites CHANGING INDEX: ${indices.changed.length} of ${indices.examined} examined`);
if (indices.changed.length > 0) console.log(`  first few reindexed: ${indices.changed.slice(0, 5).join(", ")}`);
console.log(`  pre-existing suites CHANGING SHARD: ${changed.length} of ${allA.length}`);
if (changed.length > 0) {
  console.log(`  first few: ${changed.slice(0, 5).join(", ")}`);
}
if (claimViolations.length > 0) {
  console.log(`  NEW entries claiming "Appended" while mid-file: ${claimViolations.join(", ")}`);
}
if (indices.changed.length > 0 || removed.length > 0 || changed.length > 0 || claimViolations.length > 0) {
  const remedy = baseCount === headCount
    ? "Keep ci-suites.txt frozen; add new suites as one-file fragments under ci-suites.d."
    : `The shard matrix changed ${baseCount} -> ${headCount}; review every reassignment as deliberate.`;
  const claimNote = claimViolations.length > 0
    ? ` FALSE "Appended" CLAIM on ${claimViolations.join(", ")}: the sentence is validated against position (#1011); a new entry carrying it must sit after every pre-existing suite.`
    : "";
  const headline = indices.changed.length > 0 || removed.length > 0 || changed.length > 0
    ? `RE-SHARD DETECTED. ${remedy}`
    : "NO pre-existing suite moved, but the registry lies about how it grew.";
  verdict("RESHARD", `${headline}${claimNote}`, 1);
}
verdict("STABLE", "STABLE - every frozen legacy suite keeps its index, every pre-existing suite keeps its runner, no false append claims.", 0);
