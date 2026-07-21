/**
 * The §13.1 lifecycle STATE grammar: the wire-normative key shapes, closed value schemas, and
 * state sets for the lifecycle alias head (`lifecycle.<owner>.<actor>`), the space-global UID
 * reservation (`uid.<lifecycleUid>`), and the agent-family issuance gate (`gate.<lifecycleUid>`).
 *
 * This module is GRAMMAR ONLY, shared by every lifecycle executor (the user-mesh auth service
 * and the manager's static lifecycle adapter): key construction, parse-at-the-consuming-boundary
 * validation, and the state constants. The CAS SEQUENCING that produces these rows (activation
 * saga, head retirement, gate transitions) and the barrier ORCHESTRATION (revoke/evict/ledger)
 * live with their executors; a second copy of either is the dual-encoder drift this module
 * exists to prevent.
 */
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { LIFECYCLE_HEAD, UID_RESERVATION, recordAtomicKey } from "./endpoint-records.js";
import { assertLifecycleToken, endpointToken } from "./endpoint-subjects.js";
import { parsePrincipalKey, isPrincipalOwnerToken } from "./subjects.js";

const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// ---- the head (records store) ---------------------------------------------------------------

/** The `lifecycle.<owner>.<actor>` head value (§13.1, amended). One incarnation of an alias.
 *  `mappingRevision` is NOT here: it is the head key's STORE revision (§13.1), returned beside
 *  the mapping by the leader read. `currentCredentialId` stays ABSENT until the (3) normative
 *  ledger mints under the reopened gate (an active head naming a released credential before the
 *  ledger exists would be exactly the unledgered mint §13.1 forbids). */
export interface LifecycleMapping {
  owner: string;
  actor: string;
  /** The never-reused, space-globally reserved lifecycle UID of THIS incarnation. */
  lifecycleUid: string;
  /** The minting/supervising authority. */
  managerInstance: string;
  /** The fenced process epoch (§13.1: live authority binds it; advanced only by the takeover
   *  barrier). */
  processEpoch: number;
  /** `active` is the ONLY current state. `retiring` = the terminal barrier's op-bound
   *  containment phase (non-current, NOT replaceable). `retired` = terminal AND asserts the
   *  completed barrier (only then may activation replace the alias, with a fresh UID). */
  state: "active" | "retiring" | "retired";
  /** The public credential fingerprint + authority epoch — absent until the ledger slice. */
  currentCredentialId?: string;
  /** The opId of the takeover operation that LAST advanced this epoch (SPEC 13.1: the epoch
   *  advance and its op stamp are ONE CAS, so a completion is bound to exactly one operation).
   *  A resuming barrier confirms the completed head carries ITS opId; a LOSING concurrent
   *  takeover finds a foreign opId and refuses, never claiming the winner's completion. Absent
   *  at initial activation (epoch 1), present from the first takeover. */
  lastTakeoverOpId?: string;
  /** REQUIRED at `retiring` (the retirement operation's durable intent); absent otherwise. */
  op?: { opId: string; kind: "retirement" };
}

export const LIFECYCLE_HEAD_STATES: ReadonlySet<string> = new Set(["active", "retiring", "retired"]);

/** The head key `lifecycle.<owner>.<actor>` (§13.7: one atomic unsplit key). */
export function lifecycleHeadKey(owner: string, actor: string): string {
  return recordAtomicKey(LIFECYCLE_HEAD, [owner, actor]);
}

/** The space-global reservation key `uid.<lifecycleUid>` (§13.7: create-only, never-deleted). */
export function uidReservationKey(lifecycleUid: string): string {
  return recordAtomicKey(UID_RESERVATION, [lifecycleUid]);
}

/** Validate a head value at the consuming boundary — CLOSED schema (nested `op` included), and
 *  the embedded owner/actor MUST agree with the key so a key-mismatched row never authorizes. */
