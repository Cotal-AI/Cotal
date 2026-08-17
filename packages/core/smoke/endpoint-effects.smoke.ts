/**
 * The effects executor's re-read decision — § S4 steps 3-4, as a pure function.
 *
 * EVERY "ZERO" HERE HAS A "ONE" BESIDE IT, and that pairing is the point rather than a courtesy.
 * `stand-down` is the correct answer under several conditions and catastrophic under one, so a cell
 * pinning `stand-down` has pinned nothing until its twin demands `launch` from the case one field
 * away. An implementation that stands down on every ambiguity satisfies `≤ 1` for every goal it
 * never launches.
 *
 * Run: pnpm smoke:ep-effects   (part of smoke:ci)
 */
import { decideEffect, type EffectAsker } from "../src/endpoint-effects.js";
import { parseGoalEff, type GoalEffRow } from "../src/endpoint-goaleff.js";

let ok = 0, fail = 0;
function c(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`); }
}

const ME = { instanceId: "mgr-a", processEpoch: 3 };
const RESTARTED_ME = { instanceId: "mgr-a", processEpoch: 4 };  // same identity, new incarnation
const OTHER = { instanceId: "mgr-b", processEpoch: 1 };
const ADDR = { nameToken: "worker-7", lifecycleUid: "u_abc" };
const ASKER: EffectAsker = { executor: ME, attemptId: "att-1" };

const row = (phase: string, exec = ME, attemptId = "att-1"): GoalEffRow => parseGoalEff({
  v: 1, executor: exec, attemptId, ts: 1, phase,
  ...(phase === "claimed" ? {} : { addr: ADDR }),
});

const act = (r: GoalEffRow | null, a: EffectAsker = ASKER) => decideEffect(r, a).action;

console.log("\n── the ABSENT row: an unclaimed goal is not an ambiguous one ──");
c("no row at all → CLAIM, never stand-down", act(null) === "claim", decideEffect(null, ASKER));

console.log("\n── OWN nonce, pre-launch: the 2a-i direction, EXACTLY ONE ──");
c("our own nonce at `claimed` → LAUNCH (our reply was dropped, not our claim)",
  act(row("claimed")) === "launch", decideEffect(row("claimed"), ASKER));

console.log("\n── FOREIGN nonce: the 2a-ii direction, EXACTLY ZERO ──");
c("a different executor's row → STAND DOWN",
  act(row("claimed", OTHER)) === "stand-down", decideEffect(row("claimed", OTHER), ASKER));
c("our executor but a different attemptId → STAND DOWN",
  act(row("claimed", ME, "att-2")) === "stand-down", decideEffect(row("claimed", ME, "att-2"), ASKER));

// THE PAIR ABOVE IS THE WHOLE ARGUMENT. The two cells demand OPPOSITE outcomes from rows that
// differ in one field, so neither the fail-closed implementation nor the fail-open one can pass
// both. `≤ 1` is a derived property of the pair and is deliberately not what is asserted.
c("the own/foreign pair cannot both be satisfied by one degenerate rule",
  act(row("claimed")) !== act(row("claimed", ME, "att-2")));

console.log("\n── an identity is not an incarnation ──");
c("the SAME instanceId at a different processEpoch is FOREIGN",
  act(row("claimed", RESTARTED_ME)) === "stand-down", decideEffect(row("claimed", RESTARTED_ME), ASKER));
c("and the asker restarted is equally foreign to its predecessor's row",
  act(row("claimed", ME), { executor: RESTARTED_ME, attemptId: "att-1" }) === "stand-down");
// Paired against the positive so the epoch check cannot be satisfied by refusing everything.
c("while the exact incarnation still PROCEEDS", act(row("claimed", ME)) === "launch");

console.log("\n── `launching` is UNDECIDABLE from the row, and says so ──");
c("our own nonce at `launching` → SETTLE-UNCERTAIN, neither launch nor stand-down",
  act(row("launching")) === "settle-uncertain", decideEffect(row("launching"), ASKER));
// The three outcomes are distinct, which is what stops "uncertain" collapsing into either
// neighbour. A design that returned `launch` here double-launches; one that returned `stand-down`
// abandons a goal that may be half-built. Both are wrong in opposite directions.
c("settle-uncertain is a THIRD outcome, not a synonym for either neighbour",
  act(row("launching")) !== act(row("claimed")) && act(row("launching")) !== act(row("claimed", OTHER)));

console.log("\n── already launched: finish the bookkeeping, never the work ──");
c("our own nonce at `launched` → COMPLETE, not launch",
  act(row("launched")) === "complete", decideEffect(row("launched"), ASKER));
c("and COMPLETE is not LAUNCH — the second process is exactly what the election prevents",
  act(row("launched")) !== act(row("claimed")));

console.log("\n── terminal: a settled row is finished ──");
c("`settled` → ACK the redelivery", act(row("settled")) === "ack", decideEffect(row("settled"), ASKER));
c("`settled` is terminal even for a FOREIGN row (nothing is owed either way)",
  act(row("settled", OTHER)) === "ack");

console.log("\n── the outcome set is exhausted, and every case names a DIFFERENT action ──");
const seen = new Set([
  act(null), act(row("claimed")), act(row("claimed", OTHER)),
  act(row("launching")), act(row("launched")), act(row("settled")),
]);
c("six representative cases produce six DISTINCT actions", seen.size === 6, [...seen]);

console.log(`\nENDPOINT EFFECTS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exitCode = 1;
