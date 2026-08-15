/**
 * The delivery supervision guard, driven directly.
 *
 * WHY THESE CELLS ARE NOT LIVE. The guard's own failure states are states about the GUARD, not about
 * the daemon: a guard that has never run, a guard whose last look is hours old because the guard
 * itself died, and a clock that moved backwards. A live broker cannot be made to sit still in any of
 * them, and waiting an hour to construct "an hour stale" would test the clock rather than the code.
 * The live suite (`smoke:delivery-health-live`) proves the PROBE classifies a real daemon correctly
 * — gone, wedged, serving; these prove the GUARD is entitled to what it says about a probe result.
 * Neither substitutes for the other, and what is NOT covered here is whether a real daemon produces
 * these health values at all — that is the live suite's job, named rather than implied by a green.
 *
 * THE LOAD-BEARING DISTINCTION, asserted as a property rather than case-by-case: no output of this
 * module may read as "fine" unless an affirmative round-trip was established AND the reading is
 * current. "The daemon is down" and "I cannot tell you whether the daemon is down" must never render
 * the same, because an operator acts on them differently.
 *
 * Run: pnpm exec tsx bin/smoke/delivery-guard.smoke.ts
 */
import {
  guardReport,
  renderGuard,
  observeOnce,
  type GuardObservation,
} from "../../implementations/cli/src/lib/delivery-guard.js";
import type { DeliveryHealth } from "../../packages/core/src/health.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

const AT = 1_700_000_000_000;
const MAX_AGE = 30_000;

const serving: DeliveryHealth = {
  serving: true,
  incarnation: { value: "daemon-abc", source: "responder-roundtrip", observedAt: AT, ageMs: 0 },
  respondedIn: { value: 12, source: "responder-roundtrip", observedAt: AT, ageMs: 0 },
  lastHeartbeat: { value: AT - 5_000, source: "lease-kv", observedAt: AT, ageMs: 5_000 },
};
/** The incident's own signature: a present-but-wedged daemon. */
const noResponder: DeliveryHealth = {
  serving: false,
  refusal: { condition: "no-responder", shard: 0, deadlineMs: 3_000, detail: "no answer within the deadline" },
};
const refusedRead: DeliveryHealth = {
  serving: false,
  refusal: { condition: "refused", read: "delivery lease shard 0", detail: "not permitted" },
};

console.log("\ndelivery-guard — the guard's own failure states, constructed\n");

// ---- no-observation: a guard that has never completed a check.
const never = guardReport(undefined, AT, MAX_AGE);
check("no-observation: a guard that never ran does NOT report", never.reporting === false);
check("no-observation: and it names that condition specifically",
  !never.reporting && never.condition === "no-observation");
check("no-observation: its detail says this is not a statement about the daemon",
  !never.reporting && never.condition === "no-observation" && /not a statement about the daemon/.test(never.detail));

// ---- THE CENTRAL DISTINCTION: a CURRENT reading of a DEAD daemon still reports.
// `reporting: true` means "this is what I see right now", never "everything is fine". A guard that
// refused to report a dead daemon would be unable to tell anyone the daemon was dead.
const deadNow = guardReport({ health: noResponder, observedAt: AT }, AT + 1_000, MAX_AGE);
check("a CURRENT reading of a DEAD daemon still REPORTS — the guard can say the daemon is down",
  deadNow.reporting === true);
check("and that report carries serving:false, so 'reporting' is never mistaken for 'healthy'",
  deadNow.reporting && deadNow.health.serving === false);
check("and it carries the age of the observation it is reporting",
  deadNow.reporting && deadNow.ageMs === 1_000);

// ---- guard-stale: the guard itself stopped looking. THIS IS THE INCIDENT ONE LEVEL UP.
const stale = guardReport({ health: serving, observedAt: AT }, AT + MAX_AGE + 1, MAX_AGE);
check("guard-stale: a reading past the freshness bound does NOT report as current", stale.reporting === false);
check("guard-stale: and it names that condition specifically",
  !stale.reporting && stale.condition === "guard-stale");
check("guard-stale: the stale reading was SERVING, and it is STILL refused — the guard's own silence outranks a good last look",
  !stale.reporting && stale.condition === "guard-stale" && stale.last.health.serving === true);
check("guard-stale: it carries the age and the bound it exceeded, not just the fact that it did",
  !stale.reporting && stale.condition === "guard-stale" && stale.ageMs === MAX_AGE + 1 && stale.maxAgeMs === MAX_AGE);

// ---- INVERSE CONTROL for the boundary: exactly at the bound is still current.
// Without this, `guard-stale` could be firing for every input and the cells above would not notice.
const atBound = guardReport({ health: serving, observedAt: AT }, AT + MAX_AGE, MAX_AGE);
check("guard-stale inverse control: exactly AT the bound still reports — the refusal is bounded, not universal",
  atBound.reporting === true);

