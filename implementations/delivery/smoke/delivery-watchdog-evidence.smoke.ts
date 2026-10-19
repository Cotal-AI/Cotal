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
// The accumulated lag, read through the daemon's own accessor with a span that never clamps it.
const starved = (m: LoopLagMeter) => m.starvedMsWithin(Number.POSITIVE_INFINITY);
console.log("\nH. the lag meter, it measures scheduling, and only scheduling");
const meter = new LoopLagMeter(INTERVAL_MS);
check("H1 the first firing has no gap to measure and contributes nothing", meter.tick(1_000) === 0 && starved(meter) === 0);
check("H2 an on-time firing contributes no lag", meter.tick(1_000 + INTERVAL_MS) === 0 && starved(meter) === 0);
// A 30s gap on a 2s interval: 28s of it is time this process was not on the runqueue.
check("H3 a 30s gap on a 2s interval reports 28s of lag", meter.tick(1_000 + INTERVAL_MS + 30_000) === 28_000);
check("H3b and it accumulates across firings", starved(meter) === 28_000, starved(meter));
// REFUSING case: a timer can fire late, never early. A backwards clock must not CREDIT the process
// with time it actually had, which would make a real outage look like starvation.
const backwards = new LoopLagMeter(INTERVAL_MS);
backwards.tick(10_000);
check("H4 a backwards clock step contributes zero lag, never negative", backwards.tick(5_000) === 0 && starved(backwards) === 0);
// REFUSING case for accumulation: positive evidence restarts the budget, so lag from a PREVIOUS
// window cannot be spent excusing a later one.
const reset = new LoopLagMeter(INTERVAL_MS);
reset.tick(0);
reset.tick(30_000);
check("H5 lag accrued before positive evidence is discarded on reset", starved(reset) === 28_000 && (reset.reset(), starved(reset) === 0));
check("H6 and measurement continues after a reset rather than restarting blind", reset.tick(60_000) === 28_000);

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

// I3-I4: THE INVARIANT THAT MAKES THE EXCUSE COHERENT, `tick` over ONE stall of known length.
const ELAPSED = 30_000;
const oneStall = new LoopLagMeter(INTERVAL_MS);
oneStall.tick(0);
oneStall.tick(ELAPSED + INTERVAL_MS);   // the timer saw the whole stall
check("I3 lag measured over one stall never exceeds the time that actually passed",
  oneStall.starvedMsWithin(ELAPSED) <= ELAPSED,
  { raw: starved(oneStall), clamped: oneStall.starvedMsWithin(ELAPSED), elapsed: ELAPSED });
// WHAT THE CLAMP GUARANTEES, stated as narrowly as it is true: the reading never exceeds the span it
// is compared against, so unstarved time is never negative. That is a weaker claim than "the
// evidence clause always fires".
const SPAN = 50_000;
const clamped = oneStall.starvedMsWithin(SPAN);
check("I4 unstarved time is never negative, so real outage can always accumulate against it",
  SPAN - clamped >= 0, { clamped, span: SPAN, unstarved: SPAN - clamped });

// 105 -> 36: the probe verdict, classifier and sampler cells left with the code they graded.
// 36 -> 28: the `credit` and span-union cells left with the code they graded.
const EXPECTED_CELLS = 28;
check(`every cell ran (${EXPECTED_CELLS} before this sentinel)`, pass + fail === EXPECTED_CELLS, pass + fail);

console.log(`\nDELIVERY-WATCHDOG-EVIDENCE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
