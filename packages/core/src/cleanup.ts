import { rejectionText } from "./endpoint-error.js";

/** A cleanup step that threw: the step's name and the value it threw. */
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

/** `<step>: <reason>` for each failure, joined with `; `. */
export function describeCleanupFailures(failed: CleanupFailure[]): string {
  return failed.map(({ step, err }) => `${step}: ${rejectionText(err)}`).join("; ");
}
