/**
 * The delivery daemon's lease decision, as PURE functions over evidence, and the loop-lag meter its
 * broker-loss decision reads.
 *
 * The broker-loss and lease decisions used to be taken inline from a wall clock, and a wall clock
 * cannot tell "the broker is gone" from "this process did not get scheduled". On 2026-09-05 that
 * cost Plane-3 nine minutes across two exits while `nats-server` had been up continuously for 7.3
 * days and was listening throughout; the real condition was load 311 on 12 cores (#1318). The
 * detector failed in the direction of its own failure, and it did so exactly when delivery was most
 * needed.
 *
 * Pulled out here for two reasons. The obvious one is that a decision expressed as a function of
 * named evidence is readable. The load-bearing one is that it becomes GRADEABLE without a broker,
 * a host under load, or a spawned process: every branch below is reachable from a literal, so each
 * ACCEPTING branch can be paired with a REFUSING case that differs only in the evidence, and a
 * mutation to any branch reddens a named cell rather than a timing-dependent end-to-end assertion.
 */

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
 * A FAILED RENEW IS A QUESTION, NOT A VERDICT, the same split #1301 made for `down` and the
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
    // Could not ask. An unanswerable question is not a negative answer; `DeliveryTransportHealth`
    // owns the "the server is gone" decision, and it decides on evidence.
    case "unknown": return "keep-serving";
  }
}

/**
 * May this process hold Plane-3 bindings on the strength of this reading alone?
 *
 * SEPARATE FROM {@link leaseAction} BECAUSE THEY ANSWER DIFFERENT QUESTIONS, and conflating them was
 * a review finding. `leaseAction` decides whether the PROCESS lives; this decides whether it may
 * SERVE. They agree on `taken` and disagree everywhere else that matters:
 *
 *   • `gone` is `reacquire`, the process lives, but it must NOT serve on it. The create has not
 *     been attempted yet, and a replacement may already hold the shard; serving through the
 *     arbitration is how two daemons end up on one durable.
 *   • `unknown` is `keep-serving` for the PROCESS, and a refusal here. Surviving an unanswerable
 *     broker is the entire point of #1318, but not being able to ask who owns the shard is not
 *     permission to keep acting on it. The daemon stays alive and stays quiet.
 *
 * So this is deliberately the STRICTER of the two: it says yes to exactly one reading, the one that
 * carries positive proof of ownership from the broker. Winning the atomic create is the other way
 * to earn it, and that is not a reading, which is why the daemon re-arms there separately.
 */