// ---- guard-clock-fault: the age is NOT knowable, and is NOT clamped to zero.
// This lane already shipped `Math.max(0, ...)` in health.ts, which made arbitrarily stale evidence
// report `ageMs: 0` — the value a live round-trip produces — and defeated the staleness gate.
const backwards = guardReport({ health: serving, observedAt: AT }, AT - 5_000, MAX_AGE);
check("guard-clock-fault: a backwards clock does NOT report", backwards.reporting === false);
check("guard-clock-fault: and it names that condition rather than lease-stale or no-observation",
  !backwards.reporting && backwards.condition === "guard-clock-fault");
check("guard-clock-fault: THE AGE IS NOT CLAMPED TO ZERO — a clamp would render stale evidence as fresh",
  !backwards.reporting && backwards.condition === "guard-clock-fault" && backwards.skewMs === 5_000);

// ---- observeOnce: a check that CANNOT COMPLETE still produces an observation.
// "I looked and could not complete the read" and "I never looked" are different facts; collapsing
// the first into the second would make a guard whose every check errors look freshly started.
const threw = await observeOnce({
  check: () => Promise.reject(new Error("bucket not found")),
  now: () => AT,
});
check("a health read that CANNOT COMPLETE still yields an observation, not an absence",
  threw.observedAt === AT);
check("and that observation is a NAMED refusal, not a swallowed error",
  threw.health.serving === false && threw.health.refusal.condition === "refused");
check("and it carries the underlying detail rather than discarding it",
  !threw.health.serving && /bucket not found/.test(threw.health.refusal.detail));

const ok = await observeOnce({ check: () => Promise.resolve(serving), now: () => AT });
check("observeOnce inverse control: a completing check yields the health it produced",
  ok.health.serving === true && ok.observedAt === AT);

// ---- THE RENDERING PROPERTY, asserted over EVERY state rather than case-by-case.
const everyState: GuardObservation[] = [
  { health: serving, observedAt: AT },
  { health: noResponder, observedAt: AT },
  { health: refusedRead, observedAt: AT },
];
const allReports = [
  guardReport(undefined, AT, MAX_AGE),
  guardReport({ health: serving, observedAt: AT }, AT + MAX_AGE + 1, MAX_AGE),
  guardReport({ health: serving, observedAt: AT }, AT - 5_000, MAX_AGE),
  ...everyState.map((o) => guardReport(o, AT + 100, MAX_AGE)),
];
check("every state renders a non-empty line", allReports.every((r) => renderGuard(r).length > 0));
// `.every` over a non-empty set: `allReports` is asserted non-empty first, since `.every` over an
// empty set passes vacuously and would make this property meaningless.
check("the property set is NON-EMPTY, so the .every assertions above are not vacuous", allReports.length === 6);
// PINNING THE WHOLE SET IS NOT ENOUGH. The assertions below run over FILTERED PARTITIONS, and a
// partition can empty out while `allReports.length` stays 6 — if `reporting` ever became
// unconditionally true, the two NON-reporting properties would pass over an empty set and this file
// would go green while asserting nothing about the states it exists to police. Each partition is
// therefore pinned to its own size before any `.every()` over it is trusted.
const nonReporting = allReports.filter((r) => !r.reporting);
const reporting = allReports.filter((r) => r.reporting);
check("the NON-reporting partition is non-empty and pinned", nonReporting.length === 3);
check("the REPORTING partition is non-empty and pinned", reporting.length === 3);
check("the two partitions exhaust the set — no state escapes both properties",
  nonReporting.length + reporting.length === allReports.length);
check("NO rendering contains a bare 'unknown' — a reader takes unknown for fine",
  allReports.every((r) => !/\bunknown\b/i.test(renderGuard(r))));
check("every NON-reporting state renders a line saying health was NOT established",
  nonReporting.every((r) => /NOT ESTABLISHED/.test(renderGuard(r))));
check("no NON-reporting state renders as if it were current",
  nonReporting.every((r) => !/^\[observed/.test(renderGuard(r))));
check("the stale render SHOWS its held reading but marks it NOT current",
  /is NOT current/.test(renderGuard(guardReport({ health: serving, observedAt: AT }, AT + MAX_AGE + 1, MAX_AGE))));
check("every REPORTING state leads with the age of its observation",
  reporting.every((r) => /^\[observed \d+ms ago\]/.test(renderGuard(r))));

console.log(
  fail === 0
    ? `\nDELIVERY-GUARD SMOKE OK ✅  (${pass} passed, ${fail} failed)\n`
    : `\nDELIVERY-GUARD SMOKE FAILED ❌  (${pass} passed, ${fail} failed)\n`,
);
if (fail > 0) process.exitCode = 1;
if (pass === 0) {
  console.error("NOTHING WAS MEASURED — 0 cells executed. Reporting this as a decline, not a pass.");
  process.exitCode = 3;
}
