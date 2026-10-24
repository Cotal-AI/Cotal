/** Cadence of the turn-pending pull while connected. The relay is PULL-shaped by design (the
 *  manager holds no DM machinery and a pushed relay could not authenticate its sender), so this
 *  poll is the intake's whole latency: a fresh turn waits at most one interval plus one wake.
 *  Deadlines are minutes-scale; fifteen seconds of intake lag is invisible to a run. */
export const TURN_POLL_MS = 15_000;