export function parseLifecycleHead(raw: Uint8Array, key: string, owner: string, actor: string): LifecycleMapping {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the lifecycle head ${key} is not an object`);
  const allowed = new Set(["owner", "actor", "lifecycleUid", "managerInstance", "processEpoch", "state", "currentCredentialId", "lastTakeoverOpId", "op"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the lifecycle head ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (
    o.owner !== owner || o.actor !== actor ||
    typeof o.lifecycleUid !== "string" || typeof o.managerInstance !== "string" || o.managerInstance.length === 0 ||
    !uint(o.processEpoch) || o.processEpoch < 1 || typeof o.state !== "string" || !LIFECYCLE_HEAD_STATES.has(o.state) ||
    (o.currentCredentialId !== undefined && (typeof o.currentCredentialId !== "string" || o.currentCredentialId.length === 0)) ||
    (o.lastTakeoverOpId !== undefined && typeof o.lastTakeoverOpId !== "string")
  )
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} does not validate (owner/actor/uid/epoch/state); a garbled or key-mismatched head never authorizes (SPEC 13.1/13.3)`);
  try {
    assertLifecycleToken(o.lifecycleUid);
    if (o.lastTakeoverOpId !== undefined) assertLifecycleToken(o.lastTakeoverOpId);
  } catch {
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} carries a malformed lifecycleUid/lastTakeoverOpId (SPEC 13.1)`);
  }
  // The retirement op intent: REQUIRED at `retiring`, forbidden elsewhere; itself closed.
  if (o.state === "retiring") {
    if (!isRec(o.op)) throw new EpEnvelopeError("internal", `the lifecycle head ${key} is retiring without its durable op intent (SPEC 13.1: retiring is op-bound)`);
  } else if (o.op !== undefined) {
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} carries an op intent in state "${o.state}" (SPEC 13.1: only retiring is op-bound)`);
  }
  if (o.op !== undefined) {
    const op = o.op as Record<string, unknown>;
    for (const k of Object.keys(op)) if (k !== "opId" && k !== "kind") throw new EpEnvelopeError("internal", `the lifecycle head ${key} op intent carries the unknown field "${k}" (closed schema)`);
    if (typeof op.opId !== "string" || op.kind !== "retirement")
      throw new EpEnvelopeError("internal", `the lifecycle head ${key} op intent does not validate (SPEC 13.1)`);
    try {
      assertLifecycleToken(op.opId);
    } catch {
      throw new EpEnvelopeError("internal", `the lifecycle head ${key} op intent carries a malformed opId (SPEC 13.1)`);
    }
  }
  return o as unknown as LifecycleMapping;
}

// ---- the issuance gate (auth store, agent family `gate.<lifecycleUid>`) ---------------------

/** The agent-family issuance gate row (§13.1, amended): `frozen` MUST carry the durable op
 *  intent; the embedded uid MUST agree with the key. (The disjoint ENDPOINT family
 *  `epgate.<endpoint>.<instanceId>` is separate.) */
export interface EpGateRow {
  lifecycleUid: string;
  state: "open" | "frozen" | "retired";
  /** Mint generation: born 0 under the activation freeze, first mintable generation is 1 (the
   *  activation's reopen), and every barrier reopen advances it. */
  generation: number;
  /** REQUIRED at `frozen` (which operation owns this freeze and may advance it) AND at
   *  `retired` (the terminalizing op, audit + same-op idempotence); absent at `open`.
   *  `successor` is a per-kind summary token (SPEC 13.1): only `takeover`/`registration`
   *  may carry one (their authoritative successor artifacts live under `stage.<opId>.`);
   *  `activation`/`retirement` never do. */
  op?: { opId: string; kind: "activation" | "takeover" | "registration" | "retirement"; successor?: string };
}

export const ISSUANCE_GATE_STATES: ReadonlySet<string> = new Set(["open", "frozen", "retired"]);
export const ISSUANCE_GATE_OP_KINDS: ReadonlySet<string> = new Set(["activation", "takeover", "registration", "retirement"]);

