/**
 * The release workflow must gate the GitHub Release on a full-closure verification of every package
 * in the lockstep group, not on a single `npm view` of one package (#1286). And the closure verifier
 * must read the response body on a 200, not just the status (#1257).
 *
 * This smoke has two sections:
 *
 * A. Workflow shape — parses `.github/workflows/changesets.yml` and asserts that the Release step
 *    depends on a prior closure-gate step, anchored on step ids. A positive-control fixture with
 *    the gate removed must fail the same assertion, so the check is shown to discriminate. The
 *    rc-branch cells grade each branch body by the status bash gives it, not by its text (#1518).
 *
 * A2. The step end to end — runs the closure-gate step's own script under `bash -e` with `node`
 *    stubbed to each exit code the verifier documents, and asserts the status the step leaves, the
 *    `closure_ok` it publishes, and that the two quiet-skip arms end the step themselves. Grading
 *    arms in isolation cannot see a `trap` above the chain or a line below the `fi`, and either one
 *    turns a no-publish push red with every arm still reading as correct (#1518).
 *
 * B. Fake-registry gate — starts a local HTTP server returning controlled responses and runs the
 *    closure verifier against it. Four states: all present passes; one missing reds; one 200 with
 *    a wrong-version body reds; one 200 with an error body reds.
 *
 * Run: pnpm smoke:publish-closure-gate
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/publish-closure-gate.json
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  verifyClosure,
  DEFAULTS,
} from "../../scripts/verify-publish-closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0, failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 FAIL: ${name}`, detail ?? ""); }
}

// ================================================================ A. Workflow shape
const workflowText = readFileSync(join(ROOT, ".github/workflows/changesets.yml"), "utf8");
const workflow = parseYaml(workflowText);

// Find the version job (the one with the publish and release steps)
const versionJob = workflow?.jobs?.version;
check("the changesets workflow has a 'version' job", !!versionJob);

// Find steps by id
const steps = versionJob?.steps ?? [];
const closureGateStep = steps.find((s: Record<string, unknown>) => s.id === "closure-gate");
const releaseStep = steps.find((s: Record<string, unknown>) => s.id === "release-step");

check(
  "the version job has a step with id 'closure-gate'",
  !!closureGateStep,
);
check(
  "the closure-gate step invokes verify-publish-closure.mjs",
  typeof closureGateStep?.run === "string" && closureGateStep.run.includes("node scripts/verify-publish-closure.mjs"),
  closureGateStep?.run,
);
check(
  "the version job has a step with id 'release-step'",
  !!releaseStep,
);

// The release step must condition on closure-gate's output
check(
  "the release step's 'if' references the closure-gate step output",
  typeof releaseStep?.if === "string" && releaseStep.if.includes("steps.closure-gate.outputs.closure_ok"),
  releaseStep?.if,
);

// The closure-gate step must branch on all four exit codes, not treat any non-zero as failure.
// Exit 2 (UNSETTLED) and 3 (NONE) are quiet skips, not failures. Only exit 1 (PARTIAL) fails the job.
//
// These assert on each branch's BODY, not on the presence of its comparison (#1518). A substring
// match on `"$rc" -eq 2` sees that the branch exists and nothing about what it does, so an `exit 1`
// added to the quiet-skip path left this suite green while every no-publish push to main would have
// failed. That is the same weak-assertion shape as the `includes("verify-publish-closure.mjs")` hole
// a diagnostic echo satisfied (#1502).
const gateRun: string = closureGateStep?.run ?? "";

/**
 * The body of the gate script's `[ "$rc" -eq <code> ]` branch, or null when there is no such branch.
 * `else` is addressed as code -1, being the unexpected-rc arm.
 *
 * The chain is flat shell in a YAML block scalar, so the branch ends at the next line indented the
 * same as its own `if`/`elif`/`else` keyword and starting one of them (or `fi`). Anything indented
 * deeper stays part of the body, so a nested block cannot hide a line from these assertions.
 */
