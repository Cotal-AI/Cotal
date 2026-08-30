/**
 * Progress is not presence.
 *
 * Presence `working` is a claim the seat (or its surviving connector) makes about a process.
 * Progress is an observation of the seat's own work product, made from outside the seat.
 * Rendering heartbeat age as if it were work age is the #876 bug: a frozen seat stays `working`
 * with a fresh age because the bridge still heartbeats.
 *
 * This helper never invents a stall from presence. No observation => progress unknown.
 * A stale last-assistant timestamp => stalled Xm, over the still-fresh presence status.
 */
export const PROGRESS_STALL_MS = 5 * 60_000;

export type ProgressObservation = {
  /** Epoch ms of the last assistant message in the seat's own session store. */
  lastAssistantTs: number;
};

export type ProgressOverlay =
  | { kind: "unknown"; label: "progress unknown" }
  | { kind: "fresh"; label: string }
  | { kind: "stalled"; label: string; ageMs: number };

function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** Overlay for a presence row. `now` is injected so tests are deterministic. */
export function progressOverlay(
  observation: ProgressObservation | undefined,
  now: number,
  stallMs = PROGRESS_STALL_MS,
): ProgressOverlay {
  if (observation === undefined) return { kind: "unknown", label: "progress unknown" };
  const ageMs = Math.max(0, now - observation.lastAssistantTs);
  if (ageMs > stallMs) return { kind: "stalled", label: `stalled ${ageLabel(ageMs)}`, ageMs };
  return { kind: "fresh", label: ageLabel(ageMs) };
}

/** Status word plus overlay. Presence status is kept; overlay is the progress claim. */
export function presenceProgressLabel(
  status: string,
  overlay: ProgressOverlay,
): string {
  if (status !== "working") return status;
  if (overlay.kind === "fresh") return status;
  return `${status} · ${overlay.label}`;
}
