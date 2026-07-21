/**
 * The §13.1 lifecycle SAGA SEQUENCING: the one shared CAS state machine over the lifecycle
 * state grammar (`lifecycle-state.ts`) — uid reservation, issuance-gate transitions, alias-head
 * transitions, the initial-activation saga (reserve → gate frozen → head CAS → reopen LAST) with
 * its crash-resume, and the barrier-internal head steps (epoch advance, root stamp, retirement
 * begin/complete).
 *
 * Three-way split (the Unit B design note, panel-locked): the key/value GRAMMAR lives in
 * `lifecycle-state.ts`; THIS module is the SEQUENCING, parameterized by an injected
 * {@link LifecycleStateTransport} so every executor (the user-mesh auth service over its sealed
 * registry, the manager's static adapter over its direct KV binding) drives the SAME saga —
 * the adapters are TRANSPORT, never a second copy of this state machine. The barrier
 * ORCHESTRATION (credential revoke, cluster-verified eviction, ledger enumeration) is
 * deliberately NOT here: it stays with the user-mode executor in implementations/auth.
 *
 * Authority note: this module grants nothing. A transport is constructed only by an executor
 * that already holds its stores' authenticated bindings; every fence below is the store's own
 * revision-pinned CAS, and an `opId` is an identifier, never a bearer capability (§13.1).
 */
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { isCasLoss as isRawCasLoss } from "./endpoint-records.js";
import { mintLifecycleUid, assertLifecycleToken } from "./subjects.js";
import {
  type LifecycleMapping,
  type EpGateRow,
  lifecycleHeadKey as headKey,
  uidReservationKey as uidKey,
  issuanceGateKey as gateKey,
  parseLifecycleHead as parseMapping,
  parseIssuanceGate as parseGate,
} from "./lifecycle-state.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCasLoss = (e: unknown): boolean => e instanceof EpEnvelopeError && e.code === "conflict";

/** One raw store entry as the sequencing consumes it (a KV entry stripped to what a CAS needs). */
export interface LifecycleKvEntry {
  value: Uint8Array;
  revision: number;
  operation: string;
}

/**
 * The injected write transport (§13.1 three-way split): the ONLY store access this sequencing
 * uses. `getRecord`/`createRecord`/`updateRecord` bind the space's RECORDS store (head + uid
 * keys; create/update map a CAS loss to an `EpEnvelopeError` `conflict`, the contract of core
 * `createRecordEntry`/`updateRecordEntry`); `getAuth`/`putAuth` bind the AUTH store (gate keys;
 * `putAuth` throws the broker's RAW error on a CAS loss — this module classifies it). A
 * transport implementation carries no sequencing decisions of its own.
 */
export interface LifecycleStateTransport {
  getRecord(key: string): Promise<LifecycleKvEntry | undefined>;
  createRecord(key: string, value: unknown): Promise<number>;
  updateRecord(key: string, value: unknown, expectedRevision: number): Promise<number>;
  getAuth(key: string): Promise<LifecycleKvEntry | undefined>;
  putAuth(key: string, payload: Uint8Array, expectedRevision: number): Promise<number>;
}

// ---- candidate reads ------------------------------------------------------------------------

/** Candidate read for a CAS-fenced head mutation (raw get; the auth decision is the CAS itself,
 *  §13.1: a read is never a fence). A DEL/PURGE marker is CORRUPTION, never absence. */
export async function headCandidate(
  t: LifecycleStateTransport,
  owner: string,
  actor: string,
): Promise<{ mapping: LifecycleMapping; revision: number } | undefined> {
  const key = headKey(owner, actor);
  const entry = await t.getRecord(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the lifecycle head ${key} carries a ${entry.operation} marker; an authority head is never deleted (a deletion is corruption, not absence, SPEC 13.12)`);
  return { mapping: parseMapping(entry.value, key, owner, actor), revision: entry.revision };
}

/** Observe the gate (the candidate read feeding a revision-pinned CAS). A DEL/PURGE marker
 *  refuses loudly. */
export async function gateObserve(
  t: LifecycleStateTransport,
  lifecycleUid: string,
): Promise<{ row: EpGateRow; revision: number } | undefined> {
  const key = gateKey(lifecycleUid);
  const entry = await t.getAuth(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate ${key} carries a ${entry.operation} marker; a gate is never deleted (a deletion is corruption, not absence, SPEC 13.12)`);
  return { row: parseGate(entry.value, key, lifecycleUid), revision: entry.revision };
}

