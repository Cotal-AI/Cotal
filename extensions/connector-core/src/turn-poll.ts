/** Delay before the one retry after a run-turn pull that failed for a reason that can pass (a
 *  manager down, still reconciling, or unanswered), and the pull interval under a launching
 *  manager that predates turn notices. Pulls are otherwise driven by the manager's turn notices
 *  and by reconnects (SPEC 14.3), so an idle seat that pulled successfully sends nothing. */
export const TURN_PULL_RETRY_MS = 15_000;
