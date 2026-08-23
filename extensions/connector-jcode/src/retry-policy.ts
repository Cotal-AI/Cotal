/**
 * Pacing for a failed turn.
 *
 * A jcode turn acks its batch only on success, so a failure leaves `pendingWake()` positive and the
 * naive `finally` re-drive fires instantly with the SAME batch. One deterministic failure therefore
 * became a hot loop that re-paid the full injection to the provider on every pass - measured at 62
 * resends off a single stalled turn (#790). The codex host already solved this with an exponential
 * `scheduleErrorRetry`; this is the same rule, extracted so it can be graded directly rather than
 * only through a live seat.
 */

/** First delay after a failure. Short, because most failures are transient. */
export const ERROR_RETRY_INITIAL_MS = 1_000;
/** Ceiling on the delay. Past this, waiting longer buys nothing. */
export const ERROR_RETRY_MAX_MS = 60_000;
/** Consecutive failures after which the seat stops re-driving entirely. */
export const ERROR_RETRY_GIVE_UP = 8;

/** The next delay, doubling from `current` and clamped at the ceiling. */
export function nextRetryDelay(current: number): number {
  const doubled = current * 2;
  return doubled > ERROR_RETRY_MAX_MS ? ERROR_RETRY_MAX_MS : doubled;
}

/**
 * Whether a failed turn should be retried at all.
 *
 * Refuses when shutting down (a retry would re-drive a batch into a child being torn down), when a
 * timer is already pending (one in flight at a time, never a fan-out), when there is nothing left to
 * retry, and once the consecutive-failure budget is spent - at which point the batch stays un-acked
 * and redelivers rather than being burned against a provider that is not answering.
 */
export function shouldRetry(state: {
  stopping: boolean;
  timerPending: boolean;
  consecutiveFailures: number;
  pendingWake: number;
  wakeQueued: boolean;
}): { retry: boolean; reason: "ok" | "stopping" | "timer-pending" | "nothing-pending" | "gave-up" } {
  if (state.stopping) return { retry: false, reason: "stopping" };
  if (state.timerPending) return { retry: false, reason: "timer-pending" };
  if (state.consecutiveFailures >= ERROR_RETRY_GIVE_UP) return { retry: false, reason: "gave-up" };
  if (state.pendingWake === 0 && !state.wakeQueued) return { retry: false, reason: "nothing-pending" };
  return { retry: true, reason: "ok" };
}
