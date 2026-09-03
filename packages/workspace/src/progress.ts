/** Progress is an outside observation of work product, not the seat's presence heartbeat. */
export const PROGRESS_STALL_MS = 5 * 60_000;

export interface ProgressObservation {
  /** Epoch ms of the last assistant message in the seat's session store. */
  lastAssistantTs: number;
}

/** Render-agnostic operator signal. Human wording belongs to each presentation surface. */
export type ProgressSignal =
  | { kind: "unknown" }
  | { kind: "fresh"; ageMs: number }
  | { kind: "stalled"; ageMs: number };

export function progressSignal(
  observation: ProgressObservation | undefined,
  now: number,
  stallMs = PROGRESS_STALL_MS,
): ProgressSignal {
  if (observation === undefined) return { kind: "unknown" };
  const ageMs = Math.max(0, now - observation.lastAssistantTs);
  return ageMs > stallMs ? { kind: "stalled", ageMs } : { kind: "fresh", ageMs };
}
