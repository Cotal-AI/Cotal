/**
 * delivery watchdog-evidence smoke — the decision that separates "the broker is gone" from "this
 * process did not get scheduled" (#1318), graded branch by branch.
 *
 * WHY A PURE SUITE EXISTS ALONGSIDE THE LIVE ONE. `delivery-broker-coupling` spawns a real daemon
 * against a real broker and is the right place to prove the two end-to-end outcomes. It is the
 * wrong place to prove COVERAGE, because each cell there costs seconds of wall clock and depends on
 * the host being able to schedule a process — the very condition under test. So the end-to-end
 * suite grades the two outcomes and this one grades every branch of the predicate behind them, from
 * literals, in milliseconds, on any host.
 *
 * REFUSING CASE PER ACCEPTING BRANCH. `brokerGoneVerdict` has five outcomes reached through six
 * branches and `leaseAction` has four; each is asserted both where it SHOULD fire and where it must
 * NOT, with the two cases differing in exactly one piece of evidence. Counting one case per bug
 * rather than one per branch is how a green probe hides a live hole: the pre-fix tree would satisfy
 * "exits when the broker is killed" perfectly well.
 *
 * Run: pnpm smoke:delivery-watchdog-evidence   (pure; no broker, no network, no spawned process)
 */
import {
  brokerGoneVerdict,
  classifyProbe,
  leaseAction,
  LoopLagMeter,
  PROBE_BUDGET_MS,
  PROBE_INTERVAL_MS,
  PROBE_LATE_FACTOR,
  type BrokerWatchEvidence,
  type LeaseReading,
} from "../src/watchdog.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

/** The daemon's shipped defaults, so the cells below grade the real configuration. */
const WINDOW = 15_000;
const NEEDED = 4; // ceil(15000 / 2000 / 2)
const BACKSTOP = 60_000; // WINDOW * 4
const evidence = (over: Partial<BrokerWatchEvidence> = {}): BrokerWatchEvidence => ({
  msSinceLastReachable: 0,
  starvedMs: 0,
  completedNegatives: 0,
  transportConnected: false,
  windowMs: WINDOW,
  requiredNegatives: NEEDED,
  backstopMs: BACKSTOP,
  ...over,
});

console.log("\nA. the exit branch — a genuinely dead broker still ends the daemon");
// ACCEPTING: unstarved time past the window AND enough probes that ran and refused.
check(
  "A1 exits: 20s unstarved with 4 completed negatives is broker-gone",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, completedNegatives: 4 })).exit === true,
);
check(
  "A1b and it names the reason broker-gone, not merely 'exit'",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, completedNegatives: 4 })).reason === "broker-gone",
);
// The true-positive path must not be SLOWED by the repair: the first moment both conjuncts hold is
// the moment it exits, so a dead broker costs the same window it always did.
check(
  "A2 exits at the boundary: window+1ms with exactly the required negatives",
  brokerGoneVerdict(evidence({ msSinceLastReachable: WINDOW + 1, completedNegatives: NEEDED })).exit === true,
);

console.log("\nB. the starvation branch — measured local lag is credited, and does NOT exit");
// REFUSING case for A, differing ONLY in starvedMs. Same elapsed time, same completed negatives.
// This is the reported incident: load 311 on 12 cores, broker up continuously for 7.3 days.
const starved = brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, starvedMs: 19_000, completedNegatives: 4 }));
check("B1 does NOT exit: the same 20s window with 19s of measured loop lag", starved.exit === false, starved);
check("B1b and it is diagnosed as starved, not as insufficient evidence", starved.reason === "starved", starved);
// The credit is not unlimited: lag that does not cover the window leaves a real broker-gone verdict.
check(
  "B2 exits anyway: 40s elapsed with only 5s of lag still clears the window",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 40_000, starvedMs: 5_000, completedNegatives: 4 })).exit === true,
);
// Boundary: lag exactly covering the excess is still starvation, not a verdict about the server.
check(
  "B3 does NOT exit at the boundary: unstarved time equal to the window",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, starvedMs: 5_000, completedNegatives: 9 })).exit === false,
);

