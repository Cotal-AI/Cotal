/**
 * Which stored session, if any, a restarting seat should come back to.
 *
 * Kept apart from the host so the rule can be graded directly. The rule is deliberately
 * conservative: resuming the WRONG session is worse than starting clean, because a seat that
 * silently inherits another lane's context will act on it with full confidence.
 */

/** The subset of the SDK's `SessionInfo` this decision actually reads. */
export interface ResumeCandidate {
  session_id: string;
  working_dir?: string;
  status?: string;
  transcript_bytes?: number;
  archived?: boolean;
}

/**
 * Pick the session to attach, or `undefined` to create a fresh one.
 *
 * A candidate must prove it is ours before it can be resumed:
 *   - it declares a `working_dir`, and that dir is this seat's cwd (an undeclared dir cannot be
 *     proven, so it is refused rather than assumed);
 *   - it is not archived (archiving is an operator's explicit "retire this");
 *   - it carries a transcript with actual bytes, since resuming an empty session buys nothing and
 *     an unknown size is not assumed to be rich.
 *
 * Among survivors the largest transcript wins: that is the one holding the memory a restart would
 * otherwise throw away, and it is what distinguishes the real session from the stub a previous
 * buggy restart may have left behind.
 */
export function chooseSessionToResume(
  candidates: readonly ResumeCandidate[] | undefined,
  cwd: string,
): ResumeCandidate | undefined {
  if (!candidates?.length) return undefined;
  const usable = candidates.filter(
    (c) =>
      typeof c.session_id === "string" &&
      c.session_id.length > 0 &&
      c.archived !== true &&
      typeof c.working_dir === "string" &&
      c.working_dir === cwd &&
      typeof c.transcript_bytes === "number" &&
      c.transcript_bytes > 0,
  );
  if (!usable.length) return undefined;
  // Copy before sorting: the caller's list is not ours to reorder.
  return [...usable].sort(
    (a, b) =>
      (b.transcript_bytes ?? 0) - (a.transcript_bytes ?? 0) || a.session_id.localeCompare(b.session_id),
  )[0];
}
