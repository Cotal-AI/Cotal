/**
 * The §13.6 SUPERVISOR-WRITE authority — the capability to ORIGINATE supervisor-owned service
 * status (the restart history, the retirement mark, the `escalated` state) through
 * {@link writeServiceStatus}. This module is DELIBERATELY NOT re-exported from the package
 * index: only the in-package §13.6 supervisor seams (`noteInstanceRestart`, the escalation
 * reconciler in endpoint-virtual, and the writer check in endpoint-service) import it, so the
 * mint is NOT ambiently obtainable by an arbitrary `@cotal-ai/core` consumer. A brand that any
 * caller can mint is not an authority boundary (that was the flaw a public zero-argument
 * factory had); keeping the mint package-private makes possession of the grant proof that the
 * write came from a supervisor seam.
 */
export interface SupervisorWriteGrant {
  readonly __supervisorWrite: true;
}

const SUPERVISOR_WRITE_GRANTS = new WeakSet<object>();

/** Mint the supervisor-write authority. INTERNAL: import only from the §13.6 supervisor seams. */
export function mintSupervisorWrite(): SupervisorWriteGrant {
  const g = Object.freeze({ __supervisorWrite: true as const });
  SUPERVISOR_WRITE_GRANTS.add(g);
  return g;
}

/** True iff `g` is a genuine mint (WeakSet membership; a structural look-alike is not). */
export function isSupervisorWrite(g: unknown): boolean {
  return typeof g === "object" && g !== null && SUPERVISOR_WRITE_GRANTS.has(g as object);
}
