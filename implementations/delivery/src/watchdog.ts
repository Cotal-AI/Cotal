/**
 * The delivery daemon's two self-termination decisions, as PURE functions over evidence.
 *
 * Both decisions used to be taken inline from a wall clock, and a wall clock cannot tell "the
 * broker is gone" from "this process did not get scheduled". On 2026-09-05 that cost Plane-3 nine
 * minutes across two exits while `nats-server` had been up continuously for 7.3 days and was
 * listening throughout; the real condition was load 311 on 12 cores (#1318). The detector failed in
 * the direction of its own failure, and it did so exactly when delivery was most needed.
 *
 * Pulled out here for two reasons. The obvious one is that a decision expressed as a function of
 * named evidence is readable. The load-bearing one is that it becomes GRADEABLE without a broker,
 * a host under load, or a spawned process: every branch below is reachable from a literal, so each
 * ACCEPTING branch can be paired with a REFUSING case that differs only in the evidence, and a
 * mutation to any branch reddens a named cell rather than a timing-dependent end-to-end assertion.
 */

/** How often the broker watch is scheduled. The measured gap between two firings minus this is
 *  LOCAL SCHEDULER LAG: a fact about this process, not about the server. */
export const PROBE_INTERVAL_MS = 2000;

/** The deadline `isReachable` gives a non-websocket probe. Named here because the probe's own
 *  budget is the yardstick that makes a late answer legible as lateness. */
export const PROBE_BUDGET_MS = 1000;

/** How far past its own budget an answer may arrive and still be believed as a statement about the
 *  server. A probe that answers at its deadline is a normal timeout; one that answers at twice its
 *  deadline did not have that deadline enforced against the SERVER at all — it had it enforced
 *  against a process that was not running when it expired. Two rather than something larger because
 *  the measured case is 2554ms on a 1000ms budget (#1318's triage), and rather than something
 *  smaller because it must never reclassify an honest timeout on a merely busy host as starvation,
 *  which would blunt the true-positive path this repair is required to preserve. */
export const PROBE_LATE_FACTOR = 2;

/** How often the deschedule sampler wakes during a probe. Short enough to resolve the stalls that
 *  matter (tens of ms), long enough that the measurement is not itself a meaningful load. */
export const PROBE_SAMPLE_MS = 25;

/**
 * What a single probe actually established, given how long its answer took to arrive.
 *
 * THIS IS THE SIGNAL THAT MAKES THE DISTINCTION CHEAP AND LOCAL. `isReachable` flattens every
 * failure to `false`, so a starved client reads exactly like a dead server — that is the issue's
 * third mechanism and the one a wall clock cannot touch. But the two differ in a quantity the
 * daemon already has: WHEN the answer arrived relative to the deadline the probe itself set.
 *
 *   • A dead port answers ECONNREFUSED in about a millisecond.
 *   • A blackholed address answers at the budget, because the budget is what ended it.
 *   • A starved process answers whenever it is next scheduled, which is arbitrarily later — the
 *     triage for #1318 measured a false at 2554ms against a 1000ms budget with `nats-server` alive
 *     and reachable immediately before and after.
 *
 * So a negative that arrives far past its own deadline is not evidence about the server. It is
 * evidence about this process, and it is counted as such.
 */
export type ProbeEvidence =
  | { counts: "positive" }
  | { counts: "negative" }
  | { counts: "starved"; lateBy: number }
  | { counts: "incomplete" };

/**
 * Classify one probe result.
 *
 * `ok === undefined` is a probe that REJECTED rather than resolving: an unanswered question. It was
 * previously swallowed by `.catch(() => {})`, so it neither refreshed the window nor evaluated
 * anything, and silently aged the daemon toward an exit it had gathered no evidence for.
 */