function rcBranchBody(run: string, code: number): string | null {
  const lines = run.split("\n");
  const opener = code === -1
    ? /^(\s*)else\s*$/
    : new RegExp(`^(\\s*)(?:el)?if \\[ "\\$rc" -eq ${code} \\]; then\\s*$`);
  const start = lines.findIndex((line) => opener.test(line));
  if (start < 0) return null;
  const indent = (opener.exec(lines[start]!) ?? [])[1] ?? "";
  const ends = new RegExp(`^${indent}(?:elif |else\\b|fi\\b)`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (ends.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Scratch `$GITHUB_OUTPUT` for {@link shellStatus}: the gate's own arms write to it
 *  (`echo "closure_ok=true" >> "$GITHUB_OUTPUT"`), so it has to be a real writable path or a
 *  correct arm would fail for a reason that has nothing to do with the branch. */
const GITHUB_OUTPUT_SCRATCH = join(mkdtempSync(join(tmpdir(), "closure-gate-")), "github_output");

/** A hang is not a pass, so a body that neither exits nor is signalled is an error rather than a
 *  classification. Generous enough that a loaded runner never trips it. */
const BODY_TIMEOUT_MS = 10_000;

const statusCache = new Map<string, number>();

/** The status the shell actually gives a branch body.
 *
 *  Flags and environment mirror the step the gate runs under: GitHub Actions invokes a `run:`
 *  block as `bash -e {0}`, and the gate binds `rc=$?` before branching, so `-e` is set and `rc`
 *  holds 2 — the value under which the quiet arms are reached.
 *
 *  A body killed by a signal (`kill -TERM $$`) has a null status; the step still fails, so it
 *  counts as non-zero. */
function shellStatus(body: string): number {
  const cached = statusCache.get(body);
  if (cached !== undefined) return cached;
  const result = spawnSync("bash", ["-e", "-c", body], {
    // Built, not inherited. `{ ...process.env }` would hand a runner's live
    // COTAL_ credentials to the child (`suite-ambient-env`), and it would also
    // make a recorded status depend on the machine: `LC_ALL`, `BASH_ENV` or a
    // stray `rc` in the runner's environment could move a row. PATH is the one
    // thing the bodies need, for `grep`, `env` and `bash` itself.
    env: { PATH: process.env["PATH"] ?? "", rc: "2", GITHUB_OUTPUT: GITHUB_OUTPUT_SCRATCH },
    stdio: "ignore",
    timeout: BODY_TIMEOUT_MS,
  });
  if (result.error) {
    // Includes "bash is not on PATH": failing loudly beats certifying an arm nobody measured.
    throw new Error(`could not measure branch body ${JSON.stringify(body)}: ${result.error.message}`);
  }
  const status = result.status ?? (result.signal ? 128 : 1);
  statusCache.set(body, status);
  return status;
}

/** Whether a branch body leaves the step with a failing status.
 *
 *  Two cells below assert the NEGATIVE of this, so under-detection is worse than an ordinary
 *  coverage gap: a body this cannot read is certified as safe, and that green is indistinguishable
 *  from a correct one. Three rounds of review closed evasions by position, by quoting and by verb,
 *  and a fourth produced eleven more quiet arms — `test 1 -eq 2`, `command false`, `((0))`,
 *  `trap "exit 1" EXIT` — that carry no failure word at all yet exit 1. The property they keep
 *  escaping is "the arm's last status is non-zero", which is a fact about execution, so no list of
 *  verbs decides it and the next list would lose the same way. The body is therefore run, which
 *  also settles the branches whose condition a static rule could not evaluate
 *  (`if false; then exit 1; fi` is no longer a known-wrong row; it is simply status 0). */
function failsTheJob(body: string): boolean {
  return shellStatus(body) !== 0;
}

/** Literal branch bodies and the status recorded for each one.
 *
 *  Now that {@link failsTheJob} runs the body, this table is no longer a matcher's report card —
 *  it pins the HARNESS. The statuses were recorded independently, so a change to how the body is
 *  invoked shows up here as a disagreement: drop `rc=2` and `exit $rc` slides from 2 to 0, drop
 *  `-e` and `false; echo done` slides from 1 to 0, and either flips a row's pass/fail sign. That
 *  is the only way those two settings can go wrong silently, since every call site below is
 *  workflow-derived and happens to use neither.
 *
 *  Only the sign is asserted, not the number: `/bin/false` is 127 on a mac (the binary lives in
 *  `/usr/bin`) and 1 on the Linux runner, and non-zero is all this table claims. The quiet rows —
 *  `test 1 -eq 2` through `trap "exit 1" EXIT` — are the arms that carry no failure word at all
 *  and were invisible to every version of the static matcher. */
const FAILS_THE_JOB_ROWS: ReadonlyArray<readonly [string, number]> = [
  ["exit 1", 1],
  ["exit 2", 2],
  ["exit $rc", 2],
  ["exit \"$rc\"", 2],
  ["exit ${rc}", 2],
  ["exit 1 # comment", 1],
  ["echo hi; exit 1", 1],
  ["true && exit 1", 1],
  ["false || exit 1", 1],
  ["exit 1 ;", 1],
  ["{ exit 1; }", 1],
  ["(exit 1)", 1],
  ["! :", 1],
  ["eval \"exit 1\"", 1],
  ["return 1", 1],
  ["kill -TERM $$", 143],
  ["/bin/false", 127],
  ["false", 1],
  ["case x in x) false ;; esac", 1],
  ["case x in x) exit 1;; esac", 1],
  ["if true; then exit 1; fi", 1],
  ["if false; then : ; else exit 1; fi", 1],
  ["while true; do exit 1; done", 1],
  ["for i in 1; do exit 1; done", 1],
  ["until false; do exit 1; done", 1],
  ["if [ x = x ]; then exit 1; fi", 1],
  ["if [ -n \"$rc\" ]; then exit 1; fi", 1],
  ["if false; then exit 1; fi", 0],
  ["echo \"a; exit 9\"", 0],
  ["exit 00", 0],
  ["exit 0", 0],
  ["exit 0 # fine", 0],
  ["echo ok; exit 0", 0],
  ["(exit 0)", 0],
  ["{ exit 0; }", 0],
  ["echo \"exit 1\"", 0],
  ["echo \"run false to fail\"", 0],
  ["true", 0],
  [":", 0],
  ["echo \"PARTIAL PUBLISH - failing the job.\"", 0],
  ["echo \"UNSETTLED - the registry has not converged. Skipping the Release.\"", 0],
  ["until true; do exit 1; done", 0],
  ["while false; do exit 1; done", 0],
  ["if true; then : ; else exit 1; fi", 0],
  ["exit 000", 0],
  ["exit 0x0", 255],
  // Quiet arms: no failure word anywhere, status 1 all the same.
  ["test 1 -eq 2", 1],
  ["[ 1 -eq 2 ]", 1],
  ["grep -q nomatch /dev/null", 1],
  ["command false", 1],
  ["builtin false", 1],
  ["env false", 1],
  ["bash -c \"exit 1\"", 1],
  ["exit 1 2>/dev/null", 1],
  ["exit 1 >&2", 1],
  ["exec false", 1],
  ["((0))", 1],
  ["trap \"exit 1\" EXIT", 1],
  // Pins `-e`: without it the body's status is the last command's, and this is 0.
  ["false; echo done", 1],
  // A redirect on an otherwise safe line stays safe — the gate's own output writes look like this.
  ["echo hi > /dev/null", 0],
];


// The battery runs FIRST: every assertion below reads `failsTheJob`, and a harness that is wrong
// about a hand-written body is wrong about a workflow-derived one for the same reason.
const disagreements = FAILS_THE_JOB_ROWS.filter(([body, status]) => failsTheJob(body) !== (status !== 0))
  .map(([body, status]) => ({ body, recorded: status, measured: shellStatus(body) }));
check(
  "every battery body still leaves the shell where it was recorded",
  disagreements.length === 0,
  { rows: FAILS_THE_JOB_ROWS.length, disagreements },
);
// The two settings the call sites below cannot exercise, asserted directly rather than only as a
// side effect of the table: the gate's arms are reached with `rc` bound and run under `-e`.
check(
  "bodies are measured the way the workflow runs them: `rc` bound to 2, `-e` set",
  shellStatus("exit $rc") === 2 && shellStatus("false; echo done") !== 0,
  { exitRc: shellStatus("exit $rc"), eSet: shellStatus("false; echo done") },
);

// Vacuity guard FIRST: the two "does not fail" assertions below are only worth anything if this
// parser can see a failing exit where there is one. The branches that must fail are the proof.
const partialBody = rcBranchBody(gateRun, 1);
check(
  "the closure-gate step branches on exit code 1 (PARTIAL) to fail the job",
  partialBody !== null && failsTheJob(partialBody),
  { partialBody, gateRun },
);
const unexpectedBody = rcBranchBody(gateRun, -1);
check(
  "the closure-gate step fails the job on an unexpected exit code",
  unexpectedBody !== null && failsTheJob(unexpectedBody),
  { unexpectedBody, gateRun },
);

const unsettledBody = rcBranchBody(gateRun, 2);
check(
  "the closure-gate step handles exit code 2 (UNSETTLED) without failing",
  unsettledBody !== null && !failsTheJob(unsettledBody),
  { unsettledBody, gateRun },
);
const noneBody = rcBranchBody(gateRun, 3);
check(
  "the closure-gate step handles exit code 3 (NONE) without failing",
  noneBody !== null && !failsTheJob(noneBody),
  { noneBody, gateRun },
);

// ---------------------------------------------------------------- A2. The whole step, per rc
//
// Everything above grades a branch body in isolation, which is the property #1518 asked for and is
// not the whole property. A body that does not fail is only a quiet skip if the SCRIPT stops
// failing too, and while the arm fell out of the `fi` it did not decide that: every later line got
// a vote. Two shapes turned the quiet skip into a red job with all four arms still reading as
// correct -- `trap "exit 1" EXIT` installed in the prologue above the chain, and a tidy-up
// `exit $rc` added below the `fi`. Neither is inside an arm, so no amount of care in reading arms
// can see either one, and the per-body cells stayed green through both.
//
// The arms now end the step themselves, which is what makes the second shape inert: rc 2 and rc 3
// never reach a line below the chain. The first shape is not disarmed that way, because an EXIT
// trap fires on the arm's own `exit`, so it still has to be caught by measurement.
//
// So the step's own run script is executed, once per exit code the verifier documents, with `node`
// stubbed to return that code. The assertions are the three things the job actually depends on:
// the status the step leaves, whether `closure_ok` was published, and whether the quiet arms end
// the script themselves rather than delegating their outcome to whatever follows them.

/** `node`, `git` and `jq` as the gate's prologue calls them, so the run script reaches its branch
 *  chain without a network, a repo object or the real verifier. `node` is the one under control:
 *  it exits with `$STUB_RC`, which is how each rc below is induced. Bash scripts with a shebang,
 *  so nothing here resolves through a package.json and TMPDIR cannot change their meaning. */
const STUB_BIN = mkdtempSync(join(tmpdir(), "closure-gate-stub-"));
writeFileSync(join(STUB_BIN, "node"), '#!/usr/bin/env bash\nexit "${STUB_RC:-0}"\n', { mode: 0o755 });
writeFileSync(join(STUB_BIN, "git"), '#!/usr/bin/env bash\necho \'{"version":"9.9.9"}\'\n', { mode: 0o755 });
writeFileSync(join(STUB_BIN, "jq"), '#!/usr/bin/env bash\necho 9.9.9\n', { mode: 0o755 });

interface StepRun {
  /** The status the step leaves behind, which is what reds or passes the job. */
  status: number;
  /** What the step wrote to `$GITHUB_OUTPUT`; `closure_ok=true` is what gates the Release step. */
  output: string;
  /** Whether control reached the line after the script. False means the arm terminated the step
   *  itself, so nothing added below the chain can change its verdict. */
  fellThrough: boolean;
}

/** Run the gate's run script with the verifier stubbed to exit `rc`.
 *
 *  A sentinel is appended after the script: its absence is the evidence that the arm exited rather
 *  than falling out of the `fi`. Invoked as `bash -e {0}`, which is how GitHub Actions invokes a
 *  `run:` block, so the script meets the same shell option the real step runs under. */
function runGateStep(run: string, rc: number): StepRun {
  const dir = mkdtempSync(join(tmpdir(), `closure-gate-rc${rc}-`));
  const outPath = join(dir, "github_output");
  const sentinel = join(dir, "sentinel");
  writeFileSync(outPath, "");
  const result = spawnSync("bash", ["-e", "-c", `${run}\n: > ${JSON.stringify(sentinel)}\n`], {
    // Built, not inherited, for the same reason as shellStatus: no live COTAL_ credentials, and no
    // ambient `rc`, `BASH_ENV` or `GITHUB_OUTPUT` steering the script under test. The stub
    // directory comes FIRST so the gate's `node` is the controlled one.
    env: {
      PATH: `${STUB_BIN}:${process.env["PATH"] ?? ""}`,
      STUB_RC: String(rc),
      GITHUB_SHA: "0000000000000000000000000000000000000000",
      GITHUB_OUTPUT: outPath,
    },
    stdio: "ignore",
    timeout: BODY_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`could not run the gate step at rc ${rc}: ${result.error.message}`);
  }
  return {
    status: result.status ?? (result.signal ? 128 : 1),
    output: readFileSync(outPath, "utf8"),
    fellThrough: existsSync(sentinel),
  };
}

/** The verifier's documented exit codes and what the job must do with each.
 *
 *  `settlesInTheArm` is the property this section adds: for the two quiet skips it is the
 *  difference between "this arm does not fail" and "this arm's verdict is final". The failing arms
 *  do not carry it because their own `exit 1` already makes it true, so asserting it there would
 *  restate the status column. */
const STEP_ROWS: ReadonlyArray<{
  rc: number; name: string; failsJob: boolean; publishesClosureOk: boolean; settlesInTheArm?: true;
}> = [
  { rc: 0, name: "PUBLISHED", failsJob: false, publishesClosureOk: true },
  { rc: 1, name: "PARTIAL", failsJob: true, publishesClosureOk: false },
  { rc: 2, name: "UNSETTLED", failsJob: false, publishesClosureOk: false, settlesInTheArm: true },
  { rc: 3, name: "NONE", failsJob: false, publishesClosureOk: false, settlesInTheArm: true },
  { rc: 7, name: "unexpected", failsJob: true, publishesClosureOk: false },
];

const stepRuns = new Map(STEP_ROWS.map((row) => [row.rc, runGateStep(gateRun, row.rc)]));

// Control: the harness reaches the branch chain at all. If the stubbed prologue died early, every
// row below would report status 1 and the two "fails the job" rows would pass for the wrong reason,
// which is a void green dressed as a detection.
check(
  "the stubbed step reaches the branch chain: rc 0 publishes closure_ok=true",
  stepRuns.get(0)!.output.includes("closure_ok=true"),
  stepRuns.get(0),
);

const statusDisagreements = STEP_ROWS
  .filter((row) => (stepRuns.get(row.rc)!.status !== 0) !== row.failsJob)
  .map((row) => ({ ...row, observed: stepRuns.get(row.rc) }));
check(
  "running the whole gate step leaves the job red only on PARTIAL and an unexpected code",
  statusDisagreements.length === 0,
  statusDisagreements,
);

const outputDisagreements = STEP_ROWS
  .filter((row) => stepRuns.get(row.rc)!.output.includes("closure_ok=true") !== row.publishesClosureOk)
  .map((row) => ({ ...row, observed: stepRuns.get(row.rc) }));
check(
  "only a PUBLISHED verdict publishes closure_ok=true, so only it can cut a Release",
  outputDisagreements.length === 0,
  outputDisagreements,
);

// The cell the two regressions above are caught by: a quiet arm must END the step. While the arm
// merely declined to fail, its verdict was still open to anything below the `fi` or any trap set
// above it, and the job's outcome on a no-publish push was not a property of the branch at all.
const unsettledRuns = STEP_ROWS.filter((row) => row.settlesInTheArm)
  .filter((row) => stepRuns.get(row.rc)!.fellThrough)
  .map((row) => ({ rc: row.rc, name: row.name }));
check(
  "the quiet-skip arms (UNSETTLED, NONE) end the step themselves rather than falling out of the chain",
  unsettledRuns.length === 0,
  { stillFallingThrough: unsettledRuns },
);

// The closure-gate step must come BEFORE the release step
const closureGateIndex = steps.indexOf(closureGateStep);
const releaseIndex = steps.indexOf(releaseStep);
check(
  "the closure-gate step appears before the release step in the version job",
  closureGateIndex >= 0 && releaseIndex >= 0 && closureGateIndex < releaseIndex,
  { closureGateIndex, releaseIndex },
);

// The old single-package check must NOT be present
check(
  "the old single-package npm view check is removed from the workflow",
  !workflowText.includes('npm view "cotal-ai@$version"'),
);

// Positive control: a fixture workflow WITHOUT the closure-gate must fail the step-id check
const fixtureWorkflowText = workflowText
  .replace(/- name: Verify publish closure[\s\S]*?fi\n\n/m, "")
  .replace(/steps\.closure-gate\.outputs\.closure_ok\s*==\s*'true'\s*&&?\s*/g, "");
const fixtureWorkflow = parseYaml(fixtureWorkflowText);
const fixtureSteps = fixtureWorkflow?.jobs?.version?.steps ?? [];
const fixtureGate = fixtureSteps.find((s: Record<string, unknown>) => s.id === "closure-gate");
check(
  "positive control: a workflow with the closure gate removed has no closure-gate step",
  !fixtureGate,
);

// ================================================================ B. Fake-registry gate
// A local HTTP server returning controlled responses for each package
type ServerState = Map<string, { status: number; body: object | null }>;

function createFakeRegistry(state: ServerState): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = decodeURIComponent(req.url ?? "");
      // Extract package name from URL: /<name>/<version>
      const parts = url.slice(1).split("/");
      const version = parts.pop()!;
      const name = parts.join("/").replace("%40", "@").replace("%2f", "/");

      const entry = state.get(name);
      if (!entry || entry.status === 404) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(entry.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entry.body ?? {}));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ port: addr.port, close: () => server.close() });
      }
    });
  });
}

