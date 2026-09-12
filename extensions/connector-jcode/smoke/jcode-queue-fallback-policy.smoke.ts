/**
 * A soft-interrupt timeout must not leave the automatic queue permanently unserved (#1233).
 *
 * THE DEFECT, in one sentence: every path that served the connector-managed automatic queue was
 * EDGE-triggered, and when the mid-turn handoff timed out both edges could be absent forever. The
 * live specimen was a healthy seat, 17.9h up, answering DMs in under a minute, holding 27 automatic
 * deliveries whose count was static while their age grew to 13.8 hours, with five
 * `soft interrupt failed: timeout` lines in its connector log.
 *
 * `queue-fallback.ts` is the decision the repair's level-triggered server makes, extracted so it can
 * be graded directly rather than only through a live seat, the same way `retry-policy.ts` was for
 * #790. This suite grades that decision. The DRAIN itself — messages actually arriving at a seat
 * whose soft interrupts time out — is graded end-to-end against the shipped host and a real broker
 * in `jcode-queue-fallback.smoke.ts`; a decision table proves nothing about delivery on its own and
 * this file does not claim otherwise.
 *
 * BRANCH LEDGER. `nextFallbackAction` has ten reachable branches and `fallbackStillOwed` has three.
 * Every ACCEPTING branch below is paired with a REFUSING case differing only in the one field that
 * decides it, because a suite with one case per bug rather than one per branch is how a green probe
 * hides a live hole. The pairs are named in the section headings; the count is asserted at the end
 * against the number of cells actually executed, so a deleted pair cannot pass quietly.
 *
 * Run: pnpm smoke:jcode-queue-fallback-policy
 */
import assert from "node:assert/strict";
import {
  FALLBACK_INITIAL_MS,
  FALLBACK_MAX_MS,
  fallbackStillOwed,
  nextFallbackAction,
  nextFallbackDelay,
  type FallbackState,
} from "../src/queue-fallback.js";

let pass = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  const detail = `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`;
  failures.push(detail);
  console.log(`  ✗ FAIL: ${detail}`);
};

/** A busy, healthy seat holding one unserved automatic delivery whose handoff has timed out.
 *  This IS the incident state: everything is fine except that nothing is serving the queue. */
const stalled: FallbackState = {
  stopping: false,
  reconnecting: false,
  initialized: true,
  hasSession: true,
  sessionBusy: true,
  steering: false,
  softInterruptFailed: true,
  unserved: 1,
  driveWork: true,
  consecutiveFailures: 0,
  giveUpAfter: 8,
};

console.log("\n1. THE INCIDENT: a busy seat whose soft interrupt timed out gets the fallback delivery");
{
  const d = nextFallbackAction(stalled);
  check(
    "a timed-out handoff with work unserved delivers by queued turn instead",
    d.action === "queue-turn" && d.reason === "soft-interrupt-timed-out",
    d,
  );
  // REFUSING pair: the ONLY difference is that the handoff has not failed. The fallback is a
  // fallback, not a replacement — a seat whose soft interrupts work keeps using them.
  check(
    "with the handoff healthy the same state steers instead of falling back",
    nextFallbackAction({ ...stalled, softInterruptFailed: false }).action === "steer",
    nextFallbackAction({ ...stalled, softInterruptFailed: false }),
  );
}

console.log("\n2. shutdown outranks the queue (accept: stop / refuse: not stopping)");
{
  const d = nextFallbackAction({ ...stalled, stopping: true });
  check("a stopping host disarms rather than delivering", d.action === "stop" && d.reason === "stopping", d);
  check("the identical state that is not stopping still delivers", nextFallbackAction(stalled).action === "queue-turn");
}

console.log("\n3. startup owns its own redrive (accept: wait / refuse: initialized)");
{
  const d = nextFallbackAction({ ...stalled, initialized: false });
  check("an uninitialized host waits rather than racing startup", d.action === "wait" && d.reason === "not-initialized", d);
  check("once initialized the same state delivers", nextFallbackAction(stalled).action === "queue-turn");
}

console.log("\n4. no session, nothing to deliver into (accept: wait / refuse: hasSession)");
{
  const d = nextFallbackAction({ ...stalled, hasSession: false });
  check("a host with no live session waits", d.action === "wait" && d.reason === "no-session", d);
  check("with a session the same state delivers", nextFallbackAction(stalled).action === "queue-turn");
}

console.log("\n5. a bridge replacement owns the batch (accept: wait / refuse: not reconnecting)");
{
  const d = nextFallbackAction({ ...stalled, reconnecting: true });
  check("a reconnecting host waits rather than double-delivering", d.action === "wait" && d.reason === "reconnecting", d);
  check("not reconnecting, the same state delivers", nextFallbackAction(stalled).action === "queue-turn");
}

console.log("\n6. an idle session takes the whole batch as a turn (accept: drive / refuse: busy)");
{
  const idle = { ...stalled, sessionBusy: false };
  const d = nextFallbackAction(idle);
  check("an idle session with work owed drives a turn", d.action === "drive" && d.reason === "turn-work", d);
  check("the same state while busy does not drive", nextFallbackAction(stalled).action !== "drive");
}

