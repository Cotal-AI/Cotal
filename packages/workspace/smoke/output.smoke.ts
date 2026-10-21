/**
 * The shared output contract in `@cotal-ai/workspace` (`output.ts`): the outcome-to-exit table, the
 * rule that an error code belongs to one outcome, the version 1 envelope and NDJSON record shapes,
 * the native cause kept beside the stable code, and the brand that recognizes a failure built by a
 * second copy of the module. Broker-free.
 *
 * Run: pnpm smoke:output
 */
import {
  BOUNDARY_CODES,
  CommandFailure,
  commandFailureReport,
  envelopeLine,
  exitCode,
  failureEnvelope,
  globalFlagDeclarationProblems,
  isCommandFailure,
  jsonFlag,
  outputDeclarationProblems,
  outputFlags,
  plainFlag,
  renderReport,
  streamRecord,
  USAGE_CODES,
  type Envelope,
  type ErrorCode,
  type Outcome,
} from "@cotal-ai/workspace";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log("OUTPUT SMOKE");

// The exit table, one row per outcome and refusal class.
const exits: [Outcome, ErrorCode | undefined, number][] = [
  ["ok", undefined, 0],
  ["no-op", undefined, 0],
  ["refused", "USAGE_INVALID", 1],
  ["refused", "SCHEMA_INVALID", 1],
  ["unknown", "OPERATION_UNKNOWN", 3],
  ["partial", "OPERATION_PARTIAL", 4],
  ["failed", "OPERATION_FAILED", 5],
];
for (const [outcome, code, want] of exits) check(`${outcome}${code ? ` ${code}` : ""} exits ${want}`, exitCode(outcome, code) === want, exitCode(outcome, code));
check("every boundary refusal exits 2", BOUNDARY_CODES.every((c) => exitCode("refused", c) === 2));
check("usage and boundary codes do not overlap", USAGE_CODES.every((c) => !(BOUNDARY_CODES as readonly string[]).includes(c)));

// A code belongs to one outcome; a mismatched pair is a programming error, not an exit code.
check("ok with an error code is refused", throws(() => exitCode("ok", "OPERATION_FAILED")));
check("a refusal without a code is refused", throws(() => exitCode("refused")));
check("a refusal cannot carry an operation code", throws(() => exitCode("refused", "OPERATION_UNKNOWN")));
check("unknown cannot carry a boundary code", throws(() => exitCode("unknown", "TARGET_UNAVAILABLE")));
check("failed cannot carry the partial code", throws(() => exitCode("failed", "OPERATION_PARTIAL")));
check("a failure cannot be built with a mismatched pair", throws(() => new CommandFailure("partial", "OPERATION_FAILED", "x")));

// The failure envelope carries the stable code, the remedy, the native cause and the changed list.
const native = { code: "E_LEASE", outcome: "not-executed", detail: { holder: "seat-1" } };
const failure = new CommandFailure("refused", "CONFLICT", "the lease is held", {
  remedy: "wait for seat-1 to release it",
  native,
  target: { space: "s1" },
  changed: [{ kind: "lock", id: "l1" }],
});
const env = JSON.parse(envelopeLine(failureEnvelope("lease take", failure))) as Envelope;
check("a failure envelope is schema version 1", env.schemaVersion === 1, env);
check("a failure envelope names its command and target", env.command === "lease take" && JSON.stringify(env.target) === JSON.stringify({ space: "s1" }), env);
check("a failure envelope has no result", env.result === null && env.outcome === "refused", env);
check("a failure envelope carries the code, message and remedy", env.error?.code === "CONFLICT" && env.error.message === "the lease is held" && env.error.remedy === "wait for seat-1 to release it", env.error);
check("the native cause is kept beside the stable code", JSON.stringify(env.error?.cause) === JSON.stringify(native), env.error);
check("changed resources survive a failure", JSON.stringify(env.changed) === JSON.stringify([{ kind: "lock", id: "l1" }]), env);
const bare = JSON.parse(envelopeLine(failureEnvelope("x", new CommandFailure("failed", "OPERATION_FAILED", "boom")))) as Envelope;
check("an unset remedy, cause and changed list are absent, not null", !("remedy" in bare.error!) && !("cause" in bare.error!) && !("changed" in bare), bare);
check("an unset target is null", bare.target === null, bare);
// A failure report prints the attempt id its target carries, so the recovery command can name it.
const attemptId = "restore-00000000-0000-4000-8000-000000000000";
const attemptReport = renderReport(commandFailureReport(new CommandFailure("unknown", "OPERATION_UNKNOWN", "the restore did not finish", { target: { attemptId } })), "plain");
check("a failure report prints the attempt id its target carries", new RegExp(`Attempt: +${attemptId}`).test(attemptReport), attemptReport);

const ok: Envelope = { schemaVersion: 1, command: "version", target: null, outcome: "ok", completeness: "complete", result: { v: 1 }, warnings: [] };
const line = envelopeLine(ok);
check("an envelope is one line ending in a newline", line.endsWith("\n") && !line.slice(0, -1).includes("\n"), line);
check("an ok envelope carrying an error is refused", throws(() => envelopeLine({ ...ok, error: { code: "OPERATION_FAILED", message: "x" } })));
check("a failed envelope without an error is refused", throws(() => envelopeLine({ ...ok, outcome: "failed" })));

// The brand recognizes a failure from another copy of the module; a look-alike is not one.
const foreign = Object.assign(new Error("x"), { [Symbol.for("cotal.CommandFailure")]: true });
check("a branded failure from another module copy is recognized", isCommandFailure(foreign));
check("a failure is recognized", isCommandFailure(failure));
check("a plain error is not a failure", !isCommandFailure(new Error("x")));
check("a look-alike with outcome and code is not a failure", !isCommandFailure({ outcome: "refused", code: "CONFLICT" }));

// One NDJSON record per line, its time as an ISO string.
const at = new Date("2026-10-16T08:00:00.000Z");
const rec = streamRecord("watch", "event", { space: "s1" }, { n: 1 }, at);
check("a stream record has the version 1 shape", JSON.stringify(rec) === JSON.stringify({ schemaVersion: 1, stream: "watch", type: "event", target: { space: "s1" }, receivedAt: "2026-10-16T08:00:00.000Z", data: { n: 1 } }), rec);

// A declared output needs its shared flag.
check("json and ndjson outputs need --json/-j", outputFlags(["json"]).length === 1 && outputFlags(["ndjson"])[0] === jsonFlag && outputFlags(["json", "ndjson"]).length === 1);
check("a json output with the shared flag is accepted", outputDeclarationProblems({ name: "a", outputs: ["json"], flags: [jsonFlag] }).length === 0);
check("a json output without the flag is refused", outputDeclarationProblems({ name: "a", outputs: ["json"], flags: [] }).length === 1);
check("a json flag without its -j short is refused", outputDeclarationProblems({ name: "a", outputs: ["json"], flags: [{ name: "json", type: "boolean" }] }).length === 1);
check("a plain output needs --plain", outputDeclarationProblems({ name: "a", outputs: ["plain"], flags: [] }).length === 1);

// No command may declare a global flag's name.
check("a command that declares --no-color or --no-input is refused", globalFlagDeclarationProblems({ name: "a", flags: [{ name: "no-color", type: "string" }, { name: "no-input", type: "boolean" }] }).length === 2);
check("a command with other flags is accepted", globalFlagDeclarationProblems({ name: "a", flags: [jsonFlag, plainFlag] }).length === 0);

if (failed) {
  console.log(`OUTPUT SMOKE: ${failed} failed`);
  process.exit(1);
}
console.log("OUTPUT SMOKE: all passed");
