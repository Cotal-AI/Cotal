/**
 * `goaleff` closed-machine smoke — § S1's shape rules and edge table.
 *
 * Pure: no broker, no clock, no filesystem. Everything below is decidable from the row bytes and
 * the actor, which is the whole reason the machine was specified separately from the executor that
 * drives it. The behavioural cells (two contenders, dropped replies, crashes) live with the
 * executor and prove different things; these prove that the machine those cells drive REFUSES what
 * it is supposed to refuse.
 *
 * Run: pnpm smoke:ep-goaleff   (part of smoke:ci)
 */
import {
  parseGoalEff, assertGoalEffEdge,
  type GoalEffRow, type GoalEffActor,
} from "../src/endpoint-goaleff.js";

let ok = 0, fail = 0;
function c(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`); }
}
/** Assert a throw AND that it is about the right thing. A refusal for the wrong reason passes a
 *  bare `throws` and tells you nothing — several of the mutations below turn one refusal into
 *  another, and a cell that only counts throws cannot see that. */
function refuses(label: string, fn: () => unknown, matching: RegExp): void {
  try { fn(); c(label, false, "did NOT throw"); }
  catch (e) {
    const m = (e as Error).message;
    c(label, matching.test(m), { expected: String(matching), got: m });
  }
}
function allows(label: string, fn: () => unknown): void {
  try { fn(); c(label, true); }
  catch (e) { c(label, false, (e as Error).message); }
}

const EXEC = { instanceId: "mgr-a", processEpoch: 3 };
const OTHER = { instanceId: "mgr-b", processEpoch: 1 };
const ADDR = { nameToken: "worker-7", lifecycleUid: "u_abc" };
const ADDR2 = { nameToken: "worker-9", lifecycleUid: "u_zzz" };
const A: GoalEffActor = { role: "executor", executor: EXEC, attemptId: "att-1" };
const SWEEPER: GoalEffActor = { role: "sweeper" };

const claimed = { v: 1, executor: EXEC, attemptId: "att-1", ts: 10, phase: "claimed" };
const launching = { ...claimed, phase: "launching", addr: ADDR };
const launched = { ...claimed, phase: "launched", addr: ADDR };
const settledNoAddr = { ...claimed, phase: "settled" };
const settledAddr = { ...claimed, phase: "settled", addr: ADDR };

const P = (v: unknown): GoalEffRow => parseGoalEff(v);

console.log("\n── § S1 shape: each phase names the COMPLETE legal field set ──");
allows("claimed parses", () => P(claimed));
allows("launching parses with addr", () => P(launching));
allows("launched parses with addr", () => P(launched));
allows("settled parses WITHOUT addr (settled from claimed)", () => P(settledNoAddr));
allows("settled parses WITH addr (settled from launching)", () => P(settledAddr));

refuses("launching without `addr` is refused", () => P({ ...claimed, phase: "launching" }), /REQUIRES `addr`/);
refuses("launched without `addr` is refused", () => P({ ...claimed, phase: "launched" }), /REQUIRES `addr`/);
// `claimed` forbids `addr` by NOT LISTING IT, so this refusal comes from the unknown-field check
// and names the field. That is the whole mechanism — there is no second "addr is forbidden here"
// rule, because one would never execute.
refuses("claimed WITH `addr` is refused (it never launched)",
  () => P({ ...claimed, addr: ADDR }), /unknown field\(s\) for phase claimed: addr/);
refuses("an unknown field is refused, not ignored",
  () => P({ ...claimed, launchAttemptId: "att-1" }), /unknown field\(s\) for phase claimed/);
refuses("an unknown phase is refused", () => P({ ...claimed, phase: "relaunching" }), /unknown phase/);
refuses("v must be exactly 1", () => P({ ...claimed, v: 2 }), /`v` must be exactly 1/);
refuses("attemptId must be present and non-empty", () => P({ ...claimed, attemptId: "" }), /attemptId/);
refuses("an unknown field on `executor` is refused",
  () => P({ ...claimed, executor: { ...EXEC, pid: 42 } }), /unknown field\(s\) on `executor`/);
refuses("an unknown field on `addr` is refused",
  () => P({ ...launching, addr: { ...ADDR, host: "x" } }), /unknown field\(s\) on `addr`/);
refuses("processEpoch must be a non-negative safe integer",
  () => P({ ...claimed, executor: { instanceId: "mgr-a", processEpoch: -1 } }), /processEpoch/);

// PROTOTYPE KEYS. `phase in PHASE_FIELDS` walked the prototype chain, so these three passed the
// membership test and then died with an uncontrolled TypeError instead of the declared refusal.
// A reviewer found it; the suite's own "unknown phase" cell used `relaunching`, a plausible-looking
// name that is not on any prototype — so it tested the branch and never the lookup.
for (const proto of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"])
  refuses(`an inherited key (${proto}) is refused as an unknown phase, not a TypeError`,
    () => P({ ...claimed, phase: proto }), /unknown phase/);

console.log("\n── § S1 edges: the table, and nothing outside it ──");
allows("claimed → launching (executor, addr set in the same operation)",
  () => assertGoalEffEdge(P(claimed), P(launching), A, { terminalExists: false }));
allows("launching → launched (executor)",
  () => assertGoalEffEdge(P(launching), P(launched), A, { terminalExists: false }));
allows("claimed → settled (terminal exists)",
  () => assertGoalEffEdge(P(claimed), P(settledNoAddr), A, { terminalExists: true }));
allows("launching → settled carries its addr",
  () => assertGoalEffEdge(P(launching), P(settledAddr), A, { terminalExists: true }));
allows("launched → settled carries its addr",
  () => assertGoalEffEdge(P(launched), P(settledAddr), A, { terminalExists: true }));

refuses("launched → launching is not a legal edge",
  () => assertGoalEffEdge(P(launched), P(launching), A, { terminalExists: false }), /not a legal edge/);
refuses("claimed → launched skips the pre-launch write",
  () => assertGoalEffEdge(P(claimed), P(launched), A, { terminalExists: false }), /not a legal edge/);
refuses("launching → claimed does not go backwards",
  () => assertGoalEffEdge(P(launching), P(claimed), A, { terminalExists: false }), /not a legal edge/);

console.log("\n── settled is TERMINAL: its absence from the table IS the rule ──");
refuses("settled → launching is refused as TERMINAL, not merely as absent",
  () => assertGoalEffEdge(P(settledAddr), P(launching), A, { terminalExists: true }), /TERMINAL/);
refuses("settled → settled is refused too (a terminal row is not re-settleable)",
  () => assertGoalEffEdge(P(settledNoAddr), P(settledNoAddr), A, { terminalExists: true }), /TERMINAL/);

console.log("\n── the settle gate: a terminal must exist FIRST ──");
refuses("a settle without a terminal is refused",
  () => assertGoalEffEdge(P(launched), P(settledAddr), A, { terminalExists: false }), /requires the terminal to exist FIRST/);

console.log("\n── immutability: what a revision-CAS does NOT prevent ──");
refuses("`executor` cannot change while taking a legal edge",
  () => assertGoalEffEdge(P(claimed), P({ ...launching, executor: OTHER }), A, { terminalExists: false }),
  /`executor` is immutable/);
refuses("`attemptId` cannot change while taking a legal edge",
  () => assertGoalEffEdge(P(claimed), P({ ...launching, attemptId: "att-2" }), A, { terminalExists: false }),
  /`attemptId` is immutable/);
// `v` HAS NO EDGE CELL, ON PURPOSE, and this comment is the record of why rather than an omission
// a later reader has to rediscover. Both arguments to `assertGoalEffEdge` are `GoalEffRow`, so both
// came through `parseGoalEff`, which refuses every value but 1. There is no input that reaches a
// `v` comparison in the edge validator, so a cell for one could only be written by constructing a
// row the parser would reject — proving the test's own cast works, and nothing about the machine.
// The rule is asserted where it is decidable, at the parser, by "v must be exactly 1" above.

console.log("\n── addr: immutable once written, and DETERMINED when absent ──");
refuses("`addr` cannot be re-pointed on launching → launched",
  () => assertGoalEffEdge(P(launching), P({ ...launched, addr: ADDR2 }), A, { terminalExists: false }),
  /`addr` is immutable once written/);
refuses("`addr` cannot be re-pointed on launched → settled",
  () => assertGoalEffEdge(P(launched), P({ ...settledAddr, addr: ADDR2 }), A, { terminalExists: true }),
  /`addr` is immutable once written/);
refuses("`addr` cannot be dropped on launched → settled",
  () => assertGoalEffEdge(P(launched), P(settledNoAddr), A, { terminalExists: true }),
  /`addr` is immutable once written/);
refuses("a claimed → settled row cannot INVENT an addr it never had",
  () => assertGoalEffEdge(P(claimed), P(settledAddr), A, { terminalExists: true }),
  /must stay ABSENT/);
// "claimed → launching must SET addr" likewise has no edge cell: a `launching` row without `addr`
// is refused by the parser two sections above and never reaches the edge validator. Asserted once,
// where it can fail.

console.log("\n── the actor: a sweeper settles, and does nothing else ──");
allows("a sweeper MAY settle a claimed row",
  () => assertGoalEffEdge(P(claimed), P(settledNoAddr), SWEEPER, { terminalExists: true }));
allows("a sweeper MAY settle a launched row",
  () => assertGoalEffEdge(P(launched), P(settledAddr), SWEEPER, { terminalExists: true }));
refuses("a sweeper may NOT advance claimed → launching",
  () => assertGoalEffEdge(P(claimed), P(launching), SWEEPER, { terminalExists: false }),
  /may only settle/);
refuses("a sweeper may NOT advance launching → launched",
  () => assertGoalEffEdge(P(launching), P(launched), SWEEPER, { terminalExists: false }),
  /may only settle/);

// The role union is a COMPILE-TIME claim about callers this module does not have yet. An unknown
// role fell through both branches and was ACCEPTED — the most permissive possible answer to "who
// are you". Runtime-closed now.
refuses("an unknown actor role is REFUSED, not silently allowed through",
  () => assertGoalEffEdge(P(claimed), P(launching), { role: "auditor" } as never, { terminalExists: false }),
  /unknown actor role/);

console.log("\n── the executor: a FOREIGN nonce is a loss, never a licence ──");
refuses("a different executor cannot take the row's edge",
  () => assertGoalEffEdge(P(claimed), P(launching), { role: "executor", executor: OTHER, attemptId: "att-1" },
    { terminalExists: false }), /not the row's executor/);
refuses("a foreign attemptId cannot take the row's edge",
  () => assertGoalEffEdge(P(claimed), P(launching), { role: "executor", executor: EXEC, attemptId: "att-2" },
    { terminalExists: false }), /is a loss, never a licence/);
allows("the row's OWN executor and nonce may proceed — the 2a-i case, stated where it is decidable",
  () => assertGoalEffEdge(P(claimed), P(launching), A, { terminalExists: false }));

console.log(`\nENDPOINT GOALEFF SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exitCode = 1;
