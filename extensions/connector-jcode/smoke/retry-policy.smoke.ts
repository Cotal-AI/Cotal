/**
 * A failed turn must not become a hot loop.
 *
 * jcode acks a turn's batch only on success, so a failure leaves `pendingWake()` positive and the
 * `finally` re-drives the SAME batch immediately. With no delay and no cap, one deterministic
 * failure re-paid the full injection to the provider on every pass - measured at 62 resends off a
 * single stalled turn (#790). The codex host has had `scheduleErrorRetry` (exponential, ceilinged,
 * single timer, unref'd, reset-on-success) the whole time; jcode had none of it.
 */
import assert from "node:assert/strict";
import {
  ERROR_RETRY_GIVE_UP,
  ERROR_RETRY_INITIAL_MS,
  ERROR_RETRY_MAX_MS,
  nextRetryDelay,
  shouldRetry,
} from "../src/retry-policy.js";

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
  console.log(`  ✗ ${detail}`);
};

const base = {
  stopping: false,
  timerPending: false,
  consecutiveFailures: 1,
  pendingWake: 1,
  wakeQueued: false,
};

console.log("\n1. the delay GROWS - the defect was that it never did");
{
  const d1 = nextRetryDelay(ERROR_RETRY_INITIAL_MS);
  const d2 = nextRetryDelay(d1);
  check("each retry waits longer than the last", d1 > ERROR_RETRY_INITIAL_MS && d2 > d1, { d1, d2 });
  check("the first delay is not instant", ERROR_RETRY_INITIAL_MS > 0);
}

console.log("\n2. and it is CEILINGED - unbounded growth is its own failure");
{
  let d = ERROR_RETRY_INITIAL_MS;
  for (let i = 0; i < 40; i++) d = nextRetryDelay(d);
  check("the delay never exceeds the ceiling", d === ERROR_RETRY_MAX_MS, { d });
  check("the ceiling is reachable, not theoretical", ERROR_RETRY_MAX_MS > ERROR_RETRY_INITIAL_MS);
}

console.log("\n3. exactly one retry in flight - never a fan-out");
{
  check("a pending timer blocks another retry", shouldRetry({ ...base, timerPending: true }).reason === "timer-pending");
  check("with no timer pending, a retry is allowed", shouldRetry(base).retry);
}

console.log("\n4. shutdown wins over any retry");
{
  const r = shouldRetry({ ...base, stopping: true });
  check("a stopping host never re-drives", !r.retry && r.reason === "stopping");
  check(
    "shutdown beats even a full wake queue",
    !shouldRetry({ ...base, stopping: true, pendingWake: 99, wakeQueued: true }).retry,
  );
}

console.log("\n5. nothing to retry is not a retry");
{
  const r = shouldRetry({ ...base, pendingWake: 0, wakeQueued: false });
  check("an empty inbox with no queued wake does not arm a timer", !r.retry && r.reason === "nothing-pending");
  check("a queued wake alone is enough to retry", shouldRetry({ ...base, pendingWake: 0, wakeQueued: true }).retry);
}

console.log("\n6. the loop ENDS - a provider that never answers must not be paid forever");
{
  const r = shouldRetry({ ...base, consecutiveFailures: ERROR_RETRY_GIVE_UP });
  check("at the budget the seat stops re-driving", !r.retry && r.reason === "gave-up");
  check("past the budget it stays stopped", !shouldRetry({ ...base, consecutiveFailures: ERROR_RETRY_GIVE_UP + 5 }).retry);
  check("one below the budget it still retries", shouldRetry({ ...base, consecutiveFailures: ERROR_RETRY_GIVE_UP - 1 }).retry);
}

console.log("\n7. the give-up budget is a real bound, not a formality");
{
  // Worst case cost of one stalled turn: the sum of the delays before giving up. If this were
  // unbounded (the shipped behaviour) the loop re-sent the injection with no pause at all.
  let d = ERROR_RETRY_INITIAL_MS;
  let total = 0;
  for (let i = 0; i < ERROR_RETRY_GIVE_UP; i++) {
    total += d;
    d = nextRetryDelay(d);
  }
  check("a stalled turn is retried a bounded number of times", ERROR_RETRY_GIVE_UP < 20, { ERROR_RETRY_GIVE_UP });
  check("and the seat spends real time waiting, not spinning", total >= 60_000, { totalMs: total });
}

console.log(`\njcode retry policy: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`jcode retry policy: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