export function classifyProbe(
  ok: boolean | undefined,
  elapsedMs: number,
  budgetMs: number = PROBE_BUDGET_MS,
  lateFactor: number = PROBE_LATE_FACTOR,
  descheduledDuringMs: number = 0,
): ProbeEvidence {
  if (ok === undefined) return { counts: "incomplete" };
  // A POSITIVE IS BELIEVED HOWEVER LATE IT IS. A slow yes still required a server to say it, so
  // lateness cannot turn it into anything weaker; and refusing late positives would make a starved
  // daemon unable to ever clear its own window, which is the defect again with the sign flipped.
  if (ok) return { counts: "positive" };
  const ceiling = budgetMs * lateFactor;
  // (1) THE ANSWER ARRIVED FAR PAST ITS OWN DEADLINE. The deadline was enforced against this
  // process, not against the server: a 1000ms budget that reports at 2554ms did not measure a
  // server for 2554ms, it measured a process that could not get back on the CPU to stop waiting.
  // This is the form the #1318 triage captured directly, and it needs no other instrumentation.
  if (elapsedMs > ceiling) return { counts: "starved", lateBy: elapsedMs - budgetMs };
  // (2) THE DEADLINE EXPIRED WITHOUT THE SERVER EVER GETTING THE BUDGET IT WAS PROMISED. A refusal
  // is only evidence if the server had the time to answer in. Subtracting the stretch this process
  // spent OFF the runqueue leaves what the server actually had, and the two cases separate cleanly:
  //
  //   - a genuinely dead port answers ECONNREFUSED in about a millisecond, so `elapsed` never
  //     reaches the budget at all and this clause does not apply. That is a prompt, honest negative
  //     and it must stay one, or the repair would buy availability by making a dead broker
  //     survivable — which is the failure mode worse than the defect.
  //   - a process getting short slices of CPU issues a connect, is descheduled, and its deadline
  //     timer fires the instant it is scheduled again. Wall-clock elapsed looks like a normal,
  //     prompt timeout; almost none of it was time the server was given. Judged by the clock alone
  //     this is indistinguishable from a dead server, which is exactly the confusion #1318 is about.
  //
  // Clamped to the probe's own span so a bad measurement cannot manufacture credit.
  const attributableMs = elapsedMs - Math.max(0, Math.min(descheduledDuringMs, elapsedMs));
  if (elapsedMs >= budgetMs && attributableMs < budgetMs) {
    return { counts: "starved", lateBy: elapsedMs - attributableMs };
  }
  return { counts: "negative" };
}

/**
 * Measure how long this process spends OFF the runqueue across a span, by watching a short timer's
 * own lateness.
 *
 * A timer asked to fire every `sampleMs` that instead fires `sampleMs + d` later reports `d` of
 * delay this process could not avoid: the event loop was ready and the process was not running.
 * Summed across a probe, that is the part of the probe's wall-clock that the server was never
 * actually given, which is the difference between "the server did not answer in a second" and "a
 * second passed, and the server had 40ms of it".
 *
 * This measures the same underlying condition as {@link LoopLagMeter} at a finer grain and over a
 * bounded span, which is what lets a per-probe verdict use it. It deliberately reads only the
 * clock: `/proc` sampling, `getrusage`, or cgroup pressure would all be sharper, and all of them are
 * platform-specific in a way that would make this daemon behave differently on the hosts that most
 * need it. A late timer is available everywhere the daemon runs.
 */
export class DescheduleSampler {
  private accumulated = 0;
  private last = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly sampleMs: number = PROBE_SAMPLE_MS) {}

  start(now: number = Date.now()): void {
    this.accumulated = 0;
    this.last = now;
    this.timer = setInterval(() => {
      const t = Date.now();
      this.accumulated += Math.max(0, t - this.last - this.sampleMs);
      this.last = t;
    }, this.sampleMs);
    // Never hold the process open for a measurement: the daemon's lifetime is decided elsewhere.
    this.timer.unref?.();
  }

  /** Stop sampling and return the total off-runqueue time observed. Charging the final partial gap
   *  matters: under heavy starvation the single longest stall is often the one still in progress
   *  when the probe resolves, and dropping it would undercount exactly the worst case. */
  stop(now: number = Date.now()): number {
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
    this.accumulated += Math.max(0, now - this.last - this.sampleMs);
    return this.accumulated;
  }
}

/**
 * What the daemon actually knows when it decides whether the broker is gone.
 *
 * Every field is evidence it GATHERED, never time that merely elapsed. That distinction is the
 * whole repair: `msSinceLastReachable` on its own accrues while no probe runs at all, so a starved
 * process finds its window already blown by the first callback that gets scheduled.
 */
