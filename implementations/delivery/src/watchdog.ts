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
  constructor(private readonly intervalMs: number) {}

  /** Record a firing at `now`; returns the lag this particular gap contributed.
   *
   *  WHAT THE GAP IS CHARGED AS, since this is the half that is easy to misread: the excess of the
   *  observed gap over the nominal interval is charged as time THIS PROCESS WAS NOT RUNNING. It is a
   *  measurement of the local scheduler, never of the broker - a timer we own fired late, which says
   *  the runqueue did not reach us and says nothing at all about the server.
   *
   *  The charges are summed. Each one measures the gap between two consecutive firings, and those
   *  gaps never overlap in real time, so no charge repeats another. Comparing their wall-clock
   *  timestamps instead would merge two separate stalls whenever the clock stepped backwards between
   *  them. */
  tick(now: number): number {
    const previous = this.last;
    this.last = now;
    if (previous === undefined) return 0; // first firing has no gap to measure
    const lag = Math.max(0, now - previous - this.intervalMs);
    this.accumulated += lag;
    return lag;
  }

  /** Accumulated lag CLAMPED to the span it is about to be compared against: time the process did
   *  not have can never exceed time that passed. On a steady clock the sum already stays within the
   *  time since the first firing. A wall clock that steps backwards shortens the span the caller
   *  measures without undoing the charges taken before the step, and the clamp bounds that case. */
  starvedMsWithin(spanMs: number): number {
    return Math.min(this.accumulated, Math.max(0, spanMs));
  }

  /** Called when positive evidence arrives: the window restarts, so its lag budget does too. The
   *  firing baseline is deliberately KEPT, so a stall spanning a reset is still measured. */
  reset(): void {
    this.accumulated = 0;
  }
}
