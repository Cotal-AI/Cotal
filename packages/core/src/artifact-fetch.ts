/**
 * The fetch gate — and the ORDER of its checks is the security property, not an implementation
 * detail.
 *
 * WHY ORDER IS THE PROPERTY. Put carries no scope (§4.1), so a commit places bytes globally. If
 * fetch branches on the digest before establishing that the caller may read the scope, the choice
 * of refusal tells an unentitled caller which digests exist ANYWHERE in the space — the existence
 * oracle the invisible-dedupe rule spends itself closing, arriving through the refusal names
 * instead of through a response field.
 *
 * So: the scope read two-gate runs FIRST, and no digest-dependent state is consulted before it.
 * After it passes, the caller has proven entitlement and a distinct `unknown digest` becomes a
 * SCOPED statement made to someone entitled to scoped statements.
 *
 * ORDERING IS NOT OBSERVABLE FROM OUTCOMES. A suite checking that both refusals carry the right
 * names passes whether or not the gate ran first — the outcomes are identical either way. That is
 * why this module takes its dependencies as an injected object: the suite records the ORDER of the
 * calls and asserts on it, and the ordering mutation (move the digest branch above the gate) has a
 * named cell to redden. Without that, the rule is prose and the code is free to drift from it.
 */

/** Named refusals for the fetch path. */
export const FETCH_REFUSAL = {
  /**
   * The caller may not read this scope. Returned BEFORE any digest-dependent state is touched, so
   * it is indistinguishable from every other reason a stranger might be refused.
   */
  notAuthorized: "fetchArtifact: not authorized",
  /**
   * Only reachable AFTER the read-gate has passed. Distinct because the caller has, by then, proven
   * entitlement to scoped statements — the rule being that a refusal may distinguish states only
   * when the caller has already proven entitlement to the state being distinguished.
   */
  unknownDigest: "fetchArtifact: unknown digest",
  /**
   * Retryable — but only while something can still complete it. Once the publication's confirm has
   * failed permanently, or the reservation and blob are swept, the state is terminal and must not
   * keep inviting a retry: "retryable" is a claim about the future, and it is only honest while a
   * future exists.
   */
  notYetAttached: "fetchArtifact: artifact not yet attached",
  /** The attachment expired or its bytes were swept. */
  expired: "fetchArtifact: artifact expired",
} as const;

export const FETCH_REFUSALS: readonly string[] = Object.values(FETCH_REFUSAL);

export interface FetchGateDeps {
  /** The scope read two-gate: live ACL ∩ mint-time ceiling. MUST be consulted first. */
  mayRead(caller: string, scope: string): Promise<boolean>;
  /** Whether `(digest, scope)` is attached. Digest-dependent — must not run before `mayRead`. */
  isAttached(digest: string, scope: string): Promise<boolean>;
  /** Whether the bytes are still in the store. Digest-dependent. */
  blobExists(digest: string): Promise<boolean>;
}

export interface FetchGateReply {
  ok: boolean;
  error?: string;
}

/**
 * Authorize one fetch call. Re-run per chunk, never once per transfer: a revoked read or a swept
 * blob must stop the very next chunk with a named refusal rather than a short read that reads as
 * completion.
 */
export async function fetchGate(
  caller: string,
  digest: string,
  scope: string,
  deps: FetchGateDeps,
): Promise<FetchGateReply> {
  // ---------------------------------------------------------------------------------------------
  // THIS CALL MUST BE FIRST. Moving any digest-dependent lookup above it turns the refusal names
  // into an oracle over the whole space's store. The outcomes below are identical either way, which
  // is exactly why this is enforced by a mutation with a named cell rather than by a comment alone.
  // ---------------------------------------------------------------------------------------------
  if (!(await deps.mayRead(caller, scope))) return { ok: false, error: FETCH_REFUSAL.notAuthorized };

  // Past this line the caller has proven entitlement, so scoped statements are permitted.
  if (!(await deps.blobExists(digest))) return { ok: false, error: FETCH_REFUSAL.unknownDigest };
  if (!(await deps.isAttached(digest, scope))) return { ok: false, error: FETCH_REFUSAL.notYetAttached };
  return { ok: true };
}
