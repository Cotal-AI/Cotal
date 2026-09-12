/**
 * Serving policy for automatic deliveries a busy Jcode session has not accepted yet (#1233).
 *
 * Every path that hands a queued peer message to the live session is EDGE-TRIGGERED: a new
 * `incoming` while the session is busy, or an idle transition at the end of a turn. When the
 * mid-turn handoff (`soft_interrupt`) rejects — the measured case is the SDK's 30s request timeout
 * — the catch logs and returns, and both edges can then be absent indefinitely: no further message
 * arrives, and the session never reports idle. The queue is served by nothing, the seat stays
 * healthy and productive, and its automatic depth is static while the oldest age grows. Measured
 * live at 27 queued for 13.8 hours on a seat that answered a DM in under a minute.
 *
 * The repair is a LEVEL-TRIGGERED serving loop: while automatic work is owed, something re-attempts
 * delivery on its own schedule rather than waiting for an edge that may never come. This module is
 * the decision that loop makes, extracted so it can be graded directly — every accepting branch AND
 * its refusal — rather than only through a live seat, exactly as `retry-policy.ts` was for #790.
 *
 * TWO DELIVERY PATHS, and the second is the point. `steer` is the existing mid-turn handoff, which
 * needs a `soft_interrupt` reply. `queue-turn` needs no such reply: the Harness accepts an ordinary
 * message while the agent is busy, acknowledges it with `message_accepted`, and runs it as a turn
 * when the current one ends. So a soft interrupt that never answers can no longer strand the queue,
 * because the fallback does not ask it anything.
 *
 * IT NEVER DROPS. No branch here discards a delivery: losing a peer's message is worse than
 * delivering it late, so the only bound is pacing. The one refusal that persists is the turn-level
 * give-up (#790), which leaves the batch UN-ACKED and therefore redeliverable rather than acking
 * work the seat never saw — and which the reported connection state now refuses to call `ready`.
 */

/** First delay after work is owed. Short, because most stalls clear on the next attempt. */
export const FALLBACK_INITIAL_MS = 1_000;
/** Ceiling on the delay. One attempt a minute against a session that is not accepting. */
export const FALLBACK_MAX_MS = 60_000;

/**
 * What the serving loop should do on this tick.
 *
 * - `drive` — run an ordinary turn carrying the queued batch. Only when the session is not busy.
 * - `steer` — attempt the mid-turn handoff into the live session.
 * - `queue-turn` — the fallback: hand the batch to the Harness as an ordinary message, which it
 *   accepts while busy and runs as its own turn. Needs no `soft_interrupt` reply.
 * - `wait` — nothing can be attempted right now; stay armed and look again later.
 * - `stop` — this host is shutting down; disarm.
 */
export type FallbackAction = "drive" | "steer" | "queue-turn" | "wait" | "stop";

export interface FallbackState {
  /** The host is shutting down. */
  stopping: boolean;
  /** A bridge replacement owns the session; it redrives the durable batch itself. */
  reconnecting: boolean;
  /** Startup has finished its readiness proof and post-join notice. */
  initialized: boolean;
  /** A live Harness client and session id are both held. */
  hasSession: boolean;
  /** `driving || turnActive`: a turn owns the provider. */
  sessionBusy: boolean;
  /** A `soft_interrupt` is already in flight; a second would race its own ledger. */
  steering: boolean;
  /** A `soft_interrupt` has failed since the last accepted handoff — the #1233 trigger. */
  softInterruptFailed: boolean;
  /** Automatic deliveries the live session has NOT accepted yet. */
  unserved: number;
  /** The host's own drive predicate: a kickoff, a pending wake, or a queued wake. */
  driveWork: boolean;
  /** Consecutive failed turns, for the #790 give-up bound. */
  consecutiveFailures: number;
  /** The #790 bound itself, passed in so this module owns no copy of it. */
  giveUpAfter: number;
}

export interface FallbackDecision {
  action: FallbackAction;
  /** Why, so a refusal is attributable rather than an unexplained `wait`. */
  reason:
    | "stopping"
    | "not-initialized"
    | "no-session"
    | "reconnecting"
    | "turn-work"
    | "gave-up"
    | "mid-turn-handoff"
    | "soft-interrupt-timed-out"
    | "steer-in-flight"
    | "nothing-owed";
}

/**
 * The next action for the serving loop.
 *
 * ORDER IS MEANING. Shutdown outranks everything (a retry into a child being torn down is the
 * hazard, not the queue). An unfinished startup and a bridge replacement both already own a redrive
 * of the same durable batch, so attempting one here would race theirs. Only then does the queue's
 * own state decide: an idle session takes the whole batch as its own turn, a busy one gets the
 * mid-turn handoff — or, once that handoff has failed, the fallback that does not depend on it.
 */
export function nextFallbackAction(s: FallbackState): FallbackDecision {
  if (s.stopping) return { action: "stop", reason: "stopping" };
  if (!s.initialized) return { action: "wait", reason: "not-initialized" };
  if (!s.hasSession) return { action: "wait", reason: "no-session" };
  if (s.reconnecting) return { action: "wait", reason: "reconnecting" };
  if (!s.sessionBusy) {
    if (!s.driveWork) return { action: "wait", reason: "nothing-owed" };
    // The #790 bound. It refuses to re-drive; it does NOT discard. The batch stays un-acked, so it
    // redelivers, and the reported connection state stops calling this seat ready.
    if (s.consecutiveFailures >= s.giveUpAfter) return { action: "wait", reason: "gave-up" };
    return { action: "drive", reason: "turn-work" };
  }
  if (s.unserved <= 0) return { action: "wait", reason: "nothing-owed" };
  // A failed handoff outranks an in-flight one. `steering` is cleared in the steer's own `finally`,
  // so the two are not simultaneous in practice; ordering it this way means that if they ever were,
  // the branch that can still deliver wins over the branch that waits.
  if (s.softInterruptFailed) return { action: "queue-turn", reason: "soft-interrupt-timed-out" };
  if (s.steering) return { action: "wait", reason: "steer-in-flight" };
  return { action: "steer", reason: "mid-turn-handoff" };
}

/** The next delay, doubling from `current` and clamped at the ceiling. */
export function nextFallbackDelay(current: number): number {
  const doubled = current * 2;
  return doubled > FALLBACK_MAX_MS ? FALLBACK_MAX_MS : doubled;
}

/**
 * Whether the loop must stay armed.
 *
 * Deliberately NOT the same question as {@link nextFallbackAction}. A tick that can do nothing right
 * now (startup, a bridge replacement, the #790 bound) still owes the queue, and disarming on a
 * temporary refusal is precisely how an edge-triggered server strands a message. Only shutdown, and
 * an empty ledger, end the loop.
 */
export function fallbackStillOwed(s: FallbackState): boolean {
  if (s.stopping) return false;
  return s.unserved > 0 || s.driveWork;
}
