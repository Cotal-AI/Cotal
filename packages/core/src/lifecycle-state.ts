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
import { assertLifecycleToken } from "./endpoint-subjects.js";

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