async function putGate(t: LifecycleStateTransport, lifecycleUid: string, row: EpGateRow, expectedRevision: number): Promise<number> {
  try {
    return await t.putAuth(gateKey(lifecycleUid), enc.encode(JSON.stringify(row)), expectedRevision);
  } catch (e) {
    if (isRawCasLoss(e))
      throw new EpEnvelopeError("conflict", `the issuance gate CAS for ${gateKey(lifecycleUid)} lost (expected revision ${expectedRevision}); re-read and re-decide (SPEC 13.8)`);
    throw e;
  }
}

// ---- the space-global UID reservation --------------------------------------------------------

/** Try to reserve ONE explicit candidate UID. Create-only: `"won"` reserves it forever;
 *  `"burned"` means the candidate already exists OR carries a deletion marker — either way it
 *  is unusable, per the never-reuse rule. */
export async function uidTryReserve(
  t: LifecycleStateTransport,
  lifecycleUid: string,
  audit: { owner: string; actor: string; mintedBy: string },
): Promise<"won" | "burned"> {
  assertLifecycleToken(lifecycleUid);
  try {
    await t.createRecord(uidKey(lifecycleUid), { owner: audit.owner, actor: audit.actor, mintedBy: audit.mintedBy });
    return "won";
  } catch (e) {
    if (isCasLoss(e)) return "burned";
    throw e;
  }
}

/** Reserve a fresh lifecycle UID space-globally (§13.1): mint a CSPRNG candidate, win its
 *  create-only reservation, and on a collision burn the candidate and draw another. */
export async function uidReserveFresh(
  t: LifecycleStateTransport,
  audit: { owner: string; actor: string; mintedBy: string },
): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const candidate = mintLifecycleUid();
    if ((await uidTryReserve(t, candidate, audit)) === "won") return candidate;
  }
  throw new EpEnvelopeError("internal", "four fresh 128-bit UID candidates collided with existing reservations; that is not chance; inspect the uid.> family (SPEC 13.1)");
}

/** Read a UID reservation's audit `{ owner, actor }` (recorded at {@link uidTryReserve}). A
 *  DEL/PURGE marker refuses loudly. */
export async function uidReadReservation(
  t: LifecycleStateTransport,
  lifecycleUid: string,
): Promise<{ owner: string; actor: string } | undefined> {
  const entry = await t.getRecord(uidKey(assertLifecycleToken(lifecycleUid)));
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the uid reservation for ${lifecycleUid} carries a ${entry.operation} marker; a reservation is never deleted (corruption, SPEC 13.12)`);
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(entry.value));
  } catch {
    throw new EpEnvelopeError("internal", `the uid reservation for ${lifecycleUid} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o) || typeof o.owner !== "string" || typeof o.actor !== "string" || o.owner.length === 0 || o.actor.length === 0)
    throw new EpEnvelopeError("internal", `the uid reservation for ${lifecycleUid} does not carry a valid owner/actor audit (SPEC 13.1)`);
  return { owner: o.owner, actor: o.actor };
}

// ---- the issuance-gate CAS transitions -------------------------------------------------------

/** Create the gate FROZEN under its operation's durable intent (create-only). A gate is BORN
 *  only under an ACTIVATION intent, and only for a UID whose space-global reservation was
 *  already WON. Born unmintable at generation 0. */
