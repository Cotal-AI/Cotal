/** The next heartbeat of an endpoint that beats at its own phase. Beats fall on
 *  `phaseMs + beat * intervalMs`; the next is the first after `lastBeat` that is not already past, so
 *  a beat the loop could not reach in time is skipped rather than queued, and a beat never moves to
 *  the instant the previous one happened to run. */
export function nextHeartbeat(phaseMs: number, intervalMs: number, lastBeat: number, nowMs: number): { beat: number; delayMs: number } {
  const beat = Math.max(lastBeat + 1, Math.ceil((nowMs - phaseMs) / intervalMs));
  return { beat, delayMs: Math.max(0, phaseMs + beat * intervalMs - nowMs) };
}