export interface BrokerWatchEvidence {
  /** Wall time since the last POSITIVE evidence of the broker: a probe that ran to completion and
   *  said yes, or a transport (re)connect, which cannot happen without a server on the other end. */
  msSinceLastReachable: number;
  /** Measured local scheduler lag inside that window: the summed excess of each observed interval
   *  gap over {@link PROBE_INTERVAL_MS}, PLUS the excess of each probe answer over its own deadline.
   *  An interval that fired 30s late and a probe that answered 2554ms into a 1000ms budget are both
   *  direct evidence that THIS PROCESS was starved, and that time must not be counted against the
   *  broker. */
  starvedMs: number;
  /** Probes that ran to completion, answered WITHIN their own deadline, and said no — consecutively.
   *  A probe that never ran contributes nothing; one that rejected is an unanswered question; one
   *  whose answer arrived far past its own budget is a statement about this process. Each of those
   *  resets this to 0, because the claim it encodes is a run of credible refusals. */
  completedNegatives: number;
  /** Whether THIS daemon's own established connection to that same broker is still open, as the
   *  connection object reports it. A live socket to the server is positive evidence the server is
   *  there that costs no probe and needs no scheduling — and it is exactly the signal that separates
   *  a transport-level CLOSE from SILENCE. A side probe that cannot complete a fresh handshake while
   *  our standing connection to the same address is open is telling us about this process's ability
   *  to ask, not about the server. */
  transportConnected: boolean;
  /** The unstarved window the daemon is allowed to be without positive evidence. */
  windowMs: number;
  /** How many completed negatives are required before elapsed time may be believed. */
  requiredNegatives: number;
  /** HARD BACKSTOP on the STARVATION credit, applied whenever the transport is not open. A daemon
   *  that outlives a genuinely dead broker is a WORSE defect than the one being repaired: it loops
   *  reconnect attempts forever and nothing recovers it, whereas the reported defect costs a
   *  restart. So measured lag can only excuse so much, and the failure direction is toward exiting.
   *  It deliberately does not bound {@link transportConnected}, which is not an absence of evidence
   *  at all — see {@link brokerGoneVerdict}. */
  backstopMs: number;
}

/**
 * The verdict, with the reason it was reached — so an operator reads WHY the daemon stayed up.
 *
 * `starved` and `insufficient-evidence` are deliberately distinct non-exits. They are the two
 * conditions #1318 collapsed into "broker unreachable": the first is "I could not ask", the second
 * is "I have not yet been told no often enough to believe it".
 */
export type BrokerVerdict =
  | { exit: false; reason: "reachable" }
  | { exit: false; reason: "starved" }
  | { exit: false; reason: "transport-live" }
  | { exit: false; reason: "insufficient-evidence" }
  | { exit: true; reason: "broker-gone" };

/**
 * Decide whether the broker is GONE, from evidence alone.
 *
 * EXIT REQUIRES BOTH CONJUNCTS, and each exists because the other cannot cover its case:
 *
 *   1. `completedNegatives >= requiredNegatives` — probes that actually RAN and actually said no.
 *      Without this, a window that expired while the process was descheduled is read as a server
 *      failure, which is the reported defect in its purest form.
 *   2. `msSinceLastReachable - starvedMs > windowMs` — the UNSTARVED part of the window. Without
 *      this, a host that schedules the daemon just often enough to fire two probes into a
 *      momentarily-saturated loopback exits on two negatives that a healthy host would never have
 *      produced.
 *
 * THIS IS NOT A WIDER TIMEOUT. `windowMs` is unchanged from the shipped default; what changed is
 * that the quantity compared against it is now evidence rather than the passage of time. A daemon
 * whose broker is genuinely dead produces completed negatives as fast as it is scheduled — a dead
 * port answers ECONNREFUSED immediately and a blackholed one answers inside the probe deadline —
 * AND loses its standing connection, so the true-positive path is not delayed by this at all, which
 * is the property that separates a repair from a band-aid. A process so starved that it produces NO
 * completed probe also cannot deliver anything, and ending it would not make Plane-3 more
 * available; it would make the outage permanent for a stock install with no watchdog.
 */
export function brokerGoneVerdict(e: BrokerWatchEvidence): BrokerVerdict {
  // Positive evidence inside the window outranks everything: nothing below can be true of a broker
  // that answered us this recently.
  if (e.msSinceLastReachable <= e.windowMs) return { exit: false, reason: "reachable" };
  // AN OPEN TRANSPORT IS ONGOING POSITIVE EVIDENCE, NOT AN EXCUSE FOR ITS ABSENCE, which is why it
  // is decided before the backstop rather than after. This daemon's own connection to that same
  // broker is up; it is serving on it; its lease renews across it. A fresh side-probe that cannot
  // complete a handshake to an address we are CURRENTLY CONNECTED TO is a statement about this
  // process's ability to open a new socket, not about the server.
  //
  // This cannot become a daemon that outlives its broker, and the reason is structural rather than
  // a matter of degree: when the broker actually dies, this flag goes false. The client detects the
  // loss (that is what starts its reconnect loop), the endpoint's status watcher turns that into
  // `transport: connected=false`, and every clause below is live again from that instant. So the
  // condition that suspends the exit is the same condition that makes the exit unnecessary.
  if (e.transportConnected) return { exit: false, reason: "transport-live" };
  // From here the transport is DOWN, so the absence of evidence is real and is bounded.
  if (e.msSinceLastReachable > e.backstopMs) return { exit: true, reason: "broker-gone" };
  // "I could not ask." Credit the lag this process MEASURED on itself before reading the clock as a
  // statement about the server.
  const unstarvedMs = e.msSinceLastReachable - e.starvedMs;
  if (unstarvedMs <= e.windowMs) return { exit: false, reason: "starved" };
  // "I asked and was told no" — but not yet often enough to be a verdict.
  if (e.completedNegatives < e.requiredNegatives) return { exit: false, reason: "insufficient-evidence" };
  return { exit: true, reason: "broker-gone" };
}