export async function gateCreateFrozen(
  t: LifecycleStateTransport,
  args: { lifecycleUid: string; op: { opId: string; kind: "activation" } },
): Promise<{ row: EpGateRow; revision: number }> {
  if (args.op.kind !== "activation")
    throw new EpEnvelopeError("failed-precondition", `an issuance gate is born only under an activation intent, not "${String(args.op.kind)}" (SPEC 13.1: other operations freeze an existing open gate)`);
  const reservation = await t.getRecord(uidKey(assertLifecycleToken(args.lifecycleUid)));
  if (!reservation)
    throw new EpEnvelopeError("failed-precondition", `no uid reservation exists for ${args.lifecycleUid}; the reservation is won BEFORE any gate or head write (SPEC 13.1)`);
  if (reservation.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the uid reservation for ${args.lifecycleUid} carries a ${reservation.operation} marker; a reservation is never deleted (corruption, not absence, SPEC 13.12)`);
  const row: EpGateRow = { lifecycleUid: args.lifecycleUid, state: "frozen", generation: 0, op: { opId: assertLifecycleToken(args.op.opId), kind: "activation" } };
  const revision = await putGate(t, args.lifecycleUid, row, 0);
  return { row, revision };
}

/** CAS the gate `open → frozen` carrying the freezing operation's durable intent, at the
 *  observed revision. The bar of every barrier. */
export async function gateFreeze(
  t: LifecycleStateTransport,
  args: { lifecycleUid: string; revision: number; op: { opId: string; kind: "takeover" | "registration" | "retirement"; successor?: string } },
): Promise<{ row: EpGateRow; revision: number }> {
  if (args.op.successor !== undefined && args.op.kind === "retirement")
    throw new EpEnvelopeError("failed-precondition", "a retirement freeze carries no successor (SPEC 13.1: a retirement has none)");
  if (args.op.successor !== undefined && args.op.successor.length === 0)
    throw new EpEnvelopeError("failed-precondition", "the freeze carries an empty successor token; a summary token is a non-empty stage.<opId> reference or absent (SPEC 13.1); validate before the CAS, never persist corruption");
  const current = await gateObserve(t, args.lifecycleUid);
  if (current === undefined) throw new EpEnvelopeError("not-found", `the issuance gate for ${args.lifecycleUid} does not exist (SPEC 13.1)`);
  if (current.row.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}", not open; only an open gate freezes (a frozen/retired gate belongs to its own operation, SPEC 13.1)`);
  const op: EpGateRow["op"] = { opId: assertLifecycleToken(args.op.opId), kind: args.op.kind };
  if (args.op.successor !== undefined) op.successor = args.op.successor;
  const row: EpGateRow = { lifecycleUid: current.row.lifecycleUid, state: "frozen", generation: current.row.generation, op };
  const revision = await putGate(t, args.lifecycleUid, row, args.revision);
  return { row, revision };
}

/** CAS the gate `frozen → open` at the NEXT generation — op-pinned: only the freeze's own
 *  operation reopens, as its barrier's final step. NEVER retirement (a retirement freeze never
 *  reopens; its only exit is the terminal). */
export async function gateReopen(
  t: LifecycleStateTransport,
  args: { lifecycleUid: string; revision: number; opId: string },
): Promise<{ row: EpGateRow; revision: number }> {
  const current = await gateObserve(t, args.lifecycleUid);
  if (current === undefined) throw new EpEnvelopeError("not-found", `the issuance gate for ${args.lifecycleUid} does not exist (SPEC 13.1)`);
  if (current.row.state !== "frozen")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}", not frozen; there is no freeze to reopen (SPEC 13.1)`);
  if (current.row.op?.opId !== args.opId)
    throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} is frozen by operation ${current.row.op?.opId ?? "<none>"}, not ${args.opId}; only the completing operation reopens its own freeze (SPEC 13.1)`);
  if (current.row.op.kind === "retirement")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is frozen by a RETIREMENT; a retirement freeze never reopens (SPEC 13.1: its only exit is the terminal)`);
  const row: EpGateRow = { lifecycleUid: current.row.lifecycleUid, state: "open", generation: current.row.generation + 1 };
  const revision = await putGate(t, args.lifecycleUid, row, args.revision);
  return { row, revision };
}