console.log("\nC. the evidence branch — elapsed time alone is never a verdict");
// REFUSING case for A, differing ONLY in completedNegatives. THIS IS THE DEFECT IN ITS PUREST
// FORM: the window aged while no probe completed, because the process was not scheduled to run one.
const thin = brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, completedNegatives: 0 }));
check("C1 does NOT exit: 20s elapsed with zero completed probes", thin.exit === false, thin);
check("C1b and it says so: insufficient-evidence", thin.reason === "insufficient-evidence", thin);
check(
  "C2 does NOT exit one short of the requirement (3 of 4)",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, completedNegatives: NEEDED - 1 })).exit === false,
);
check(
  "C3 DOES exit on the requirement exactly (4 of 4) — the counter is a floor, not a moving target",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, completedNegatives: NEEDED })).exit === true,
);

console.log("\nD. the reachable branch — positive evidence outranks every other signal");
check(
  "D1 does NOT exit inside the window, however many probes failed",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 1_000, completedNegatives: 99 })).exit === false,
);
check(
  "D1b and the reason is reachable, not insufficient-evidence",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 1_000, completedNegatives: 99 })).reason === "reachable",
);
// REFUSING case: one millisecond past the window is no longer 'reachable'.
check(
  "D2 window+1ms is NOT reported reachable",
  brokerGoneVerdict(evidence({ msSinceLastReachable: WINDOW + 1, completedNegatives: 99 })).reason !== "reachable",
);
check(
  "D3 the boundary itself (exactly the window) is still reachable",
  brokerGoneVerdict(evidence({ msSinceLastReachable: WINDOW, completedNegatives: 99 })).reason === "reachable",
);

console.log("\nE. the transport branch — an open socket to that broker is evidence the broker is there");
// ACCEPTING: the probe cannot complete a fresh handshake, but our standing connection to the same
// address is open. That is a statement about this process's ability to ask.
const transportLive = brokerGoneVerdict(evidence({
  msSinceLastReachable: 20_000, completedNegatives: 9, transportConnected: true,
}));
check("E1 does NOT exit while this daemon's own connection to the broker is open", transportLive.exit === false, transportLive);
check("E1b and it says which signal saved it: transport-live", transportLive.reason === "transport-live", transportLive);
// REFUSING case, differing ONLY in transportConnected. A closed transport removes the excuse.
check(
  "E2 the same evidence with the transport CLOSED does exit",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 20_000, completedNegatives: 9, transportConnected: false })).exit === true,
);
// REFUSING case for PRECEDENCE: a live transport must not mask the `reachable` reading. The two are
// both non-exits, so only the named reason distinguishes them, and a predicate that reported
// `transport-live` for a broker that answered a probe one second ago would be hiding its own
// ordering.
check(
  "E2b inside the window the reading is still reachable, not transport-live",
  brokerGoneVerdict(evidence({ msSinceLastReachable: 1_000, transportConnected: true })).reason === "reachable",
);
// REFUSING case for the credit's scope: the transport credit is NOT bounded by the backstop, and
// that is deliberate rather than an oversight — an open connection to the broker is ongoing
// positive evidence, and the moment the broker dies the flag goes false and every bound applies
// again. The refusing half is E2 above: same evidence, transport closed, exits.
check(
  "E3 a live transport survives even past the backstop — an open socket is evidence, not an excuse",
  brokerGoneVerdict(evidence({ msSinceLastReachable: BACKSTOP + 1, completedNegatives: 99, transportConnected: true })).exit === false,
);
check(
  "E4 and with the transport closed that same past-backstop evidence exits",
  brokerGoneVerdict(evidence({ msSinceLastReachable: BACKSTOP + 1, completedNegatives: 99, transportConnected: false })).exit === true,
);

