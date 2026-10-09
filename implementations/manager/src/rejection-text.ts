/** A caught value's text for a refusal or a log line. A host-supplied store, runtime or callback may
 *  reject with any value, including `null` or one whose `message` is a Symbol or whose `message`
 *  getter or `toString` throws. A handler that throws while building its text skips the work after
 *  it, and on a detached chain ends the manager with an unhandled rejection, so the coercion to text
 *  runs inside the guard. */
export function rejectionText(e: unknown): string {
  try {
    return String((e as Error)?.message ?? e);
  } catch {
    return "an unreadable rejection";
  }
}