/** CAS the gate `frozen → retired` (terminal; never reopened) — op-pinned like the reopen. Only
 *  an ACTIVATION orphan or a RETIREMENT terminalizes. Idempotence at `retired` is SAME-OP
 *  idempotence. */
export async function gateRetire(
  t: LifecycleStateTransport,
  args: { lifecycleUid: string; revision: number; opId: string },
): Promise<{ row: EpGateRow; revision: number }> {
  const current = await gateObserve(t, args.lifecycleUid);
  if (current === undefined) throw new EpEnvelopeError("not-found", `the issuance gate for ${args.lifecycleUid} does not exist (SPEC 13.1)`);
  if (current.row.state === "retired") {
    if (current.row.op?.opId !== args.opId)
      throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} was terminalized by operation ${current.row.op?.opId ?? "<none>"}, not ${args.opId}; terminal idempotence is same-op idempotence (SPEC 13.1)`);
    return current; // idempotent terminal, same op
  }
  if (current.row.state !== "frozen")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}"; only a frozen gate terminalizes (freeze first; the bar precedes the terminal, SPEC 13.1)`);
  if (current.row.op?.opId !== args.opId)
    throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} is frozen by operation ${current.row.op?.opId ?? "<none>"}, not ${args.opId}; only the owning operation terminalizes its freeze (SPEC 13.1)`);
  if (current.row.op.kind !== "activation" && current.row.op.kind !== "retirement")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is frozen by a ${current.row.op.kind}; only an activation orphan or a retirement terminalizes (a ${current.row.op.kind} aborts by reopening, SPEC 13.1)`);
  const row: EpGateRow = { lifecycleUid: current.row.lifecycleUid, state: "retired", generation: current.row.generation, op: current.row.op };
  const revision = await putGate(t, args.lifecycleUid, row, args.revision);
  return { row, revision };
}

// ---- the barrier-internal head transitions ---------------------------------------------------

/** The takeover barrier's epoch-advance head CAS. Advances the epoch by exactly one,
 *  revision-pinned, only while the head is ACTIVE at the SAME uid; clears the revoked root
 *  stamp in the SAME CAS; idempotent only for the barrier's OWN completed advance. */
export async function headAdvanceEpochWithinTakeover(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; lifecycleUid: string; fromEpoch: number; opId: string },
): Promise<"advanced" | "already-advanced"> {
  const cur = await headCandidate(t, args.owner, args.actor);
  if (cur === undefined || cur.mapping.state !== "active" || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the takeover epoch advance for "${args.owner}/${args.actor}" requires an ACTIVE head at uid ${args.lifecycleUid}; found ${cur === undefined ? "no head" : `${cur.mapping.state} at ${cur.mapping.lifecycleUid}`} (SPEC 13.1)`);
  if (cur.mapping.processEpoch === args.fromEpoch + 1) {
    if (cur.mapping.lastTakeoverOpId !== args.opId)
      throw new EpEnvelopeError("conflict", `the head for "${args.owner}/${args.actor}" is at epoch ${args.fromEpoch + 1} advanced by operation ${cur.mapping.lastTakeoverOpId ?? "<none>"}, not ${args.opId}; a concurrent takeover won and this operation lost (SPEC 13.1)`);
    if (cur.mapping.currentCredentialId !== undefined)
      throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" advanced under takeover ${args.opId} but still names root credential ${cur.mapping.currentCredentialId}; the epoch CAS clears it atomically, so a residual stamp is impossible persisted state (SPEC 13.1)`);
    return "already-advanced";
  }
  if (cur.mapping.processEpoch !== args.fromEpoch)
    throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" is at epoch ${cur.mapping.processEpoch}, not the takeover's captured epoch ${args.fromEpoch} (or its +1); a foreign operation moved it (SPEC 13.1)`);
  const { currentCredentialId: _revoked, ...rest } = cur.mapping;
  void _revoked;
  await t.updateRecord(headKey(args.owner, args.actor), { ...rest, processEpoch: args.fromEpoch + 1, lastTakeoverOpId: assertLifecycleToken(args.opId) }, cur.revision);
  return "advanced";
}