/** The gate key `gate.<lifecycleUid>` (§13.7). */
export function issuanceGateKey(lifecycleUid: string): string {
  return `gate.${assertLifecycleToken(lifecycleUid)}`;
}

/** Validate a gate row at the consuming boundary — CLOSED schema; key/uid agreement; the
 *  per-kind STATE x KIND transition invariants (§13.1). */
export function parseIssuanceGate(raw: Uint8Array, key: string, lifecycleUid: string): EpGateRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the issuance gate ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the issuance gate ${key} is not an object`);
  for (const k of Object.keys(o)) if (k !== "lifecycleUid" && k !== "state" && k !== "generation" && k !== "op") throw new EpEnvelopeError("internal", `the issuance gate ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (o.lifecycleUid !== lifecycleUid || typeof o.state !== "string" || !ISSUANCE_GATE_STATES.has(o.state) || !uint(o.generation))
    throw new EpEnvelopeError("internal", `the issuance gate ${key} does not validate (uid/state/generation); a garbled or key-mismatched gate never authorizes (SPEC 13.1)`);
  if ((o.state === "frozen" || o.state === "retired") && !isRec(o.op))
    throw new EpEnvelopeError("internal", `the issuance gate ${key} is ${o.state} without its durable op intent (SPEC 13.1: a frozen gate is op-bound, and a retired gate retains its terminalizing op)`);
  if (o.state === "open" && o.op !== undefined)
    throw new EpEnvelopeError("internal", `the issuance gate ${key} is open but carries an op intent (SPEC 13.1: open gates are not op-bound)`);
  if (o.op !== undefined) {
    const op = o.op as Record<string, unknown>;
    for (const k of Object.keys(op)) if (k !== "opId" && k !== "kind" && k !== "successor") throw new EpEnvelopeError("internal", `the issuance gate ${key} op intent carries the unknown field "${k}" (closed schema)`);
    if (typeof op.opId !== "string" || typeof op.kind !== "string" || !ISSUANCE_GATE_OP_KINDS.has(op.kind))
      throw new EpEnvelopeError("internal", `the issuance gate ${key} op intent does not validate (SPEC 13.1)`);
    // STATE x KIND invariant (SPEC 13.1 per-kind transition sets): only an activation orphan or
    // a retirement produces a `retired` gate, so a persisted `retired` gate carrying a
    // takeover/registration kind is IMPOSSIBLE state — refuse it at parse, never let the terminal
    // idempotence path return it as a settled success (fail-closed on corruption, not open).
    if (o.state === "retired" && op.kind !== "activation" && op.kind !== "retirement")
      throw new EpEnvelopeError("internal", `the issuance gate ${key} is retired under a ${op.kind} op; only an activation orphan or a retirement terminalizes (SPEC 13.1); impossible persisted state, refused`);
    if (op.successor !== undefined && (typeof op.successor !== "string" || op.successor.length === 0 || (op.kind !== "takeover" && op.kind !== "registration")))
      throw new EpEnvelopeError("internal", `the issuance gate ${key} op intent carries an invalid successor (SPEC 13.1: only takeover/registration stage successors, and the summary is a non-empty token)`);
    try {
      assertLifecycleToken(op.opId);
    } catch {
      throw new EpEnvelopeError("internal", `the issuance gate ${key} op intent carries a malformed opId (SPEC 13.1)`);
    }
  }
  return o as unknown as EpGateRow;
}

// ---- the credential-ledger row grammar (auth store, `cred.` / `epcred.` families) -----------

/** One KV key segment: no dots (a segment separator), no wildcards, KV-safe. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function assertKeySegment(v: unknown, what: string): string {
  if (typeof v !== "string" || !KEY_SEGMENT.test(v))
    throw new EpEnvelopeError("failed-precondition", `${what} ${JSON.stringify(v)} is not a KV-safe key segment (SPEC 13.1)`);
  return v;
}

/** A credential id: one or more KV-safe segments (dots allowed BETWEEN segments — the session
 *  families use `<sessionId>.c` / `<sessionId>.s` — but never wildcards or empty segments). */
