/**
 * The wait between two reads of a poll or retry loop, on a timer that never holds the process open.
 * A loop still doing work is reading over a broker connection, and that connection keeps the process
 * alive for it. The timer alone would only keep a finished process alive for one more poll: a wait
 * that lost its race to a cancellation or a fire, or a loop whose flag has already ended it.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