console.log("\nF. the backstop branch — the starvation credit can never become an unbounded excuse");
// ACCEPTING: with the transport down, past the backstop nothing excuses the absence of positive
// evidence. This guards against the failure mode the fix could otherwise introduce — a daemon that
// outlives its broker — which is worse than the defect being repaired.
check(
  "F1 exits past the backstop even with zero completed probes and full starvation credit",
  brokerGoneVerdict(evidence({ msSinceLastReachable: BACKSTOP + 1, starvedMs: BACKSTOP, completedNegatives: 0 })).exit === true,
);
// REFUSING case: one millisecond earlier, the same evidence is still starvation.
const justInside = brokerGoneVerdict(evidence({ msSinceLastReachable: BACKSTOP, starvedMs: BACKSTOP, completedNegatives: 0 }));
check("F2 does NOT exit at the backstop boundary itself", justInside.exit === false, justInside);
check("F2b and the diagnosis there is still starvation", justInside.reason === "starved", justInside);

console.log("\nJ. the probe classifier — what a single answer established, given when it arrived");
// This is the signal that makes the third mechanism visible: `isReachable` flattens a starved
// client and a dead server to the same `false`, but they differ in WHEN the answer arrives relative
// to the probe's own deadline.
const LATE = PROBE_BUDGET_MS * PROBE_LATE_FACTOR;
// ACCEPTING: a refusal inside its own budget is evidence about the server.
check("J1 an immediate false (a refused port) counts as a negative",
  classifyProbe(false, 1).counts === "negative");
check("J2 a false at the budget (a blackhole its own deadline ended) still counts as a negative",
  classifyProbe(false, PROBE_BUDGET_MS).counts === "negative");
check("J3 and at the very edge of the late ceiling it is still a negative",
  classifyProbe(false, LATE).counts === "negative");
// REFUSING case, differing ONLY in elapsed time: an answer far past its own deadline had that
// deadline enforced against this process, not against the server. The triage for #1318 measured
// exactly this: a false at 2554ms on a 1000ms budget with the broker alive either side of it.
const late = classifyProbe(false, 2554);
check("J4 a false at 2554ms on a 1000ms budget is STARVED, not a negative", late.counts === "starved", late);
check("J4b and it reports how late it was, so the lag can be credited",
  late.counts === "starved" && late.lateBy === 2554 - PROBE_BUDGET_MS, late);
// REFUSING case for the positive branch: lateness must NEVER weaken a yes. A slow yes still needed
// a server to say it, and refusing late positives would leave a starved daemon unable to ever clear
// its own window — the defect again with the sign flipped.
check("J5 a POSITIVE is believed however late it arrives", classifyProbe(true, 60_000).counts === "positive");
check("J5b and an on-time positive is the same reading", classifyProbe(true, 5).counts === "positive");
// A probe that rejected is an unanswered question, distinct from every answer above.
check("J6 a rejected probe is incomplete, not a negative", classifyProbe(undefined, 10).counts === "incomplete");
check("J6b and lateness does not turn an incomplete into a starved reading",
  classifyProbe(undefined, 60_000).counts === "incomplete");

console.log("\nG. the lease decision — a failed renew is a question, not a verdict");
const readings: Array<[string, LeaseReading, "keep-serving" | "reacquire" | "exit"]> = [
  ["held: the key is still ours", { kind: "held", revision: 7 }, "keep-serving"],
  ["gone: the key expired under us", { kind: "gone" }, "reacquire"],
  ["taken: another daemon holds it", { kind: "taken", by: "other.delivery" }, "exit"],
  ["unknown: the broker could not be asked", { kind: "unknown", why: "timeout" }, "keep-serving"],
];
for (const [name, reading, expected] of readings)
  check(`G1 ${name} -> ${expected}`, leaseAction(reading) === expected, leaseAction(reading));