export function assertCredentialIdTail(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 256 || !v.split(".").every((s) => KEY_SEGMENT.test(s)))
    throw new EpEnvelopeError("failed-precondition", `${what} ${JSON.stringify(v)} is not a bounded dotted credential id (SPEC 13.1)`);
  return v;
}

/** A holder principal `<owner>.<actor>` with a REAL owner (derived `u_…` or the dev owner) —
 *  eviction is BY PRINCIPAL, so a row that cannot name an evictable principal never ledgers. */
export function assertHolderPrincipal(v: unknown, what: string): string {
  const p = typeof v === "string" ? parsePrincipalKey(v) : null;
  if (!p || !isPrincipalOwnerToken(p.owner))
    throw new EpEnvelopeError("failed-precondition", `${what} ${JSON.stringify(v)} is not a principal dot-form the barrier can evict (SPEC 13.1)`);
  return v as string;
}

export const SOURCE_ROOT = "root";

/** Validate ONE sourceChain member — `root`, `handle.<issuerKeyId>.<id>`, or
 *  `session.<sessionId>` (SPEC 13.1) — and return its parsed shape. */
export function parseSourceMember(member: unknown): { kind: "root" } | { kind: "handle"; issuerKeyId: string; id: string } | { kind: "session"; sessionId: string } {
  if (member === SOURCE_ROOT) return { kind: "root" };
  if (typeof member === "string" && member.startsWith("handle.")) {
    const rest = member.slice("handle.".length).split(".");
    if (rest.length === 2 && KEY_SEGMENT.test(rest[0]) && KEY_SEGMENT.test(rest[1]))
      return { kind: "handle", issuerKeyId: rest[0], id: rest[1] };
  }
  if (typeof member === "string" && member.startsWith("session.")) {
    const sid = member.slice("session.".length);
    if (KEY_SEGMENT.test(sid)) return { kind: "session", sessionId: sid };
  }
  throw new EpEnvelopeError("failed-precondition", `sourceChain member ${JSON.stringify(member)} is not root | handle.<issuerKeyId>.<id> | session.<sessionId> (SPEC 13.1)`);
}