const pkgs = ["a", "b", "c", "d"];
const fastOpts = { ...DEFAULTS, pollIntervalMs: 10, stableWindowMs: 20, deadlineMs: 60_000 };
const fastClock = () => { let t = 0; return { now: () => (t += 1000), sleep: async () => {} }; };

// B1. All present: passes
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: all packages present with correct body -> PUBLISHED",
    result.state === "published",
    result,
  );
}

// B2. One missing (404): reds
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "c"
      ? { status: 404, body: null }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one package missing (404) -> PARTIAL (red)",
    result.state === "partial",
    result,
  );
  check(
    "fake registry: the missing package is named in the verdict",
    result.missing?.includes("c"),
    result.missing,
  );
}

// B3. One 200 with wrong-version body: reds (no evidence of this version)
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "b"
      ? { status: 200, body: { name: "b", version: "1.0.0" } }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one 200 with wrong version in body -> does NOT pass as published",
    result.state !== "published",
    result,
  );
}

// B4. One 200 with error body (no name/version): reds
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "a"
      ? { status: 200, body: { error: "internal error", code: 500 } }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one 200 with an error body (no name/version) -> does NOT pass as published",
    result.state !== "published",
    result,
  );
}

// B5. One 200 naming a different package: reds
{
  const state: ServerState = new Map(
    pkgs.map((p) => [p, p === "d"
      ? { status: 200, body: { name: "wrong-pkg", version: "9.9.9" } }
      : { status: 200, body: { name: p, version: "9.9.9" } }]),
  );
  const { port, close } = await createFakeRegistry(state);
  const result = await verifyClosure("9.9.9", {
    packages: pkgs,
    opts: { ...fastOpts, registryBase: `http://127.0.0.1:${port}` },
    ...fastClock(),
  });
  close();
  check(
    "fake registry: one 200 naming a different package -> does NOT pass as published",
    result.state !== "published",
    result,
  );
}

const EXPECTED = 24;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED, passed + failed);
console.log(`PUBLISH CLOSURE GATE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
