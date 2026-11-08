/** A caught value's text for a refusal or a log line. A host-supplied store, runtime or callback may
 *  reject with any value, including `null` or one whose `message` is a Symbol or whose `message`
 *  getter or `toString` throws. A handler that throws while building its text skips the work after
 *  it, so the coercion to text runs inside the guard. */
export function rejectionText(e: unknown): string {
  try {
    return String((e as { message?: unknown } | null)?.message ?? e);
  } catch {
    return "an unreadable rejection";
  }
}

/** A cleanup step that threw. `step` names it without quoting the agent's paths or secret keys.
 *  `err` stays the caught value, so a caller can render it once or keep only the step name. */
export type CleanupFailure = { step: string; err: unknown };

/** Run one cleanup step, recording its failure in `failed`. A step that threw would otherwise skip
 *  every step after it, and a swallowed one would leave nothing to report. */
export async function attemptCleanup(failed: CleanupFailure[], step: string, run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (err) {
    failed.push({ step, err });
  }
}

/** `<step>: <reason>` for each failure, joined for one refusal sentence. */
export function describeCleanupFailures(failed: readonly CleanupFailure[]): string {
  return failed.map(({ step, err }) => `${step}: ${rejectionText(err)}`).join("; ");
}