/** The issuance path's head CAS stamping the incarnation's ROOT credential — the mint protocol's
 *  RELEASE-LAST final step. ABSENT → value ONLY (idempotent for the SAME value): root ROTATION
 *  is exclusively a barrier's job, never this seam's. */
export async function headSetCurrentRootCredential(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; lifecycleUid: string; credentialId: string },
): Promise<void> {
  if (typeof args.credentialId !== "string" || args.credentialId.length === 0)
    throw new EpEnvelopeError("failed-precondition", "setCurrentRootCredential requires a credentialId");
  const cur = await headCandidate(t, args.owner, args.actor);
  if (cur === undefined || cur.mapping.state !== "active" || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `stamping the root credential for "${args.owner}/${args.actor}" requires an ACTIVE head at uid ${args.lifecycleUid}; found ${cur === undefined ? "no head" : `${cur.mapping.state} at ${cur.mapping.lifecycleUid}`} (SPEC 13.1)`);
  if (cur.mapping.currentCredentialId === args.credentialId) return; // our own completed stamp
  if (cur.mapping.currentCredentialId !== undefined)
    throw new EpEnvelopeError("permission-denied", `the head for "${args.owner}/${args.actor}" already names root credential ${cur.mapping.currentCredentialId}; rotating it takes the full family-revoke barrier, never a bare head flip (the old root's descendants would stay connectable under the leaf check, SPEC 13.1)`);
  await t.updateRecord(headKey(args.owner, args.actor), { ...cur.mapping, currentCredentialId: args.credentialId }, cur.revision);
}

/** The retirement's head CONTAINMENT CAS (`active → retiring`, bound to the retirement
 *  operation's durable intent). Idempotent for the operation's crash-resume; a stranger never
 *  advances it. */