// The pairs that matter, stated as refusals rather than inferred from the table above.
check("G2 REFUSES to exit on `gone` — an expired key with no other holder is repairable", leaseAction({ kind: "gone" }) !== "exit");
check("G3 REFUSES to exit on `unknown` — an unanswerable question is not a negative answer", leaseAction({ kind: "unknown", why: "no responders" }) !== "exit");
check("G4 REFUSES to exit on `held` — our own key at a moved revision is not a takeover", leaseAction({ kind: "held", revision: 0 }) !== "exit");
check("G5 STILL exits on `taken` — the single-holder guarantee is preserved", leaseAction({ kind: "taken", by: "x" }) === "exit");
// The measured incident's exact message shape: the renew failed with `wrong last sequence: 0`,
// which means the key was GONE, not held by anyone. Under the shipped code that exited.
check("G6 the incident's own case (wrong last sequence: 0 -> key gone) does not exit", leaseAction({ kind: "gone" }) === "reacquire");

console.log("\nH. the lag meter — it measures scheduling, and only scheduling");
const meter = new LoopLagMeter(PROBE_INTERVAL_MS);
check("H1 the first firing has no gap to measure and contributes nothing", meter.tick(1_000) === 0 && meter.starvedMs === 0);
check("H2 an on-time firing contributes no lag", meter.tick(1_000 + PROBE_INTERVAL_MS) === 0 && meter.starvedMs === 0);
// A 30s gap on a 2s interval: 28s of it is time this process was not on the runqueue.
check("H3 a 30s gap on a 2s interval reports 28s of lag", meter.tick(1_000 + PROBE_INTERVAL_MS + 30_000) === 28_000);
check("H3b and it accumulates across firings", meter.starvedMs === 28_000, meter.starvedMs);
// REFUSING case: a timer can fire late, never early. A backwards clock must not CREDIT the process
// with time it actually had, which would make a real outage look like starvation.
const backwards = new LoopLagMeter(PROBE_INTERVAL_MS);
backwards.tick(10_000);
check("H4 a backwards clock step contributes zero lag, never negative", backwards.tick(5_000) === 0 && backwards.starvedMs === 0);
// REFUSING case for accumulation: positive evidence restarts the budget, so lag from a PREVIOUS
// window cannot be spent excusing a later one.
const reset = new LoopLagMeter(PROBE_INTERVAL_MS);
reset.tick(0);
reset.tick(30_000);
check("H5 lag accrued before positive evidence is discarded on reset", reset.starvedMs === 28_000 && (reset.reset(), reset.starvedMs === 0));
check("H6 and measurement continues after a reset rather than restarting blind", reset.tick(60_000) === 28_000);

console.log("\nI. the composition the daemon actually evaluates");
// The full incident, reconstructed: a 2s interval that fired once at t=0 and next at t=45s on a
// host at load 311, with the broker up the whole time. One completed negative from the probe that
// finally ran. Under the shipped predicate this exited; it must not.
const incident = new LoopLagMeter(PROBE_INTERVAL_MS);
incident.tick(0);
incident.tick(45_000);
const incidentVerdict = brokerGoneVerdict(evidence({
  msSinceLastReachable: 45_000,
  starvedMs: incident.starvedMs,
  completedNegatives: 1,
}));
check("I1 the 2026-09-05 incident shape does NOT exit", incidentVerdict.exit === false, incidentVerdict);
check("I1b and it is reported as starvation", incidentVerdict.reason === "starved", incidentVerdict);
// The control: identical shape, except the process was scheduled normally throughout. That is a
// dead broker and it must still exit.
const healthy = new LoopLagMeter(PROBE_INTERVAL_MS);
for (let t = 0; t <= 20_000; t += PROBE_INTERVAL_MS) healthy.tick(t);
const deadBroker = brokerGoneVerdict(evidence({
  msSinceLastReachable: 20_000,
  starvedMs: healthy.starvedMs,
  completedNegatives: 10,
}));
check("I2 CONTROL: the same window on an unstarved host DOES exit", deadBroker.exit === true, deadBroker);
check("I2b and an unstarved host measures zero lag", healthy.starvedMs === 0, healthy.starvedMs);

const EXPECTED_CELLS = 53;
check(`every cell ran (${EXPECTED_CELLS} before this sentinel)`, pass + fail === EXPECTED_CELLS, pass + fail);

console.log(`\nDELIVERY-WATCHDOG-EVIDENCE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
