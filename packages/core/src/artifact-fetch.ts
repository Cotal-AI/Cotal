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
 *
 * AND PASSING THE GATE IS NOT ENOUGH, WHICH IS WHAT AN EARLIER VERSION OF THIS FILE GOT WRONG.
 * It ran `mayRead` first and then branched on a GLOBAL `blobExists(digest)`, so any caller holding
 * read on any one scope could ask about any digest and learn, from the refusal name alone, whether
 * those bytes existed somewhere in the space — a scope-wide entitlement answering a space-wide
 * question. §5.1 forbids exactly this in terms:
 *
 *   > `artifact not yet attached` may never be distinguished from `unknown digest` on the basis of
 *   > whether the blob exists in the space store. The two names may differ ONLY when a
 *   > scope-specific pending-or-attached record for `(digest, scope)` exists — otherwise they
 *   > collapse to one. The commit reservation is a GC device and must never be readable as a fetch
 *   > oracle.
 *
 * The plan said it and the code did the opposite, and only the plan was reviewed. Worse, the suite
 * had a cell REQUIRING the two names to differ, so the leak was pinned in place by a passing test.
 *
 * WHAT REPLACES IT. After `mayRead`, the only digest-dependent thing consulted is a SCOPE-LOCAL
 * record for `(digest, scope)`. The byte store is not touched until that record says the digest is
 * in scope — so every client-visible distinction is derived from state the caller has already
 * proven entitlement to, and no answer here is a function of the global store.
 *
 * ORDERING IS NOT OBSERVABLE FROM OUTCOMES. A suite checking that both refusals carry the right
 * names passes whether or not the gate ran first — the outcomes are identical either way. That is
 * why this module takes its dependencies as an injected object: the suite records the ORDER of the
 * calls and asserts on it, and the ordering mutation has a named cell to redden. Without that, the
 * rule is prose and the code is free to drift from it.
 */

/** Named refusals for the fetch path.
 *
 * `Object.freeze`, not merely `as const` — `as const` is a TYPE-level claim that vanishes at runtime,
 * leaving an ordinary mutable object any imported module can rewrite. A refusal vocabulary is a
 * live-read security collection, which is precisely the class `smoke:frozen-exports` enforces.
 */
export const FETCH_REFUSAL = Object.freeze({
  /**
   * The caller may not read this scope. Returned BEFORE any digest-dependent state is touched, so
   * it is indistinguishable from every other reason a stranger might be refused.
   */
  notAuthorized: "fetchArtifact: not authorized",
  /**
   * NO SCOPE-LOCAL RECORD for `(digest, scope)`.
   *
   * This is the COLLAPSED name, and the collapse is the security property. It covers both "no such
   * digest anywhere" and "those bytes exist but nothing in this scope references them", because
   * separating those two is precisely the space-wide existence oracle §5.1 forbids. It is a SCOPED
   * statement — "this scope has no record of that digest" — made to a caller who has passed the
   * scope's read two-gate and is therefore entitled to scoped statements.
   */
  unknownDigest: "fetchArtifact: unknown digest",
  /**
   * Retryable, and only ever returned when a scope-specific PENDING record exists — so there really
   * is something that can still complete it.
   *
   * "Retryable" is a claim about the future, and it is only honest while a future exists: a
   * retryable refusal that can never succeed is a worse lie than a terminal one. That is why this
   * name is gated on a pending record rather than on the bytes being absent; a caller told to retry
   * is being told something true about this scope.
   */
  notYetAttached: "fetchArtifact: artifact not yet attached",
  /**
   * The attachment exists for this scope but its bytes are gone — swept, expired, or GC'd.
   *
   * TERMINAL, and reachable only from scope-local state: the caller has an attachment record in a
   * scope it may read, so telling it the bytes are gone reveals nothing it was not already entitled
   * to know. This is the one place the byte store may be consulted, and it is consulted only after
   * a scope record has already put the digest in scope.
   */
  expired: "fetchArtifact: artifact expired",
} as const);

export const FETCH_REFUSALS: readonly string[] = Object.freeze(Object.values(FETCH_REFUSAL));

/**
 * What this scope knows about this digest. The ONLY digest-dependent state consulted before the
 * caller's entitlement has been established for the specific `(digest, scope)` pair.
 *
 * Deliberately a closed three-value answer rather than two booleans: two booleans invite a caller
 * to consult one, branch, and consult the other, which is how an ordering property degrades into a
 * convention. One call, one answer, one branch.
 */
export type ScopeRecord =
  /** `(digest, scope)` is attached — the caller may have the bytes if the bytes still exist. */
  | "attached"
  /** A scope-specific pending attach exists: published, not yet confirmed. A retry can still win. */
  | "pending"
  /** This scope has no record of this digest. Says NOTHING about the global store, by construction. */
  | "none";

export interface FetchGateDeps {
  /** The scope read two-gate: live ACL ∩ mint-time ceiling. MUST be consulted first. */
  mayRead(caller: string, scope: string): Promise<boolean>;
  /**
   * SCOPE-LOCAL state for `(digest, scope)`. Both arguments are required and both are used: a
   * lookup that ignored `scope` would reintroduce the global oracle through the back door.
   */
  scopeRecord(digest: string, scope: string): Promise<ScopeRecord>;
  /**
   * Whether the bytes are still in the store. GLOBAL, and therefore callable ONLY after
   * `scopeRecord` has returned `attached` — never as a branch on whether the digest is known.
   */
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

  // Past this line the caller has proven entitlement TO THIS SCOPE — which licenses scoped
  // statements and nothing wider. So the next lookup is scope-local, and the global byte store stays
  // untouched until it has answered.
  const record = await deps.scopeRecord(digest, scope);

  // THE COLLAPSE. "No such digest" and "exists globally but not attached here" are ONE answer,
  // because telling them apart is the space-wide existence oracle. If you are here to split this
  // into two names for better client diagnostics: that is the exact change this module was rewritten
  // to undo, and the suite has a cell that will redden.
  if (record === "none") return { ok: false, error: FETCH_REFUSAL.unknownDigest };

  // Honest because a scope-specific pending record exists: something really can still complete it.
  if (record === "pending") return { ok: false, error: FETCH_REFUSAL.notYetAttached };

  // `attached` — and ONLY now may the global store be consulted. The scope has already placed this
  // digest in the caller's reach, so a distinct terminal answer here reveals nothing further.
  if (!(await deps.blobExists(digest))) return { ok: false, error: FETCH_REFUSAL.expired };
  return { ok: true };
}