export async function headBeginRetirement(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"retiring" | "already-retiring"> {
  const cur = await headCandidate(t, args.owner, args.actor);
  if (cur === undefined || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the retirement of uid ${args.lifecycleUid} requires the head for "${args.owner}/${args.actor}" to name it; found ${cur === undefined ? "no head" : `uid ${cur.mapping.lifecycleUid}`} (SPEC 13.1)`);
  if (cur.mapping.state === "retiring") {
    if (cur.mapping.op?.opId !== args.opId)
      throw new EpEnvelopeError("permission-denied", `the head for "${args.owner}/${args.actor}" is retiring under operation ${cur.mapping.op?.opId ?? "<none>"}, not ${args.opId}; one retirement at a time, and a stranger never advances it (SPEC 13.1)`);
    return "already-retiring";
  }
  if (cur.mapping.state !== "active")
    throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" is "${cur.mapping.state}", not active; only an active head enters retirement containment (a completed terminal is decided at the gate, never re-entered here, SPEC 13.1)`);
  await t.updateRecord(headKey(args.owner, args.actor), { ...cur.mapping, state: "retiring", op: { opId: assertLifecycleToken(args.opId), kind: "retirement" } }, cur.revision);
  return "retiring";
}

/** The retirement's TERMINAL head CAS (`retiring → retired`, op-pinned) — the LAST step:
 *  `retired` ASSERTS completed cleanup, which is what makes the alias replaceable. The op
 *  intent is dropped (it belongs to `retiring` only). */
export async function headCompleteRetirement(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"retired" | "already-retired"> {
  const cur = await headCandidate(t, args.owner, args.actor);
  if (cur === undefined || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the retirement terminal for uid ${args.lifecycleUid} requires the head for "${args.owner}/${args.actor}" to name it; found ${cur === undefined ? "no head" : `uid ${cur.mapping.lifecycleUid}`}; a replaced head is settled at the gate, never here (SPEC 13.1)`);
  if (cur.mapping.state === "retired") return "already-retired";
  if (cur.mapping.state !== "retiring" || cur.mapping.op?.opId !== args.opId)
    throw new EpEnvelopeError("permission-denied", `the head for "${args.owner}/${args.actor}" is ${cur.mapping.state === "retiring" ? `retiring under operation ${cur.mapping.op?.opId ?? "<none>"}` : `"${cur.mapping.state}"`}, not retiring under ${args.opId}; only the containing operation terminalizes its own retirement (SPEC 13.1)`);
  const { op: _op, ...rest } = cur.mapping;
  void _op;
  await t.updateRecord(headKey(args.owner, args.actor), { ...rest, state: "retired" }, cur.revision);
  return "retired";
}

// ---- the activation saga (§13.1: reserve → gate frozen → head CAS → reopen LAST) -------------

/** The full §13.1 initial-activation saga for a FRESH uid. See the executor's public doc
 *  (implementations/auth `activateLifecycle`) for the refusal matrix; the head-CAS loser
 *  terminalizes its own orphan gate (uid stays burned) and rethrows the `conflict`. */
export async function runActivationSaga(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; managerInstance: string },
): Promise<{ mapping: LifecycleMapping; revision: number; opId: string }> {
  const { owner, actor } = args;
  if (typeof args.managerInstance !== "string" || args.managerInstance.length === 0)
    throw new EpEnvelopeError("failed-precondition", "activateLifecycle requires a managerInstance (the minting authority)");
  const current = await headCandidate(t, owner, actor);
  if (current !== undefined && current.mapping.state === "active")
    throw new EpEnvelopeError("already-exists", `lifecycle "${owner}/${actor}" is already active (uid ${current.mapping.lifecycleUid}); a takeover advances the epoch through its barrier, it does not re-activate (SPEC 13.1)`);
  if (current !== undefined && current.mapping.state === "retiring")
    throw new EpEnvelopeError("failed-precondition", `lifecycle "${owner}/${actor}" is retiring (op ${current.mapping.op?.opId}); a retiring alias is not replaceable until its barrier completes (SPEC 13.1)`);
  const opId = mintLifecycleUid();
  // 1. Win the space-global UID reservation.
  const lifecycleUid = await uidReserveFresh(t, { owner, actor, mintedBy: args.managerInstance });
  // 2. Create the gate FROZEN under this activation's durable intent (unmintable from birth).
  const gate = await gateCreateFrozen(t, { lifecycleUid, op: { opId, kind: "activation" } });
  // 3. CAS the alias head (create-only for virgin; revision-pinned over the retired predecessor).
  const mapping: LifecycleMapping = { owner, actor, lifecycleUid, managerInstance: args.managerInstance, processEpoch: 1, state: "active" };
  let revision: number;
  try {
    revision = current === undefined
      ? await t.createRecord(headKey(owner, actor), mapping)
      : await t.updateRecord(headKey(owner, actor), mapping, current.revision);
  } catch (e) {
    if (isCasLoss(e)) {
      // The loser terminalizes ITS OWN orphan gate; its UID stays burned (never deleted, never
      // reused). A cleanup failure is NEVER swallowed as success: the caller gets the durable
      // coordinates and resumes the SAME op (resumeActivationSaga) to finish the terminalization.
      try {
        await gateRetire(t, { lifecycleUid, revision: gate.revision, opId });
      } catch (cleanup) {
        throw new EpEnvelopeError(
          "unavailable",
          `lifecycle activation for "${owner}/${actor}" lost the head CAS AND terminalizing its orphan gate failed; the uid ${lifecycleUid} is burned but its gate is still frozen by op ${opId}; resume the same op with resumeActivation: ${(cleanup as Error)?.message ?? String(cleanup)}`,
          [{ kind: "resume-activation", owner, actor, lifecycleUid, opId }],
        );
      }
      throw new EpEnvelopeError("conflict", `lifecycle activation for "${owner}/${actor}" lost the head CAS (a concurrent activation won); this saga's uid ${lifecycleUid} is burned and its gate terminalized (SPEC 13.1)`);
    }
    throw e;
  }
  // 4. Reopen the gate at its first mintable generation — the saga's LAST step.
  await gateReopen(t, { lifecycleUid, revision: gate.revision, opId });
  return { mapping, revision, opId };
}

/** The production ISSUANCE activation AT THE CALLER'S uid: same saga order with
 *  ADOPT-instead-of-burn resume semantics (a reservation or frozen ACTIVATION gate already
 *  carried by OUR alias at this uid is prior durable progress; a CAS loss to a SIBLING at the
 *  same coordinates converges on the winner's state). See the executor's public doc
 *  (implementations/auth `activateLifecycleAtUid`) for the refusal matrix. */
export async function runActivationSagaAtUid(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; lifecycleUid: string; managerInstance: string },
): Promise<void> {
  const { owner, actor, lifecycleUid } = args;
  assertLifecycleToken(lifecycleUid);
  if (typeof args.managerInstance !== "string" || args.managerInstance.length === 0)
    throw new EpEnvelopeError("failed-precondition", "activateLifecycleAtUid requires a managerInstance (the minting authority)");
  const current = await headCandidate(t, owner, actor);
  if (current !== undefined && current.mapping.state === "active" && current.mapping.lifecycleUid !== lifecycleUid)
    throw new EpEnvelopeError("already-exists", `lifecycle "${owner}/${actor}" is active at uid ${current.mapping.lifecycleUid}, not this grant's ${lifecycleUid}; retiring a live predecessor is the takeover barrier's job and production issuance does not run it (R1) - despawn/retire the predecessor first, or grant a fresh actor name (SPEC 13.1)`);
  if (current !== undefined && current.mapping.state === "retiring")
    throw new EpEnvelopeError("failed-precondition", `lifecycle "${owner}/${actor}" is retiring (op ${current.mapping.op?.opId}); a retiring alias is not replaceable until its barrier completes (SPEC 13.1)`);
  const headIsOurs = current !== undefined && current.mapping.state === "active"; // same uid, by the guard above

  // 1. The uid reservation: win it, or adopt a prior attempt's — SAME alias only.
  if (!headIsOurs && (await uidTryReserve(t, lifecycleUid, { owner, actor, mintedBy: args.managerInstance })) === "burned") {
    const res = await uidReadReservation(t, lifecycleUid);
    if (res === undefined || res.owner !== owner || res.actor !== actor)
      throw new EpEnvelopeError("permission-denied", `uid ${lifecycleUid} is reserved by ${res ? `"${res.owner}/${res.actor}"` : "an unreadable reservation"}, not "${owner}/${actor}"; a grant's uid is never adopted across aliases (SPEC 13.1)`);
  }

  // 2. The activation gate: create frozen, or adopt OUR prior attempt's frozen activation gate
  //    (the reservation above already binds this uid to this alias, so any activation freeze on
  //    it is this alias's own activation). A retry loop absorbs the sibling-race CAS losses.
  for (let attempt = 0; ; attempt++) {
    if (attempt > 4)
      throw new EpEnvelopeError("unavailable", `activation for "${owner}/${actor}" at uid ${lifecycleUid} keeps losing its gate/head CASes to concurrent movement; re-read and re-decide (SPEC 13.1)`);
    let gate = await gateObserve(t, lifecycleUid);
    let opId: string;
    if (gate === undefined) {
      try {
        gate = await gateCreateFrozen(t, { lifecycleUid, op: { opId: mintLifecycleUid(), kind: "activation" } });
      } catch (e) {
        if (isCasLoss(e)) continue; // a sibling created it; re-observe and adopt
        throw e;
      }
      opId = gate.row.op!.opId;
    } else if (gate.row.state === "frozen") {
      if (gate.row.op?.kind !== "activation")
        throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${lifecycleUid} is frozen by a ${gate.row.op?.kind ?? "<unknown>"} (op ${gate.row.op?.opId ?? "<none>"}); a barrier is in flight - issuance activation neither adopts nor overrides it (SPEC 13.1)`);
      opId = gate.row.op.opId;
    } else if (gate.row.state === "retired") {
      throw new EpEnvelopeError("permission-denied", `uid ${lifecycleUid} has a terminally retired issuance gate; a burned uid never re-activates - re-grant the actor for a fresh incarnation (SPEC 13.1)`);
    } else {
      // Open gate: the saga writes the head BEFORE its reopen, so an open gate with the head
      // active at our uid is a COMPLETED activation; anything else is foreign movement.
      const head = await headCandidate(t, owner, actor);
      if (head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === lifecycleUid) return;
      throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${lifecycleUid} is open but the head for "${owner}/${actor}" is ${head === undefined ? "absent" : `${head.mapping.state} at ${head.mapping.lifecycleUid}`}; an activation reopens only AFTER its head CAS - this is foreign movement or corruption, refuse (SPEC 13.1/13.12)`);
    }

    // 3. The head CAS (create-only for virgin; revision-pinned over a retired predecessor). A
    //    loss converges if the sibling won for the SAME uid, refuses on a foreign winner.
    if (!headIsOurs) {
      const mapping: LifecycleMapping = { owner, actor, lifecycleUid, managerInstance: args.managerInstance, processEpoch: 1, state: "active" };
      try {
        if (current === undefined) await t.createRecord(headKey(owner, actor), mapping);
        else await t.updateRecord(headKey(owner, actor), mapping, current.revision);
      } catch (e) {
        if (!isCasLoss(e)) throw e;
        const head = await headCandidate(t, owner, actor);
        if (!(head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === lifecycleUid))
          throw new EpEnvelopeError("conflict", `activation for "${owner}/${actor}" at uid ${lifecycleUid} lost the head CAS to a foreign movement (now ${head === undefined ? "absent" : `${head.mapping.state} at ${head.mapping.lifecycleUid}`}); re-grant raced this exchange - re-exchange (SPEC 13.1)`);
      }
    }

    // 4. Reopen the gate — the saga's LAST step. A loss to the sibling's reopen is convergence.
    try {
      await gateReopen(t, { lifecycleUid, revision: gate.revision, opId });
      return;
    } catch (e) {
      const g = await gateObserve(t, lifecycleUid);
      if (g !== undefined && g.row.state === "open") return; // the sibling finished it
      if (e instanceof EpEnvelopeError && e.code === "conflict") continue; // revision moved; re-observe
      throw e;
    }
  }
}