export function mayServeOn(reading: LeaseReading): boolean {
  // The only reading that is itself proof: the broker was asked, it answered, and the holder it
  // named is this process.
  return reading.kind === "held";
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
  /** Disjoint, sorted [start, end] intervals of measured non-running time in the current window.
   *  Bounded: overlapping charges merge, and `reset` clears them on every positive. */
  private spans: Array<[number, number]> = [];
  constructor(private readonly intervalMs: number) {}

  /** Record a firing at `now`; returns the lag this particular gap contributed.
   *
   *  WHAT THE GAP IS CHARGED AS, since this is the half that is easy to misread: the excess of the
   *  observed gap over the nominal interval is charged as time THIS PROCESS WAS NOT RUNNING. It is a
   *  measurement of the local scheduler, never of the broker - a timer we own fired late, which says
   *  the runqueue did not reach us and says nothing at all about the server.
   *
   *  It is also NOT the only such charge. {@link credit} adds lateness observed on a probe answer,
   *  and the two can describe the same stall or two adjacent ones; nothing in either number reveals
   *  which. Neither method deduplicates, deliberately, because suppressing a charge on the guess
   *  that it overlaps discards real stalls. The sum is bounded instead, at the point of comparison,
   *  by {@link starvedMsWithin}. */
  tick(now: number): number {
    const previous = this.last;
    this.last = now;
    if (previous === undefined) return 0; // first firing has no gap to measure
    const lag = Math.max(0, now - previous - this.intervalMs);
    // Charged as a DATED INTERVAL, not a scalar. The stall ended when this firing ran, so it
    // occupied [now - lag, now]. Recording WHEN lets an overlapping probe charge be unioned with it
    // instead of added to it, which is the whole of the double-count repair.
    this.chargeSpan(now - lag, now);
    return lag;
  }

  /** Add lag measured somewhere OTHER than the interval gap, in practice, a probe answer that
   *  arrived past its own deadline. Interval gaps alone miss the case where the process IS being
   *  scheduled often enough to fire the timer but not often enough to finish a handshake, which is
   *  the third of the issue's three mechanisms and the one that produces a completed `false` from a
   *  perfectly live server. Clamped at zero for the same reason `tick` is: a measurement that ran
   *  backwards must never credit time the process actually had. */
  credit(lagMs: number, endedAt: number = Date.now()): void {
    // BOTH MEASUREMENTS ARE KEPT. An earlier repair here netted this against the most recent interval
    // gap, on the theory that the two always observe ONE stall. They do not, and a reviewer produced
    // the separating case: over a 4000ms span a timer can fire 2000ms late (a stall happening NOW)
    // while a probe issued at the PREVIOUS tick answers 2500ms late (the stall before it). Netting
    // credited 2500ms there and threw away a 2000ms stall the process had actually measured - which
    // is the very mechanism this method exists for, a process scheduled often enough to fire a timer
    // but not to finish a handshake. I measured my own netting against that case and it produced the
    // lossy answer, so it is gone.
    this.chargeSpan(endedAt - Math.max(0, lagMs), endedAt);
  }

  /** Charge [from, to] as time this process was not running, UNIONED with what is already charged.
   *
   *  This is the double-count repair, and it is why both call sites can stay. A stall observed by
   *  the interval timer and by a probe answering across it is ONE interval of wall-clock time seen
   *  by two instruments. Summing scalars charges it twice (measured: 17s for a 10s stall). Summing
   *  INTERVALS cannot, because the union of overlapping intervals is their extent.
   *
   *  It also keeps what netting threw away. Two ADJACENT stalls (a timer late by one, a probe from
   *  the previous tick late by another) do not overlap, so the union is their sum and both are
   *  charged in full. Overlap is decided by the timestamps rather than guessed from the magnitudes,
   *  which is the thing neither scalar arithmetic nor a span clamp can do. */
  private chargeSpan(from: number, to: number): void {
    if (!(to > from)) return;                       // zero or backwards: never credits time we had
    const merged: Array<[number, number]> = [];
    let lo = from, hi = to;
    for (const [s, e] of this.spans) {
      if (e < lo || s > hi) { merged.push([s, e]); continue; }   // disjoint: keep as-is
      lo = Math.min(lo, s); hi = Math.max(hi, e);                // touching: absorb
    }
    merged.push([lo, hi]);
    merged.sort((a, b) => a[0] - b[0]);
    this.spans = merged;
    this.accumulated = merged.reduce((n, [s, e]) => n + (e - s), 0);
  }

  /** Accumulated lag CLAMPED to the span it is about to be compared against.
   *
   *  This is the honest way to stop double counting, and the reason the meter cannot do it by
   *  arithmetic alone: whether a tick charge and a probe charge describe the same stall or two
   *  adjacent ones is not knowable from the two numbers. What IS knowable is that time the process
   *  did not have can never exceed time that passed. Overlap is removed by that bound and nothing
   *  else is discarded, so the sum stays as informative as its parts allow.
   *
   *  Load-bearing, not hygiene: `DeliveryTransportHealth` SUBTRACTS this from elapsed time.
   *  Unclamped, a stall charged twice drives unstarved time negative, and NO amount of real outage
   *  can then clear the evidence clause - a genuinely dead broker stops being detectable by evidence
   *  and survives to the backstop instead. Measured: a 30s stall moved an exit from 44s to 62s. */
  starvedMsWithin(spanMs: number): number {
    return Math.min(this.accumulated, Math.max(0, spanMs));
  }


  /** Lag accumulated since the last {@link reset}. */
  get starvedMs(): number {
    return this.accumulated;
  }

  /** Called when positive evidence arrives: the window restarts, so its lag budget does too. The
   *  firing baseline is deliberately KEPT, so a stall spanning a reset is still measured. */
  reset(): void {
    this.accumulated = 0;
    this.spans = [];   // the intervals ARE the accumulator now; clearing one without the other
                       // would let a pre-reset stall be re-charged by a later overlapping probe.
  }
}
