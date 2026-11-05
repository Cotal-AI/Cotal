/**
 * delivery watchdog-evidence smoke, the lease decision and the loop-lag meter the daemon's exits
 * rest on (#1318), graded branch by branch.
 *
 * WHY A PURE SUITE EXISTS ALONGSIDE THE LIVE ONE. `delivery-broker-coupling` spawns a real daemon
 * against a real broker and is the right place to prove the two end-to-end outcomes. It is the
 * wrong place to prove COVERAGE, because each cell there costs seconds of wall clock and depends on
 * the host being able to schedule a process, the very condition under test. So the end-to-end
 * suite grades the two outcomes and this one grades every branch of the helpers behind them, from
 * literals, in milliseconds, on any host.
 *
 * REFUSING CASE PER ACCEPTING BRANCH. `leaseAction` has four branches and `mayServeOn` two; each is
 * asserted both where it SHOULD fire and where it must NOT, with the two cases differing in exactly
 * one piece of evidence. Counting one case per bug rather than one per branch is how a green probe
 * hides a live hole.
 *
 * Run: pnpm smoke:delivery-watchdog-evidence   (pure; no broker, no network, no spawned process)
 */
import {
  leaseAction,
  mayServeOn,
  LoopLagMeter,
  type LeaseReading,
} from "../src/watchdog.js";
import { defaultProbeTimeoutMs } from "@cotal-ai/core";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

console.log("\nM. the probe budget is the transport's own");
// `isReachable` gives a ws(s) broker 5s and a TCP broker 1s, because a ws broker rides an HTTPS
// edge where TLS + upgrade + INFO + auth routinely exceeds a second.
check("M6 the probe budget is the transport's own: ws gets 5s, tcp gets 1s",
  defaultProbeTimeoutMs("wss://edge.example/nats") === 5000 && defaultProbeTimeoutMs("nats://127.0.0.1:4222") === 1000,
  [defaultProbeTimeoutMs("wss://edge.example/nats"), defaultProbeTimeoutMs("nats://127.0.0.1:4222")]);

console.log("\nG. the lease decision, a failed renew is a question, not a verdict");
const readings: Array<[string, LeaseReading, "keep-serving" | "reacquire" | "exit"]> = [
  ["held: the key is still ours", { kind: "held", revision: 7 }, "keep-serving"],
  ["gone: the key expired under us", { kind: "gone" }, "reacquire"],
  ["taken: another daemon holds it", { kind: "taken", by: "other.delivery" }, "exit"],
  ["unknown: the broker could not be asked", { kind: "unknown", why: "timeout" }, "keep-serving"],
];
for (const [name, reading, expected] of readings)
  check(`G1 ${name} -> ${expected}`, leaseAction(reading) === expected, leaseAction(reading));
// The pairs that matter, stated as refusals rather than inferred from the table above.
check("G2 REFUSES to exit on `gone`, an expired key with no other holder is repairable", leaseAction({ kind: "gone" }) !== "exit");
check("G3 REFUSES to exit on `unknown`, an unanswerable question is not a negative answer", leaseAction({ kind: "unknown", why: "no responders" }) !== "exit");
check("G4 REFUSES to exit on `held`, our own key at a moved revision is not a takeover", leaseAction({ kind: "held", revision: 0 }) !== "exit");
check("G5 STILL exits on `taken`, the single-holder guarantee is preserved", leaseAction({ kind: "taken", by: "x" }) === "exit");
// The measured incident's exact message shape: the renew failed with `wrong last sequence: 0`,
// which means the key was GONE, not held by anyone. Under the shipped code that exited.
check("G6 the incident's own case (wrong last sequence: 0 -> key gone) does not exit", leaseAction({ kind: "gone" }) === "reacquire");

const INTERVAL_MS = 2_000;
console.log("\nH. the lag meter, it measures scheduling, and only scheduling");
const meter = new LoopLagMeter(INTERVAL_MS);
check("H1 the first firing has no gap to measure and contributes nothing", meter.tick(1_000) === 0 && meter.starvedMsWithin(Infinity) === 0);
check("H2 an on-time firing contributes no lag", meter.tick(1_000 + INTERVAL_MS) === 0 && meter.starvedMsWithin(Infinity) === 0);
// A 30s gap on a 2s interval: 28s of it is time this process was not on the runqueue.
check("H3 a 30s gap on a 2s interval reports 28s of lag", meter.tick(1_000 + INTERVAL_MS + 30_000) === 28_000);
check("H3b and it accumulates across firings", meter.starvedMsWithin(Infinity) === 28_000, meter.starvedMsWithin(Infinity));
// A backwards clock must not credit the process with time it actually had.
const backwards = new LoopLagMeter(INTERVAL_MS);
backwards.tick(10_000);
check("H4 a backwards clock step contributes zero lag, never negative", backwards.tick(5_000) === 0 && backwards.starvedMsWithin(Infinity) === 0);
// Positive evidence restarts the budget; old lag cannot excuse a later outage.
const reset = new LoopLagMeter(INTERVAL_MS);
reset.tick(0);
reset.tick(30_000);
check("H5 lag accrued before positive evidence is discarded on reset", reset.starvedMsWithin(Infinity) === 28_000 && (reset.reset(), reset.starvedMsWithin(Infinity) === 0));
check("H6 and measurement continues after a reset rather than restarting blind", reset.tick(60_000) === 28_000);