/** Resume a crashed activation saga from its durable coordinates. Reads the durable state and
 *  finishes the SAME operation deterministically; idempotent; never advances another
 *  operation's freeze. */
export async function resumeActivationSaga(
  t: LifecycleStateTransport,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"completed" | "terminalized" | "already-settled"> {
  const head = await headCandidate(t, args.owner, args.actor);
  const gate = await gateObserve(t, args.lifecycleUid);
  const won = head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === args.lifecycleUid;
  if (gate === undefined) {
    // Crash before step 2: nothing durable beyond the reservation; the uid stays burned.
    if (won) throw new EpEnvelopeError("internal", `the head names uid ${args.lifecycleUid} but its gate does not exist; an active head without a gate is corruption (SPEC 13.1)`);
    return "already-settled";
  }
  if (gate.row.state === "retired") {
    // Terminal idempotence is SAME-OP idempotence: a stranger cannot claim another
    // operation's terminal as its own settlement.
    if (gate.row.op?.opId !== args.opId)
      throw new EpEnvelopeError("permission-denied", `the gate for uid ${args.lifecycleUid} was terminalized by operation ${gate.row.op?.opId ?? "<none>"}, not ${args.opId} (SPEC 13.1)`);
    return "already-settled";
  }
  if (gate.row.state === "open") {
    if (!won)
      throw new EpEnvelopeError("internal", `the gate for uid ${args.lifecycleUid} is open but the head does not name it; an open gate without its active head is corruption (SPEC 13.1)`);
    return "already-settled";
  }
  // frozen: only OUR op may advance it (reopen/retire are op-pinned and will refuse a stranger).
  if (won) {
    await gateReopen(t, { lifecycleUid: args.lifecycleUid, revision: gate.revision, opId: args.opId });
    return "completed";
  }
  await gateRetire(t, { lifecycleUid: args.lifecycleUid, revision: gate.revision, opId: args.opId });
  return "terminalized";
}
