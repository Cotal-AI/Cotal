export interface OrderNote { type: string; missing?: number }
export interface OrderingNotice { kind: string; message: string }

/** Display summaries of the controller's ordering observations without generating markup. */
export function orderingNotices(notes: readonly OrderNote[]): OrderingNotice[] {
  const gaps = notes.filter(note => note.type === "gap");
  const races = notes.filter(note => note.type === "boundary-hole").length;
  const prefixes = notes.filter(note => note.type === "prefix-incomplete").length;
  const failures = notes.filter(note => note.type === "backfill-failed").length;
  const missing = gaps.reduce((sum, gap) => sum + (gap.missing || 0), 0);
  return [
    ...(gaps.length ? [{ kind: "gap", message: `${missing} event frame${missing === 1 ? "" : "s"} missing (${gaps.length} break${gaps.length === 1 ? "" : "s"} in the stream)` }] : []),
    ...(races ? [{ kind: "boundary-hole", message: `${races} possible ordering race${races === 1 ? "" : "s"} at start-up, unconfirmed` }] : []),
    ...(prefixes ? [{ kind: "prefix-incomplete", message: `${prefixes} stream${prefixes === 1 ? "" : "s"} joined after the start, earlier frames not retained` }] : []),
    ...(failures ? [{ kind: "backfill-failed", message: "History unavailable, so ordering is based on live frames only" }] : []),
  ];
}