check("H7 the removed probe has no credit entry point", !("credit" in meter));
check("H8 the unused unbounded lag getter is absent", !("starvedMs" in meter));
const disjoint = new LoopLagMeter(250);
for (const now of [0, 2_250, 5_000]) disjoint.tick(now);
check("H9 disjoint tick stalls accumulate without charging the interval between them",
  disjoint.starvedMsWithin(Infinity) === 4_500, disjoint.starvedMsWithin(Infinity));
// The consumer measures elapsed wall time too. A backward step can make later tick charges overlap
// earlier ones; retaining their union avoids subtracting the same wall-clock span twice.
const overlapping = new LoopLagMeter(250);
const charges = [0, 10_250, 250, 10_500].map(now => overlapping.tick(now));
check("H10 backward-step tick charges retain their wall-clock union, not their scalar sum",
  charges.join(",") === "0,10000,0,10000" && overlapping.starvedMsWithin(Infinity) === 10_250,
  { charges, union: overlapping.starvedMsWithin(Infinity) });
for (let i = 0; i < 20; i++) { overlapping.tick(250); overlapping.tick(10_500); }
check("H11 repeated backward steps do not charge the same wall-clock interval again",
  overlapping.starvedMsWithin(Infinity) === 10_250, overlapping.starvedMsWithin(Infinity));
overlapping.reset();
overlapping.tick(10_750);
overlapping.tick(11_250);
check("H12 reset discards the old union while keeping the firing baseline",
  overlapping.starvedMsWithin(Infinity) === 250, overlapping.starvedMsWithin(Infinity));

// ── N. MAY THIS PROCESS SERVE?, the quiesce gate, which is NOT the stay-alive gate ─────────────
//
// A REVIEWER'S FINDING, AND A REGRESSION THIS BRANCH INTRODUCED. Turning a failed renew from a
// verdict into a question is right, but the daemon asked the question while still bound: fan-out,
// the inbox reader and both delivery control responders stayed up across the read-then-create
// arbitration. Pre-fix there was no such window, because a failed renew went straight to shutdown.
// So the repair traded an availability bug for a correctness one, two daemons briefly serving one
// durable, and that trade is not acceptable.
//
// `mayServeOn` is the second gate. Every cell below is stated against `leaseAction` on the SAME
// reading, because the whole content of this seam is that the two disagree: the process may live on
// a reading that does not entitle it to serve.
console.log("\nN. may this process serve on this reading, which is a stricter question than may it live");
check("N1 `held` is the one reading that is proof of ownership: serve",
  mayServeOn({ kind: "held", revision: 7 }) === true);
check("N2 `unknown` REFUSES to serve, not being able to ask is not permission to act",
  mayServeOn({ kind: "unknown", why: "no responders" }) === false);
check("N3 and `unknown` nonetheless keeps the PROCESS alive, the two gates differ here on purpose",
  leaseAction({ kind: "unknown", why: "no responders" }) === "keep-serving");
check("N4 `gone` REFUSES to serve, the arbitrating create has not happened yet",
  mayServeOn({ kind: "gone" }) === false);
check("N5 and `gone` still repairs rather than exits, again the gates differ",
  leaseAction({ kind: "gone" }) === "reacquire");
check("N6 `taken` REFUSES to serve, and here the two gates agree",
  mayServeOn({ kind: "taken", by: "other" }) === false && leaseAction({ kind: "taken", by: "other" }) === "exit");
// THE SHAPE OF THE GATE, not four remembered answers: exactly one of the four readings admits
// serving. A widening that let a second one through passes N1-N6 individually and fails here.
const allReadings: LeaseReading[] = [
  { kind: "held", revision: 1 },
  { kind: "gone" },
  { kind: "taken", by: "other" },
  { kind: "unknown", why: "timeout" },
];
check("N7 exactly ONE of the four readings admits serving",
  allReadings.filter(mayServeOn).length === 1, allReadings.filter(mayServeOn));
// The incident's own reading. `wrong last sequence: 0` re-read as a key that is simply GONE: the
// daemon survives it (that is #1318) and must go quiet until its create is accepted.
check("N8 the incident's reading keeps the daemon alive AND stops it serving until the create wins",
  leaseAction({ kind: "gone" }) !== "exit" && mayServeOn({ kind: "gone" }) === false);
// And the strictness has a direction: every reading that admits serving must also admit living.
// A gate that let a process serve on a reading it should die on would be the split-brain inverted.
check("N9 nothing may serve that must exit",
  allReadings.every((r) => !mayServeOn(r) || leaseAction(r) !== "exit"));

// The health consumer subtracts lag from elapsed time, so reads remain bounded even when a clock
// adjustment or a reset-spanning tick makes that comparison span shorter than the measured lag.
const bounded = new LoopLagMeter(INTERVAL_MS);
bounded.tick(0);
bounded.tick(32_000);
check("I3 the lag budget is clamped to a nonnegative comparison span",
  bounded.starvedMsWithin(-1) === 0 && bounded.starvedMsWithin(0) === 0 && bounded.starvedMsWithin(15_000) === 15_000);
check("I4 a comparison span longer than the lag retains the remaining unstarved time",
  50_000 - bounded.starvedMsWithin(50_000) === 20_000);

const EXPECTED_CELLS = 34;
check(`every cell ran (${EXPECTED_CELLS} before this sentinel)`, pass + fail === EXPECTED_CELLS, pass + fail);

console.log(`\nDELIVERY-WATCHDOG-EVIDENCE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