console.log("\n7. the #790 give-up refuses to re-drive, and never discards (accept: wait / refuse: below the bound)");
{
  const d = nextFallbackAction({ ...stalled, sessionBusy: false, consecutiveFailures: 8 });
  check("at the failure budget an idle seat stops re-driving", d.action === "wait" && d.reason === "gave-up", d);
  check(
    "one failure below the budget it still drives",
    nextFallbackAction({ ...stalled, sessionBusy: false, consecutiveFailures: 7 }).action === "drive",
  );
  // The bound paces; it must never be a reason to forget the work. `fallbackStillOwed` is what
  // keeps the server armed, and a give-up that disarmed it would re-create #1233 by another route.
  check(
    "a gave-up seat still owes its queue, so the server stays armed",
    fallbackStillOwed({ ...stalled, sessionBusy: false, consecutiveFailures: 99 }),
  );
}

console.log("\n8. one handoff at a time (accept: wait / refuse: not steering)");
{
  const inFlight = { ...stalled, softInterruptFailed: false, steering: true };
  const d = nextFallbackAction(inFlight);
  check("a steer already in flight is not raced by a second", d.action === "wait" && d.reason === "steer-in-flight", d);
  check(
    "with no steer in flight the same state steers",
    nextFallbackAction({ ...inFlight, steering: false }).action === "steer",
  );
  // The branch that can still DELIVER outranks the branch that waits. A failed handoff plus an
  // in-flight one must not resolve to `wait`, or the fallback is shadowed by the path it replaces.
  check(
    "a failed handoff beats an in-flight one rather than waiting behind it",
    nextFallbackAction({ ...stalled, steering: true }).action === "queue-turn",
  );
}

console.log("\n9. an empty ledger is not work (accept: wait / refuse: unserved > 0)");
{
  const d = nextFallbackAction({ ...stalled, unserved: 0 });
  check("a busy seat with nothing unserved waits", d.action === "wait" && d.reason === "nothing-owed", d);
  check("one unserved delivery is enough to act", nextFallbackAction({ ...stalled, unserved: 1 }).action === "queue-turn");
  const idleEmpty = nextFallbackAction({ ...stalled, sessionBusy: false, driveWork: false });
  check("an idle seat with no drive work waits", idleEmpty.action === "wait" && idleEmpty.reason === "nothing-owed", idleEmpty);
  check(
    "an idle seat with drive work drives",
    nextFallbackAction({ ...stalled, sessionBusy: false, driveWork: true }).action === "drive",
  );
}

console.log("\n10. the server stays armed while anything is owed — the property #1233 lacked");
{
  check("unserved automatic work keeps it armed", fallbackStillOwed({ ...stalled, driveWork: false, unserved: 3 }));
  check("drive work alone keeps it armed", fallbackStillOwed({ ...stalled, unserved: 0, driveWork: true }));
  check("with neither, it disarms", !fallbackStillOwed({ ...stalled, unserved: 0, driveWork: false }));
  check("shutdown disarms it even with work owed", !fallbackStillOwed({ ...stalled, stopping: true, unserved: 99 }));
  // The refusals that are TEMPORARY must not disarm: this is the exact difference between a server
  // that recovers and the edge-triggered behaviour that stranded 27 messages for 13.8 hours. Each
  // pair asserts BOTH halves — the tick refuses, AND the server stays armed — because either half
  // alone is satisfied by a state that simply does nothing.
  for (const [label, state] of [
    ["startup", { ...stalled, initialized: false }],
    ["a bridge replacement", { ...stalled, reconnecting: true }],
    ["a lost session", { ...stalled, hasSession: false }],
  ] as const) {
    const d = nextFallbackAction(state);
    check(`${label} refuses this tick but stays armed`, d.action === "wait" && fallbackStillOwed(state), {
      action: d.action,
      reason: d.reason,
      armed: fallbackStillOwed(state),
    });
  }
}

console.log("\n11. pacing grows, is ceilinged, and starts short");
{
  const d1 = nextFallbackDelay(FALLBACK_INITIAL_MS);
  check("each attempt waits longer than the last", d1 > FALLBACK_INITIAL_MS, { d1 });
  check("the first delay is short enough to recover quickly", FALLBACK_INITIAL_MS <= 5_000, { FALLBACK_INITIAL_MS });
  let d = FALLBACK_INITIAL_MS;
  for (let i = 0; i < 40; i++) d = nextFallbackDelay(d);
  check("the delay never exceeds the ceiling", d === FALLBACK_MAX_MS, { d });
  check("so a stalled seat is still re-attempted at least once a minute", FALLBACK_MAX_MS <= 60_000, { FALLBACK_MAX_MS });
}

console.log("\n12. NO branch drops a delivery");
{
  // Exhaustive over the two booleans that gate every refusal path, plus the give-up. If any
  // combination resolved to an action that discarded work, this is where it would show: there is
  // no such action in the type, and `wait` always leaves the ledger intact.
  const actions = new Set<string>();
  for (const sessionBusy of [true, false])
    for (const softInterruptFailed of [true, false])
      for (const steering of [true, false])
        for (const consecutiveFailures of [0, 8])
          actions.add(nextFallbackAction({ ...stalled, sessionBusy, softInterruptFailed, steering, consecutiveFailures }).action);
  check(
    "every reachable action either delivers or waits — none discards",
    [...actions].every((a) => a === "drive" || a === "steer" || a === "queue-turn" || a === "wait"),
    [...actions],
  );
  check("and the delivering actions are all reachable from the incident state", actions.has("queue-turn") && actions.has("steer") && actions.has("drive"), [...actions]);
}

const EXPECTED_CELLS = 35;
console.log(`\nSUITE COMPLETE: ${pass + failures.length} cells`);
console.log(`jcode queue fallback policy: ${pass} cells OK, ${failures.length} failed`);
if (pass + failures.length !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${pass + failures.length} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
}
if (failures.length) {
  assert.fail(`jcode queue fallback policy: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
