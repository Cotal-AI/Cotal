/**
 * The D13 generic lifecycle registry (SPEC §13.1): the production KV owner of the lifecycle
 * identity the manager, delivery, serve, session, and virtual-endpoint paths all authenticate
 * against. This first slice is the LIFECYCLE HEAD registry — the unsplit `lifecycle.<owner>.<actor>`
 * mapping head in the per-space records store (`cotal_records_<space>`, §13.7) — plus the
 * leader-served mapping reader that backs the `readProcessEpoch` seam D11 (restart supervision,
 * status commit) and D7 (session redemption) inject today. The KV issuance gate + barrier
 * (`gate.<endpoint>.<lifecycleUid>` in the auth store) and the credential ledger land in the
 * next slices over this foundation.
 *
 * The head is the §13.1 activation/retirement LINEARIZATION POINT:
 *  - it is a SINGLE unsplit key, so activation, process-epoch advance (takeover/restart), and
 *    terminal retirement all serialize on ONE key's revision — a read is never a fence, every
 *    transition is a revision-pinned CAS write;
 *  - the lifecycle UID is minted ONCE per incarnation and RECORDED in the head, never re-minted
 *    per process; it is unguessable, and NEVER REUSED — a re-activation of a retired alias mints
 *    a FRESH uid at a bumped generation, so a stale bearer of the predecessor's uid can never
 *    name the successor's resources;
 *  - the head is NEVER-DELETED (the §13.12 authority-key discipline): a reader treats only TRUE
 *    ABSENCE as a virgin alias, and a deletion marker refuses LOUDLY as corruption, never as
 *    absence — the create-only CAS (which conflicts on a deletion marker) makes reuse-over-DEL
 *    impossible;
 *  - the authoritative epoch/state read that GATES egress authority is FENCING by use, so it is
 *    leader-served `STREAM.MSG.GET` ({@link readLifecycleHeadLeader}), never a follower Direct Get
 *    the records bucket's `allow_direct=true` would otherwise permit.
 */
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError,
  LIFECYCLE_HEAD,
  recordAtomicKey,
  createRecordEntry,
  updateRecordEntry,
  readRecordLeader,
  mintLifecycleUid,
  assertLifecycleToken,
} from "@cotal-ai/core";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isCasLoss = (e: unknown): boolean => e instanceof EpEnvelopeError && e.code === "conflict";

/**
 * The `lifecycle.<owner>.<actor>` head value (§13.1). One incarnation of an alias: its minted
 * uid, the manager that supervises it, its fenced process epoch, its state, and the generation
 * that advances on each (re)activation so a stale uid can never be confused with a successor.
 */
export interface LifecycleHead {
  owner: string;
  actor: string;
  /** The never-reused lifecycle UID of THIS incarnation (a fresh mint per activation). */
  lifecycleUid: string;
  /** The manager instance that minted/supervises this incarnation. */
  managerInstance: string;
  /** The fenced process epoch — advanced on takeover/supervised restart (§13.1: live authority
   *  dies on restart; egress binds this). */
  processEpoch: number;
  /** `active` while the incarnation may mint/serve; `retired` is terminal for THIS incarnation
   *  (a later activation of the alias is a NEW incarnation at a bumped generation + fresh uid). */
  state: "active" | "retired";
  /** Bumped on every activation of the alias, so `(alias, generation)` names one incarnation and
   *  a stale uid/gate cannot masquerade as the current one. */
  generation: number;
}

const HEAD_STATES = new Set(["active", "retired"]);

function headKey(owner: string, actor: string): string {
  return recordAtomicKey(LIFECYCLE_HEAD, [owner, actor]);
}

/** Validate a head value at the consuming boundary (§13.3: mediated-writer state that does not
 *  validate is a writer bug, never a data error) — closed schema, and the embedded owner/actor
 *  MUST agree with the key so a key-mismatched row never authorizes. */
function parseHead(raw: Uint8Array, key: string, owner: string, actor: string): LifecycleHead {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the lifecycle head ${key} is not an object`);
  const allowed = new Set(["owner", "actor", "lifecycleUid", "managerInstance", "processEpoch", "state", "generation"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the lifecycle head ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (
    o.owner !== owner || o.actor !== actor ||
    typeof o.lifecycleUid !== "string" || typeof o.managerInstance !== "string" || o.managerInstance.length === 0 ||
    !uint(o.processEpoch) || typeof o.state !== "string" || !HEAD_STATES.has(o.state) ||
    !uint(o.generation) || o.generation < 1
  )
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} does not validate (owner/actor/uid/epoch/state/generation); a garbled or key-mismatched head never authorizes (SPEC 13.1/13.3)`);
  try {
    assertLifecycleToken(o.lifecycleUid);
  } catch {
    throw new EpEnvelopeError("internal", `the lifecycle head ${key} carries a malformed lifecycleUid "${String(o.lifecycleUid)}" (SPEC 13.1)`);
  }
  return o as unknown as LifecycleHead;
}