/** What a re-read of this shard's lease says, once a renew has failed. */
export type LeaseReading =
  | { kind: "held"; revision: number }
  | { kind: "gone" }
  | { kind: "taken"; by: string }
  | { kind: "unknown"; why: string };

/**
 * What the daemon does about it. `keep-serving` never ends the process; `reacquire` attempts the
 * atomic re-create and only then decides; `exit` is a genuine loss of the single-holder slot.
 */
export type LeaseAction = "keep-serving" | "reacquire" | "exit";

/**
 * Turn a lease reading into an action.
 *
 * A FAILED RENEW IS A QUESTION, NOT A VERDICT — the same split #1301 made for `down` and the
 * manager's liveness lease already makes. The shipped code exited on ANY renew error, so the
 * measured incident's `wrong last sequence: 0` (the key had EXPIRED during the stall, with nobody
 * else holding it) read identically to a genuine takeover and ended a daemon that was still the
 * only holder there was.
 *
 * The single-holder guarantee is preserved exactly, and by construction rather than by timing:
 * `gone` recovers through an ATOMIC create, so if a replacement did take the slot first, the create
 * fails and that is the genuine loss which exits. `taken` exits immediately. Only "the key is still
 * ours" and "the broker could not be asked" keep serving, and neither of those is a second holder.
 */
export function leaseAction(reading: LeaseReading): LeaseAction {
  switch (reading.kind) {
    // Our own key, at whatever revision the broker says: adopt it and carry on. Covers the renew
    // whose write landed with only its acknowledgement lost.
    case "held": return "keep-serving";
    // Expired or released while we were still here. Put it back; the create arbitrates.
    case "gone": return "reacquire";
    // A different process holds this shard. Exit so the holder stays single.
    case "taken": return "exit";
    // Could not ask. An unanswerable question is not a negative answer; the broker watch above owns
    // the "the server is gone" decision, and it decides on evidence.
    case "unknown": return "keep-serving";
  }
}

/**
 * Measures how late this process's own timers are running.
 *
 * A `setInterval(f, 2000)` that fires 30 seconds after its predecessor did not observe a slow
 * server; it observed a runqueue it was not on. Node hands us no such signal, but the gap between
 * consecutive firings of a timer we own is a direct measurement of it, and it costs one
 * subtraction. Excess over the nominal period is clamped at zero: a timer can fire late, never
 * early, so a negative reading is clock adjustment rather than scheduling and must not CREDIT time
 * the process actually had.
 */
export class LoopLagMeter {
  private last: number | undefined;
  private accumulated = 0;
  constructor(private readonly intervalMs: number = PROBE_INTERVAL_MS) {}

  /** Record a firing at `now`; returns the lag this particular gap contributed. */
  tick(now: number): number {
    const previous = this.last;
    this.last = now;
    if (previous === undefined) return 0; // first firing has no gap to measure
    const lag = Math.max(0, now - previous - this.intervalMs);
    this.accumulated += lag;
    return lag;
  }

  /** Add lag measured somewhere OTHER than the interval gap — in practice, a probe answer that
   *  arrived past its own deadline. Interval gaps alone miss the case where the process IS being
   *  scheduled often enough to fire the timer but not often enough to finish a handshake, which is
   *  the third of the issue's three mechanisms and the one that produces a completed `false` from a
   *  perfectly live server. Clamped at zero for the same reason `tick` is: a measurement that ran
   *  backwards must never credit time the process actually had. */
  credit(lagMs: number): void {
    this.accumulated += Math.max(0, lagMs);
  }

  /** Lag accumulated since the last {@link reset}. */
  get starvedMs(): number {
    return this.accumulated;
  }

  /** Called when positive evidence arrives: the window restarts, so its lag budget does too. The
   *  firing baseline is deliberately KEPT, so a stall spanning a reset is still measured. */
  reset(): void {
    this.accumulated = 0;
  }
}