export function assertSourceChain(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a non-empty sourceChain (SPEC 13.1: the FULL verified lineage, never absent)`);
  for (const m of v) parseSourceMember(m);
  return v as string[];
}

/** The agent-family ledger key `cred.<lifecycleUid>.<credentialId>`. */
export function credRowKey(lifecycleUid: string, credentialId: string): string {
  return `cred.${assertLifecycleToken(lifecycleUid)}.${assertCredentialIdTail(credentialId, "credentialId")}`;
}
/** The endpoint-family ledger key `epcred.<endpoint>.<instanceId>.<credentialId>` (disjoint by
 *  explicit prefix, never arity, SPEC 13.1). */
export function epcredRowKey(endpoint: string, instanceId: string, credentialId: string): string {
  return `epcred.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.${assertCredentialIdTail(credentialId, "credentialId")}`;
}

/** The §13.1 credential-ledger row, closed. `lifecycleUid` is the HOLDER's KEY identity
 *  component: the managed agent's lifecycle UID in the `cred.` family, the endpoint instance's
 *  `instanceId` in the `epcred.` family (SPEC 13.1: `instanceId` is to an endpoint what
 *  `lifecycleUid` is to a managed agent). `endpoint` is present ONLY in the `epcred.` family
 *  (it forms the key there and is absent in `cred.`), so the KEY identity is never conflated
 *  with the eviction target. `holderPrincipal` is who the barrier KICKs: ALWAYS a CONNZ-
 *  attributable `<owner>.<actor>` dot-form (the caller principal in the `cred.` family; the
 *  serving instance's own connection principal in the `epcred.` family, recorded from the
 *  endpoint gate), NEVER the endpoint name (which CONNZ cannot attribute). */
export interface CredentialLedgerRow {
  credentialId: string;
  holderPrincipal: string;
  lifecycleUid: string;
  /** The endpoint NAME whose token forms the `epcred.` key; present iff this is an endpoint-
   *  family row, absent in the `cred.` family (which the lifecycleUid keys). */
  endpoint?: string;
  /** The FULL verified lineage at mint: `root` | `handle.<issuerKeyId>.<id>`… |
   *  `session.<sessionId>` (SPEC 13.1 — for a handle redemption EVERY handle in the presented
   *  chain, never only the leaf). */
  sourceChain: string[];
  /** Monotonic: `active → revoked` only; a revoked row is never deleted. */
  state: "active" | "revoked";
  exp: number;
}

/** Parse + validate a ledger row at its consuming boundary — closed schema, and the embedded
 *  identity MUST rebuild the row's own key, so a key-mismatched or family-swapped poison row
 *  never authorizes (SPEC 13.1/13.3). */
export function parseLedgerRow(raw: Uint8Array, key: string): CredentialLedgerRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the credential-ledger row ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the credential-ledger row ${key} is not an object`);
  const allowed = new Set(["credentialId", "holderPrincipal", "lifecycleUid", "endpoint", "sourceChain", "state", "exp"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the credential-ledger row ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (
    typeof o.credentialId !== "string" || typeof o.holderPrincipal !== "string" || typeof o.lifecycleUid !== "string" ||
    (o.state !== "active" && o.state !== "revoked") || !uint(o.exp)
  )
    throw new EpEnvelopeError("internal", `the credential-ledger row ${key} does not validate (id/holder/uid/state/exp); a garbled row never authorizes (SPEC 13.1)`);
  try {
    assertSourceChain(o.sourceChain, `row ${key} sourceChain`);
    assertCredentialIdTail(o.credentialId, `row ${key} credentialId`);
    // holderPrincipal is ALWAYS a CONNZ-attributable principal, in BOTH families (the barrier
    // KICKs it; the endpoint name is NOT attributable and never sits here).
    assertHolderPrincipal(o.holderPrincipal, `row ${key} holderPrincipal`);
  } catch (e) {
    throw new EpEnvelopeError("internal", `the credential-ledger row ${key} carries a malformed lineage/id/holder: ${(e as Error).message}`);
  }
  // KEY BINDING, per family: the row's own identity must rebuild its key exactly. The endpoint
  // family keys on its own `endpoint` field (NOT holderPrincipal), so the key identity and the
  // eviction target stay disjoint.
  let expected: string;
  if (key.startsWith("cred.")) {
    if (o.endpoint !== undefined)
      throw new EpEnvelopeError("internal", `the agent-family row ${key} carries an endpoint field (that belongs to the epcred family, SPEC 13.1)`);
    expected = credRowKey(o.lifecycleUid, o.credentialId);
  } else if (key.startsWith("epcred.")) {
    if (typeof o.endpoint !== "string" || o.endpoint.length === 0)
      throw new EpEnvelopeError("internal", `the endpoint-family row ${key} is missing its endpoint field (it forms the key, SPEC 13.1)`);
    try {
      expected = epcredRowKey(o.endpoint, o.lifecycleUid, o.credentialId);
    } catch (e) {
      throw new EpEnvelopeError("internal", `the credential-ledger row ${key} does not validate for the endpoint family: ${(e as Error).message}`);
    }
  } else {
    throw new EpEnvelopeError("internal", `the credential-ledger row key ${key} is under neither ledger family prefix (SPEC 13.1)`);
  }
  if (expected !== key)
    throw new EpEnvelopeError("internal", `the credential-ledger row at ${key} embeds an identity that rebuilds ${expected}; a key-mismatched row never authorizes (SPEC 13.1)`);
  return o as unknown as CredentialLedgerRow;
}