/** Read the head via a raw `kv.get` (candidate read for a CAS-fenced mutation). A DEL/PURGE
 *  marker is CORRUPTION, never absence (§13.12: authority keys are never-deleted), so it refuses
 *  loudly; TRUE absence returns undefined. NOT for authority decisions — those use
 *  {@link readLifecycleHeadLeader} (leader-served). */
async function readHeadCandidate(kv: KV, owner: string, actor: string): Promise<{ head: LifecycleHead; revision: number } | undefined> {
  const key = headKey(owner, actor);
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the lifecycle head ${key} carries a ${entry.operation} marker; an authority head is never deleted (a deletion is corruption, not absence, SPEC 13.12)`);
  return { head: parseHead(entry.value, key, owner, actor), revision: entry.revision };
}

/**
 * Activate the alias `(owner, actor)` (§13.1): mint a FRESH lifecycle uid and write the head at
 * generation 1 for a virgin alias, or a fresh uid at `generation + 1` re-activating a RETIRED
 * alias. Serialized on the head's single key:
 *  - virgin (true absence): create-only CAS (conflicts on a deletion marker, so a reused alias
 *    can never recreate over a tombstone) — one winner on concurrent same-alias activation;
 *  - retired: revision-pinned CAS `retired → active` at a bumped generation + fresh uid;
 *  - already `active`: refused `already-exists` (an active incarnation is not re-activated;
 *    a takeover/restart uses {@link advanceProcessEpoch}, not a new incarnation).
 * The initial process epoch is 1 (or the caller's, e.g. resuming a supervised restart's epoch).
 * Returns the new head. A concurrent loser sees `conflict` (re-read and re-decide).
 */
export async function activateLifecycle(
  kv: KV,
  args: { owner: string; actor: string; managerInstance: string; processEpoch?: number },
): Promise<LifecycleHead> {
  const { owner, actor } = args;
  if (typeof args.managerInstance !== "string" || args.managerInstance.length === 0)
    throw new EpEnvelopeError("failed-precondition", "activateLifecycle requires a managerInstance (the supervising authority)");
  const processEpoch = args.processEpoch ?? 1;
  if (!uint(processEpoch) || processEpoch < 1)
    throw new EpEnvelopeError("failed-precondition", `processEpoch ${String(args.processEpoch)} is not a positive integer`);
  const key = headKey(owner, actor);
  const current = await readHeadCandidate(kv, owner, actor);
  if (current !== undefined && current.head.state === "active")
    throw new EpEnvelopeError("already-exists", `lifecycle "${owner}/${actor}" is already active (generation ${current.head.generation}, uid ${current.head.lifecycleUid}); a takeover/restart advances the epoch, it does not re-activate (SPEC 13.1)`);
  const head: LifecycleHead = {
    owner, actor,
    lifecycleUid: mintLifecycleUid(),
    managerInstance: args.managerInstance,
    processEpoch,
    state: "active",
    generation: current === undefined ? 1 : current.head.generation + 1,
  };
  if (current === undefined) {
    await createRecordEntry(kv, key, head); // create-only: conflicts on a deletion marker (never-reuse)
  } else {
    await updateRecordEntry(kv, key, head, current.revision); // retired → active, revision-pinned
  }
  return head;
}

/**
 * Advance the fenced process epoch of the ACTIVE incarnation (§13.1 takeover/supervised
 * restart): a revision-pinned CAS on the head, so two racing takeovers cannot both win and a
 * stale supervisor's advance loses. Refuses a retired lifecycle (a terminal incarnation gets no
 * new epoch) and refuses a non-monotonic epoch. Returns the new head.
 */
export async function advanceProcessEpoch(
  kv: KV,
  args: { owner: string; actor: string; toEpoch: number; managerInstance?: string },
): Promise<LifecycleHead> {
  const { owner, actor } = args;
  if (!uint(args.toEpoch) || args.toEpoch < 1)
    throw new EpEnvelopeError("failed-precondition", `toEpoch ${String(args.toEpoch)} is not a positive integer`);
  const current = await readHeadCandidate(kv, owner, actor);
  if (current === undefined)
    throw new EpEnvelopeError("not-found", `lifecycle "${owner}/${actor}" has no head; there is nothing to advance (SPEC 13.1)`);
  if (current.head.state !== "active")
    throw new EpEnvelopeError("failed-precondition", `lifecycle "${owner}/${actor}" is "${current.head.state}"; a retired incarnation gets no new process epoch (re-activate the alias instead, SPEC 13.1)`);
  if (args.toEpoch <= current.head.processEpoch)
    throw new EpEnvelopeError("failed-precondition", `epoch ${args.toEpoch} is not above the current ${current.head.processEpoch}; the process epoch is monotonic (SPEC 13.1)`);
  const head: LifecycleHead = { ...current.head, processEpoch: args.toEpoch, ...(args.managerInstance ? { managerInstance: args.managerInstance } : {}) };
  await updateRecordEntry(kv, headKey(owner, actor), head, current.revision);
  return head;
}

/**
 * Retire the active incarnation of `(owner, actor)` TERMINALLY (§13.1): a revision-pinned CAS
 * `active → retired` on the head. Idempotent for an already-retired head (`retired: false`);
 * the head is NEVER deleted, so the retirement is a durable terminal state a later reader sees,
 * not an absence. The full §13.1 retirement BARRIER (revoke the credential family, verified
 * eviction, alias release) lands with the credential-ledger + barrier slices over this; this is
 * the head's own terminal transition.
 */
export async function retireLifecycleHead(
  kv: KV,
  args: { owner: string; actor: string },
): Promise<{ retired: boolean; head: LifecycleHead | undefined }> {
  const { owner, actor } = args;
  const current = await readHeadCandidate(kv, owner, actor);
  if (current === undefined)
    throw new EpEnvelopeError("not-found", `lifecycle "${owner}/${actor}" has no head to retire (SPEC 13.1)`);
  if (current.head.state === "retired") return { retired: false, head: current.head };
  const head: LifecycleHead = { ...current.head, state: "retired" };
  await updateRecordEntry(kv, headKey(owner, actor), head, current.revision);
  return { retired: true, head };
}

/**
 * The LEADER-SERVED mapping reader (§13.1: activation/retirement serialize on the head, and a
 * fresh authority read of it is leader-served `STREAM.MSG.GET`, never a follower Direct Get the
 * records bucket's `allow_direct=true` would permit). This is the production reader that backs
 * the `readProcessEpoch` seam D11 (restart supervision, status commit) and D7 (session
 * redemption) inject: the fenced epoch of the CURRENT active incarnation, or `undefined` for a
 * retired/absent lifecycle (an unauthorized egress). A DEL/PURGE marker refuses loudly.
 */
export async function readLifecycleHeadLeader(
  jsm: JetStreamManager,
  space: string,
  owner: string,
  actor: string,
): Promise<{ head: LifecycleHead; revision: number } | undefined> {
  const key = headKey(owner, actor);
  let entry: { value: unknown; revision: number } | undefined;
  try {
    entry = await readRecordLeader(jsm, space, key);
  } catch (e) {
    // readRecordLeader itself refuses a DEL/PURGE marker (failed-precondition) — never absence.
    if (e instanceof EpEnvelopeError) throw e;
    throw new EpEnvelopeError("unavailable", `the leader-served lifecycle-head read for "${owner}/${actor}" failed; an authority read fails closed, never open (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
  }
  if (entry === undefined) return undefined;
  return { head: parseHead(enc.encode(JSON.stringify(entry.value)), key, owner, actor), revision: entry.revision };
}

/**
 * The `readProcessEpoch` PRODUCTION SEAM the D11/D7 paths inject (`() => Promise<number>` /
 * `number | undefined`): the current active incarnation's fenced epoch read leader-served, or
 * `undefined` when the lifecycle is retired/absent (so a superseded process's status write or a
 * leaked session grant fails the epoch fence). Bind it as `readProcessEpoch: () =>
 * lifecycleProcessEpochReader(jsm, space, owner, actor)`.
 */
export async function lifecycleProcessEpochReader(
  jsm: JetStreamManager,
  space: string,
  owner: string,
  actor: string,
): Promise<number | undefined> {
  const read = await readLifecycleHeadLeader(jsm, space, owner, actor);
  return read !== undefined && read.head.state === "active" ? read.head.processEpoch : undefined;
}

/** Open a JetStream manager for the leader-served reads (a thin helper so callers do not have to
 *  import `@nats-io/jetstream` directly). */
export async function lifecycleRegistryManager(nc: NatsConnection): Promise<JetStreamManager> {
  return jetstreamManager(nc);
}
