/**
 * The release workflow must gate the GitHub Release on a full-closure verification of every package
 * in the lockstep group, not on a single `npm view` of one package (#1286). And the closure verifier
 * must read the response body on a 200, not just the status (#1257).
 *
 * This smoke has two sections:
 *
 * A. Workflow shape — parses `.github/workflows/changesets.yml` and asserts that the Release step
 *    depends on a prior closure-gate step, anchored on step ids. A positive-control fixture with
 *    the gate removed must fail the same assertion, so the check is shown to discriminate.
 *
 * B. Fake-registry gate — starts a local HTTP server returning controlled responses and runs the
 *    closure verifier against it. Four states: all present passes; one missing reds; one 200 with
 *    a wrong-version body reds; one 200 with an error body reds.
 *
 * Run: pnpm smoke:publish-closure-gate
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/publish-closure-gate.json
 */
import { readFileSync } from "node:fs";
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

/** Where a command can begin: the start of a line, a separator or opening group, or after a shell
 *  keyword that introduces a command list. The keywords are the half a punctuation-only rule misses:
 *  `; exit 1` is a command position and so is `; then exit 1`, and six reachable failure forms
 *  (`if true; then …`, `else …`, `while/for/until … do …`) hid behind that gap. */
const COMMAND_START = String.raw`(?:^|[;&|(){}]|\b(?:then|else|do)\b)\s*`;
/** Where it can end and still be a command of its own: end of line, a separator, a closing group,
 *  or an inline comment. */
const COMMAND_END = String.raw`\s*(?:$|[;&|)}#])`;
/** An `exit` whose status is anything but zero. `0`, `00` and `000` are all zero to the shell; a
 *  variable (`exit $rc`) counts as failing, since it is how a captured failure is forwarded and
 *  nothing static can rule out that it carries one. */
const NONZERO_EXIT = String.raw`exit\s+(?!0+${COMMAND_END})\S+`;
const FAILING_COMMANDS = [
  NONZERO_EXIT,
  String.raw`(?:/(?:usr/)?bin/)?false`,
  String.raw`return\s+(?!0${COMMAND_END})\d+`,
  String.raw`!\s*:`,               // negated true
  String.raw`kill\s+-\w+\s+\$\$`, // signal the shell itself
].join("|");
/** `eval` is the one place a QUOTED failure command runs. Matched on the `eval` word against the
 *  RAW body, so `echo "exit 1"` stays prose. */
const EVAL_FAILURE = String.raw`\beval\s+["']?\s*(?:${NONZERO_EXIT}|(?:/(?:usr/)?bin/)?false)`;
const FAILS = new RegExp(`${COMMAND_START}(?:${FAILING_COMMANDS})${COMMAND_END}`, "m");
const EVAL_FAILS = new RegExp(EVAL_FAILURE, "m");

/** A quoted span is text, not a command list: `echo "a; exit 9"` prints a string and leaves the step
 *  green. Filled with a placeholder rather than deleted so the span still reads as ONE argument,
 *  which is what keeps `exit "$rc"` a failing exit while hiding the separators inside `echo "…"`. */
function withoutQuotedText(body: string): string {
  return body.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => "x".repeat(quoted.length));
}

/** Whether a branch body leaves the step with a failing status.
 *
 *  Two cells below assert the NEGATIVE of this, so under-detection is worse than an ordinary
 *  coverage gap: a body this cannot read is certified as safe, and that green is indistinguishable
 *  from a correct one. {@link FAILS_THE_JOB_ROWS} is the battery that grades both directions
 *  against statuses measured from `bash -c`, rather than against reasoning about regexes.
 *
 *  The one class it gets wrong, and the reason is structural rather than a missing pattern: it does
 *  not evaluate conditions, so a failure command in a branch that never runs
 *  (`if false; then exit 1; fi`) is reported as failing. Those four shapes are carried in the
 *  battery as `"unevaluable"` and asserted to STILL disagree, so the gap cannot widen unnoticed and
 *  closing it reds the battery instead of passing quietly. */
function failsTheJob(body: string): boolean {
  return FAILS.test(withoutQuotedText(body)) || EVAL_FAILS.test(body);
}

/** Literal branch bodies, the status `bash -c` actually gave each one, and whether the matcher is
 *  known to disagree.
 *
 *  Every call site of {@link failsTheJob} is workflow-derived, so nothing here tested the helper
 *  against a body written by hand, and that is where every evasion lived. Statuses were measured,
 *  not reasoned about: rows naming `rc` were run under `rc=2`, the way the gate's own `rc=$?` binds
 *  it. `/bin/false` is 127 on a mac (the binary lives in `/usr/bin`) and 1 on the Linux runner;
 *  either way it is non-zero, which is all this table claims. */
const FAILS_THE_JOB_ROWS: ReadonlyArray<readonly [string, number] | readonly [string, number, "unevaluable"]> = [
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
  ["if false; then exit 1; fi", 0, "unevaluable"],
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
  ["until true; do exit 1; done", 0, "unevaluable"],
  ["while false; do exit 1; done", 0, "unevaluable"],
  ["if true; then : ; else exit 1; fi", 0, "unevaluable"],
  ["exit 000", 0],
  ["exit 0x0", 255],
];


// The battery runs FIRST: every assertion below reads `failsTheJob`, and a matcher that is wrong
// about a hand-written body is wrong about a workflow-derived one for the same reason.
const UNEVALUABLE = FAILS_THE_JOB_ROWS.filter((row) => row[2] === "unevaluable").map((row) => row[0]);
const disagreements = FAILS_THE_JOB_ROWS.filter(([body, status]) => failsTheJob(body) !== (status !== 0))
  .map(([body]) => body);
check(
  `failsTheJob matches the measured shell status on every evaluable body (${FAILS_THE_JOB_ROWS.length - UNEVALUABLE.length} of them)`,
  disagreements.every((body) => UNEVALUABLE.includes(body)),
  disagreements.filter((body) => !UNEVALUABLE.includes(body)),
);
// The gap is pinned, not merely documented: it may not widen, and closing it reds this cell rather
// than passing quietly, which is the only way a reader finds out the comment above went stale.
check(
  "the bodies it is wrong about are exactly the branches whose condition it cannot evaluate",
  disagreements.length === UNEVALUABLE.length && UNEVALUABLE.every((body) => disagreements.includes(body)),
  { disagreements, UNEVALUABLE },
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

const EXPECTED = 20;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED, passed + failed);
console.log(`PUBLISH CLOSURE GATE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
