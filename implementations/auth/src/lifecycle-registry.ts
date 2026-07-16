/**
 * The D13 lifecycle registry, slice (1)+(2a) (SPEC §13.1, as amended): the sealed storage
 * authority for lifecycle identity — the space-global UID reservation, the three-state alias
 * head (`active | retiring | retired`), the activation saga over both stores, the leader-served
 * mapping reader that backs the `readProcessEpoch` seam D11 (restart supervision, status
 * commit) and D7 (session redemption) inject, and the issuance-gate CAS PRIMITIVES
 * (create/observe/freeze/op-pinned reopen/retire) for the agent gate family `gate.<lifecycleUid>`.
 *
 * DELIBERATELY NOT HERE (the later gated slices, §13.1 barrier order):
 *  - the (3) normative credential ledger and the (2b) takeover barrier live in the SIBLING
 *    module `credential-ledger.ts` (the same authority over the same stores, reached through
 *    {@link registryStores}); this module keeps only the barrier's module-internal epoch seam
 *    ({@link advanceEpochWithinTakeover} — there is still NO public epoch advance);
 *  - no head retirement: `active → retiring → retired` is a finalization step of the
 *    RETIREMENT barrier (a later slice), and exposing it without the completed barrier would
 *    recreate the half-fence D13 exists to remove;
 *  - no reachable production activation wiring and no credential release (the head is written
 *    WITHOUT `currentCredentialId` until production issuance mints under the reopened gate).
 *
 * SURFACE: the activation saga and the gate primitives are PACKAGE-INTERNAL (not exported from
 * the package index) until the (3) ledger slice completes them into real operations; "no
 * production callsite" is not the same as no reachable API, so the API is not reachable. The
 * executor seam is the sealed registry itself: it is constructed only over the minting
 * authority's own authenticated connection, so holding a gate's `opId` string grants nothing
 * to a caller that cannot open the registry (the opId is an identifier, §13.1).
 *
 * The model (§13.1):
 *  - the UID is entropy, never order: before anything else the minting authority WINS the
 *    create-only, never-deleted, SPACE-GLOBAL reservation `uid.<lifecycleUid>`; a create
 *    conflict burns the candidate (the alias head alone cannot reject the same UID under a
 *    different alias), and a DEL/PURGE marker is corruption, never reusable absence;
 *  - the head is a SINGLE unsplit key and `mappingRevision` IS its STORE revision (one leader
 *    read returns `{ mapping, revision }`; the value carries no revision field);
 *  - `active` is the ONLY current state: every currency seam (the epoch reader here) yields no
 *    current mapping and no current epoch for `retiring` AND `retired` alike;
 *  - activation is a CROSS-BUCKET SAGA with a durable op intent, in the normative order:
 *    reserve UID → create the gate `frozen` carrying the activation op (unmintable from
 *    birth) → CAS the alias head → reopen the gate LAST; a head-CAS loser terminalizes its own
 *    orphan gate and its UID stays burned; a crash resumes the SAME op ({@link resumeActivation}),
 *    never minting a second UID for one activation;
 *  - the head and the reservation are NEVER-DELETED: a reader treats only TRUE ABSENCE as
 *    virgin, and a deletion marker refuses LOUDLY as corruption;
 *  - a `frozen` gate MUST carry its durable operation intent `{ opId, kind }`: a resumer
 *    advances only the SAME `opId` (the opId is an identifier, never a bearer capability — the
 *    op-pinned CAS plus the caller's own authenticated authority is what advances the gate),
 *    and a stranger can neither reopen nor terminalize another operation's freeze.
 */
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError,
  LIFECYCLE_HEAD,
  UID_RESERVATION,
  recordAtomicKey,
  createRecordEntry,
  updateRecordEntry,
  readRecordLeader,
  mintLifecycleUid,
  assertLifecycleToken,
  epAuthBucket,
  isCasLoss as isRawCasLoss,
} from "@cotal-ai/core";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isCasLoss = (e: unknown): boolean => e instanceof EpEnvelopeError && e.code === "conflict";

// ---- the sealed contexts --------------------------------------------------------------------
// Both are BRANDED (WeakMap membership, §13.12): a hand-assembled object never authorizes, so a
// caller cannot pair this module's writers with a foreign bucket, an injected reader, or a
// mismatched space. The internals (the KVs, the JSM, the space bond) are module-private.

/** The minting authority's sealed registry over the space's PRIMARY records + auth stores. */
export interface LifecycleRegistry {
  readonly space: string;
}
/** The read-only sealed mapping reader (the confined reader profile holds ONLY the records
 *  leader read; it cannot write a head or touch the auth store). */
export interface LifecycleMappingReader {
  readonly space: string;
}

interface RegistryInternals {
  space: string;
  recordsKv: KV;
  authKv: KV;
  jsm: JetStreamManager;
  /** The JetStream client over the SAME authenticated connection — the credential-ledger
   *  barrier's per-run throwaway enumeration consumer fetches through it (SPEC 13.9). */
  js: JetStreamClient;
}
const REGISTRIES = new WeakMap<LifecycleRegistry, RegistryInternals>();
const READERS = new WeakMap<LifecycleMappingReader, { space: string; jsm: JetStreamManager }>();

function internals(reg: LifecycleRegistry): RegistryInternals {
  const i = REGISTRIES.get(reg);
  if (!i)
    throw new EpEnvelopeError("failed-precondition", "the lifecycle registry was not constructed by openLifecycleRegistry(); a hand-assembled context never authorizes (SPEC 13.12)");
  return i;
}
function readerInternals(rd: LifecycleMappingReader): { space: string; jsm: JetStreamManager } {
  const i = READERS.get(rd);
  if (!i)
    throw new EpEnvelopeError("failed-precondition", "the mapping reader was not constructed by openLifecycleMappingReader(); a hand-assembled context never authorizes (SPEC 13.12)");
  return i;
}

/** The bucket-config fields the shape proofs inspect (wire names, per the JetStream API). */
interface AuthorityStreamCfg {
  allow_direct?: boolean;
  retention?: string;
  max_age?: number;
  max_msgs?: number;
  max_bytes?: number;
  mirror?: unknown;
  sources?: unknown;
}

/** Prove an authority store's stream shape at bind (SPEC 13.12): PRIMARY (never a
 *  mirror/sourced copy), LIMITS retention (an Interest/WorkQueue stream deletes a message once
 *  consumers have interest/ack it — an authority row would silently vanish after a barrier's
 *  point-in-time enumeration reads it), and NO silent-eviction limit — no age retention and no
 *  finite global message/byte cap (under DiscardOld a finite global limit evicts a PRIOR
 *  authority key's latest row the moment an unrelated key is written). A store that cannot be
 *  proved never serves. (A per-subject cap is NOT a vector: NATS keeps at least the latest value
 *  per subject for any cap ≥ 1, and 0/-1 mean unlimited, so no setting drops a key's own row.) */
function assertAuthorityStreamShape(cfg: AuthorityStreamCfg, bucket: string): void {
  if (cfg.mirror !== undefined || (Array.isArray(cfg.sources) && cfg.sources.length > 0))
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} is a mirror/sourced stream; a follower copy cannot serve authority reads or CAS (SPEC 13.12) — bind the primary`);
  // A KV bucket is Limits-retention by construction, but the backing stream config is what
  // actually governs eviction, so prove it (a stream reprovisioned as Interest/WorkQueue under
  // the KV_ name would delete authority rows on consumer interest/ack — the barrier's throwaway
  // enumeration consumer would itself trigger the deletion).
  if (typeof cfg.retention === "string" && cfg.retention !== "limits")
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} has ${cfg.retention} retention, not limits; a non-Limits stream deletes authority rows on consumer interest/ack (SPEC 13.12) — reprovision as a KV bucket`);
  if (typeof cfg.max_age === "number" && cfg.max_age > 0)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} carries bucket-wide age eviction (max_age ${cfg.max_age}); an age-evicted authority row silently drops a fence (SPEC 13.12) — reprovision`);
  if (typeof cfg.max_msgs === "number" && cfg.max_msgs >= 0)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} carries a finite global message cap (max_msgs ${cfg.max_msgs}); under discard-old it silently evicts never-deleted authority keys (SPEC 13.12) — reprovision`);
  if (typeof cfg.max_bytes === "number" && cfg.max_bytes >= 0)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} carries a finite global byte cap (max_bytes ${cfg.max_bytes}); under discard-old it silently evicts never-deleted authority keys (SPEC 13.12) — reprovision`);
}

/** Open the minting authority's sealed lifecycle registry: binds the space's primary records
 *  bucket AND its auth bucket. BOTH are shape-proved at bind (SPEC 13.12): primary, un-aged,
 *  no finite global eviction cap; the auth store additionally leader-only `allow_direct=false`. */
export async function openLifecycleRegistry(nc: NatsConnection, space: string): Promise<LifecycleRegistry> {
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const recordsBucket = `cotal_records_${space}`;
  const authBucket = epAuthBucket(space);
  let recordsKv: KV, authKv: KV;
  let recordsCfg: AuthorityStreamCfg;
  try {
    recordsKv = await kvm.open(recordsBucket);
    recordsCfg = (await jsm.streams.info(`KV_${recordsBucket}`)).config;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the records store ${recordsBucket} is not provisioned (run space setup; SPEC 13.12): ${(e as Error)?.message ?? String(e)}`);
  }
  assertAuthorityStreamShape(recordsCfg, recordsBucket);
  let authCfg: AuthorityStreamCfg;
  try {
    authKv = await kvm.open(authBucket);
    authCfg = (await jsm.streams.info(`KV_${authBucket}`)).config;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the auth store ${authBucket} is not provisioned (run space setup; SPEC 13.12): ${(e as Error)?.message ?? String(e)}`);
  }
  assertAuthorityStreamShape(authCfg, authBucket);
  if (authCfg.allow_direct !== false)
    throw new EpEnvelopeError("failed-precondition", `the auth store ${authBucket} has allow_direct=${String(authCfg.allow_direct)}, not false; a Direct-Get-capable gate store defeats read-your-writes (SPEC 13.1) — reprovision`);
  const reg: LifecycleRegistry = Object.freeze({ space });
  REGISTRIES.set(reg, { space, recordsKv, authKv, jsm, js: jetstream(nc) });
  return reg;
}

/** Open the sealed read-only mapping reader. Its scoped credential holds EXACTLY the records
 *  leader read (`STREAM.MSG.GET`) plus the records `STREAM.INFO` for the bind-time shape proof
 *  (SPEC 13.9/13.12): a reader that cannot prove it is bound to the primary, non-evicting
 *  records store refuses to serve authority reads (it could otherwise leader-read a MIRROR's
 *  leader and call that the mapping). */
export async function openLifecycleMappingReader(nc: NatsConnection, space: string): Promise<LifecycleMappingReader> {
  const recordsBucket = `cotal_records_${space}`;
  let jsm: JetStreamManager;
  let recordsCfg: AuthorityStreamCfg;
  try {
    jsm = await jetstreamManager(nc);
    recordsCfg = (await jsm.streams.info(`KV_${recordsBucket}`)).config;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the mapping reader cannot bind + shape-prove the records store ${recordsBucket} (the reader profile holds the API probe, STREAM.INFO, and its own connection-scoped inbox, SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }
  assertAuthorityStreamShape(recordsCfg, recordsBucket);
  const rd: LifecycleMappingReader = Object.freeze({ space });
  READERS.set(rd, { space, jsm });
  return rd;
}

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
   *  barrier, which this slice does not expose). */
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

const HEAD_STATES = new Set(["active", "retiring", "retired"]);

function headKey(owner: string, actor: string): string {
  return recordAtomicKey(LIFECYCLE_HEAD, [owner, actor]);
}
function uidKey(lifecycleUid: string): string {
  return recordAtomicKey(UID_RESERVATION, [lifecycleUid]);
}

/** Validate a head value at the consuming boundary — CLOSED schema (nested `op` included), and
 *  the embedded owner/actor MUST agree with the key so a key-mismatched row never authorizes. */
function parseMapping(raw: Uint8Array, key: string, owner: string, actor: string): LifecycleMapping {
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
    !uint(o.processEpoch) || o.processEpoch < 1 || typeof o.state !== "string" || !HEAD_STATES.has(o.state) ||
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

/** Candidate read for a CAS-fenced mutation (raw `kv.get`; the auth decision is the CAS itself,
 *  §13.1: a read is never a fence). A DEL/PURGE marker is CORRUPTION, never absence. */
async function readHeadCandidate(kv: KV, owner: string, actor: string): Promise<{ mapping: LifecycleMapping; revision: number } | undefined> {
  const key = headKey(owner, actor);
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the lifecycle head ${key} carries a ${entry.operation} marker; an authority head is never deleted (a deletion is corruption, not absence, SPEC 13.12)`);
  return { mapping: parseMapping(entry.value, key, owner, actor), revision: entry.revision };
}

/** PACKAGE-INTERNAL accessor for the trusted auth path's sibling modules (the credential
 *  ledger + issuance barrier, which are the SAME authority over the SAME stores). Deliberately
 *  never re-exported from the package index: a sealed registry stays the only door. */
export function registryStores(reg: LifecycleRegistry): { space: string; recordsKv: KV; authKv: KV; jsm: JetStreamManager; js: JetStreamClient } {
  return internals(reg);
}

/** PACKAGE-INTERNAL: the barrier's candidate read of an alias head (the credential-ledger
 *  takeover barrier captures its `fromEpoch` coordinate from it, and its epoch CAS re-reads
 *  through {@link advanceEpochWithinTakeover}). Same never-deleted discipline as every head
 *  read; never re-exported from the package index. */
export async function readLifecycleHeadForOperation(
  reg: LifecycleRegistry,
  owner: string,
  actor: string,
): Promise<{ mapping: LifecycleMapping; revision: number } | undefined> {
  return readHeadCandidate(internals(reg).recordsKv, owner, actor);
}

/** The takeover barrier's epoch-advance head CAS (SPEC 13.1: NO public epoch advance exists;
 *  this is a finalization step of the takeover barrier, module-internal for the credential
 *  ledger's barrier only, and idempotent for the barrier's crash-resume). Advances the epoch by
 *  exactly one, revision-pinned, only while the head is ACTIVE at the SAME uid. */
export async function advanceEpochWithinTakeover(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; fromEpoch: number; opId: string },
): Promise<"advanced" | "already-advanced"> {
  const { recordsKv } = internals(reg);
  const cur = await readHeadCandidate(recordsKv, args.owner, args.actor);
  if (cur === undefined || cur.mapping.state !== "active" || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the takeover epoch advance for "${args.owner}/${args.actor}" requires an ACTIVE head at uid ${args.lifecycleUid}; found ${cur === undefined ? "no head" : `${cur.mapping.state} at ${cur.mapping.lifecycleUid}`} (SPEC 13.1)`);
  if (cur.mapping.processEpoch === args.fromEpoch + 1) {
    // Idempotent ONLY for our OWN completed advance: the epoch stamp binds the completion to one
    // op, so a LOSING concurrent takeover that captured the same fromEpoch finds a foreign opId
    // and refuses, never claiming the winner's advance (SPEC 13.1).
    if (cur.mapping.lastTakeoverOpId !== args.opId)
      throw new EpEnvelopeError("conflict", `the head for "${args.owner}/${args.actor}" is at epoch ${args.fromEpoch + 1} advanced by operation ${cur.mapping.lastTakeoverOpId ?? "<none>"}, not ${args.opId}; a concurrent takeover won and this operation lost (SPEC 13.1)`);
    return "already-advanced";
  }
  if (cur.mapping.processEpoch !== args.fromEpoch)
    throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" is at epoch ${cur.mapping.processEpoch}, not the takeover's captured epoch ${args.fromEpoch} (or its +1); a foreign operation moved it (SPEC 13.1)`);
  await updateRecordEntry(recordsKv, headKey(args.owner, args.actor), { ...cur.mapping, processEpoch: args.fromEpoch + 1, lastTakeoverOpId: assertLifecycleToken(args.opId) }, cur.revision);
  return "advanced";
}

/** PACKAGE-INTERNAL: read a UID reservation's audit `{ owner, actor }` (the minting authority
 *  recorded it at {@link tryReserveUid}). The credential ledger uses it to BIND a mint's
 *  `holderPrincipal` to the reserved identity, so a trusted caller cannot ledger a row that
 *  names a foreign principal for the barrier to evict. A DEL/PURGE marker refuses loudly. */
export async function readUidReservation(
  reg: LifecycleRegistry,
  lifecycleUid: string,
): Promise<{ owner: string; actor: string } | undefined> {
  const { recordsKv } = internals(reg);
  const entry = await recordsKv.get(uidKey(assertLifecycleToken(lifecycleUid)));
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

// ---- the space-global UID reservation (records store) ----------------------------------------

/** Try to reserve ONE explicit candidate UID (test/provisioning-internal; production paths use
 *  {@link reserveLifecycleUid}). Create-only: `"won"` reserves it forever; `"burned"` means the
 *  candidate already exists OR carries a deletion marker — either way it is unusable, per the
 *  never-reuse rule. NOT exported from the package index: an explicit candidate is only for
 *  probes and migration tooling, never a caller-chosen identity. */
export async function tryReserveUid(
  reg: LifecycleRegistry,
  lifecycleUid: string,
  audit: { owner: string; actor: string; mintedBy: string },
): Promise<"won" | "burned"> {
  const { recordsKv } = internals(reg);
  assertLifecycleToken(lifecycleUid);
  try {
    await createRecordEntry(recordsKv, uidKey(lifecycleUid), { owner: audit.owner, actor: audit.actor, mintedBy: audit.mintedBy });
    return "won";
  } catch (e) {
    if (isCasLoss(e)) return "burned";
    throw e;
  }
}

/** Reserve a fresh lifecycle UID space-globally (§13.1): mint a CSPRNG candidate, win its
 *  create-only reservation, and on a collision burn the candidate and draw another. At ≥128
 *  bits a collision is effectively adversarial, so a handful of retries is a correctness
 *  formality, not a capacity plan; exhausting them refuses loudly. */
export async function reserveLifecycleUid(
  reg: LifecycleRegistry,
  audit: { owner: string; actor: string; mintedBy: string },
): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const candidate = mintLifecycleUid();
    if ((await tryReserveUid(reg, candidate, audit)) === "won") return candidate;
  }
  throw new EpEnvelopeError("internal", "four fresh 128-bit UID candidates collided with existing reservations; that is not chance — inspect the uid.> family (SPEC 13.1)");
}

// ---- the issuance-gate CAS primitives (auth store, agent family `gate.<lifecycleUid>`) -------

/** The agent-family issuance gate row (§13.1, amended): `frozen` MUST carry the durable op
 *  intent; the embedded uid MUST agree with the key. (The disjoint ENDPOINT family
 *  `epgate.<endpoint>.<instanceId>` and the full barrier land with the (3)/(2b) ledger slices.) */
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

const GATE_STATES = new Set(["open", "frozen", "retired"]);
const GATE_OP_KINDS = new Set(["activation", "takeover", "registration", "retirement"]);

function gateKey(lifecycleUid: string): string {
  return `gate.${assertLifecycleToken(lifecycleUid)}`;
}

function parseGate(raw: Uint8Array, key: string, lifecycleUid: string): EpGateRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the issuance gate ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the issuance gate ${key} is not an object`);
  for (const k of Object.keys(o)) if (k !== "lifecycleUid" && k !== "state" && k !== "generation" && k !== "op") throw new EpEnvelopeError("internal", `the issuance gate ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (o.lifecycleUid !== lifecycleUid || typeof o.state !== "string" || !GATE_STATES.has(o.state) || !uint(o.generation))
    throw new EpEnvelopeError("internal", `the issuance gate ${key} does not validate (uid/state/generation); a garbled or key-mismatched gate never authorizes (SPEC 13.1)`);
  if ((o.state === "frozen" || o.state === "retired") && !isRec(o.op))
    throw new EpEnvelopeError("internal", `the issuance gate ${key} is ${o.state} without its durable op intent (SPEC 13.1: a frozen gate is op-bound, and a retired gate retains its terminalizing op)`);
  if (o.state === "open" && o.op !== undefined)
    throw new EpEnvelopeError("internal", `the issuance gate ${key} is open but carries an op intent (SPEC 13.1: open gates are not op-bound)`);
  if (o.op !== undefined) {
    const op = o.op as Record<string, unknown>;
    for (const k of Object.keys(op)) if (k !== "opId" && k !== "kind" && k !== "successor") throw new EpEnvelopeError("internal", `the issuance gate ${key} op intent carries the unknown field "${k}" (closed schema)`);
    if (typeof op.opId !== "string" || typeof op.kind !== "string" || !GATE_OP_KINDS.has(op.kind))
      throw new EpEnvelopeError("internal", `the issuance gate ${key} op intent does not validate (SPEC 13.1)`);
    // STATE x KIND invariant (SPEC 13.1 per-kind transition sets): only an activation orphan or
    // a retirement produces a `retired` gate, so a persisted `retired` gate carrying a
    // takeover/registration kind is IMPOSSIBLE state — refuse it at parse, never let the terminal
    // idempotence path return it as a settled success (fail-closed on corruption, not open).
    if (o.state === "retired" && op.kind !== "activation" && op.kind !== "retirement")
      throw new EpEnvelopeError("internal", `the issuance gate ${key} is retired under a ${op.kind} op; only an activation orphan or a retirement terminalizes (SPEC 13.1) — impossible persisted state, refused`);
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

/** Observe the gate (the candidate read feeding a revision-pinned CAS; the auth store is
 *  leader-only by shape, `allow_direct=false`). A DEL/PURGE marker refuses loudly. */
export async function observeGate(reg: LifecycleRegistry, lifecycleUid: string): Promise<{ row: EpGateRow; revision: number } | undefined> {
  const { authKv } = internals(reg);
  const key = gateKey(lifecycleUid);
  const entry = await authKv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate ${key} carries a ${entry.operation} marker; a gate is never deleted (a deletion is corruption, not absence, SPEC 13.12)`);
  return { row: parseGate(entry.value, key, lifecycleUid), revision: entry.revision };
}

async function putGate(authKv: KV, lifecycleUid: string, row: EpGateRow, expectedRevision: number): Promise<number> {
  try {
    return await authKv.put(gateKey(lifecycleUid), enc.encode(JSON.stringify(row)), { previousSeq: expectedRevision });
  } catch (e) {
    if (isRawCasLoss(e))
      throw new EpEnvelopeError("conflict", `the issuance gate CAS for ${gateKey(lifecycleUid)} lost (expected revision ${expectedRevision}); re-read and re-decide (SPEC 13.8)`);
    throw e;
  }
}

/** Create the gate FROZEN under its operation's durable intent (create-only: conflicts on an
 *  existing gate or a deletion marker). A gate is BORN only under an ACTIVATION intent (SPEC
 *  13.1 per-kind transition sets: takeover/registration/retirement freeze an EXISTING open
 *  gate), and only for a UID whose space-global reservation was already WON: a gate over an
 *  unreserved UID would mint outside the never-reuse fence. Born unmintable at generation 0:
 *  no credential can be released until the operation's own reopen (§13.1 activation saga). */
export async function createGateFrozen(
  reg: LifecycleRegistry,
  args: { lifecycleUid: string; op: { opId: string; kind: "activation" } },
): Promise<{ row: EpGateRow; revision: number }> {
  const { authKv, recordsKv } = internals(reg);
  if (args.op.kind !== "activation")
    throw new EpEnvelopeError("failed-precondition", `an issuance gate is born only under an activation intent, not "${String(args.op.kind)}" (SPEC 13.1: other operations freeze an existing open gate)`);
  const reservation = await recordsKv.get(uidKey(assertLifecycleToken(args.lifecycleUid)));
  if (!reservation)
    throw new EpEnvelopeError("failed-precondition", `no uid reservation exists for ${args.lifecycleUid}; the reservation is won BEFORE any gate or head write (SPEC 13.1)`);
  if (reservation.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the uid reservation for ${args.lifecycleUid} carries a ${reservation.operation} marker; a reservation is never deleted (corruption, not absence, SPEC 13.12)`);
  const row: EpGateRow = { lifecycleUid: args.lifecycleUid, state: "frozen", generation: 0, op: { opId: assertLifecycleToken(args.op.opId), kind: "activation" } };
  const revision = await putGate(authKv, args.lifecycleUid, row, 0);
  return { row, revision };
}

/** CAS the gate `open → frozen` carrying the freezing operation's durable intent, at the
 *  observed revision. The bar of every barrier: a staged mint's own finalize CAS loses. */
export async function freezeGate(
  reg: LifecycleRegistry,
  args: { lifecycleUid: string; revision: number; op: { opId: string; kind: "takeover" | "registration" | "retirement"; successor?: string } },
): Promise<{ row: EpGateRow; revision: number }> {
  const { authKv } = internals(reg);
  if (args.op.successor !== undefined && args.op.kind === "retirement")
    throw new EpEnvelopeError("failed-precondition", "a retirement freeze carries no successor (SPEC 13.1: a retirement has none)");
  if (args.op.successor !== undefined && args.op.successor.length === 0)
    throw new EpEnvelopeError("failed-precondition", "the freeze carries an empty successor token; a summary token is a non-empty stage.<opId> reference or absent (SPEC 13.1) — validate before the CAS, never persist corruption");
  const current = await observeGate(reg, args.lifecycleUid);
  if (current === undefined) throw new EpEnvelopeError("not-found", `the issuance gate for ${args.lifecycleUid} does not exist (SPEC 13.1)`);
  if (current.row.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}", not open; only an open gate freezes (a frozen/retired gate belongs to its own operation, SPEC 13.1)`);
  const op: EpGateRow["op"] = { opId: assertLifecycleToken(args.op.opId), kind: args.op.kind };
  if (args.op.successor !== undefined) op.successor = args.op.successor;
  const row: EpGateRow = { lifecycleUid: current.row.lifecycleUid, state: "frozen", generation: current.row.generation, op };
  const revision = await putGate(authKv, args.lifecycleUid, row, args.revision);
  return { row, revision };
}

/** CAS the gate `frozen → open` at the NEXT generation — op-pinned: only the freeze's own
 *  operation (the same `opId`) reopens, as its barrier's final step; a stranger or a stale
 *  reconciler refuses before the CAS is even attempted. Per-kind (SPEC 13.1): a reopen
 *  belongs to activation, takeover, and a registration abort — NEVER retirement (a
 *  retirement freeze never reopens; its only exit is the terminal). */
export async function reopenGate(
  reg: LifecycleRegistry,
  args: { lifecycleUid: string; revision: number; opId: string },
): Promise<{ row: EpGateRow; revision: number }> {
  const { authKv } = internals(reg);
  const current = await observeGate(reg, args.lifecycleUid);
  if (current === undefined) throw new EpEnvelopeError("not-found", `the issuance gate for ${args.lifecycleUid} does not exist (SPEC 13.1)`);
  if (current.row.state !== "frozen")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}", not frozen; there is no freeze to reopen (SPEC 13.1)`);
  if (current.row.op?.opId !== args.opId)
    throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} is frozen by operation ${current.row.op?.opId ?? "<none>"}, not ${args.opId}; only the completing operation reopens its own freeze (SPEC 13.1)`);
  if (current.row.op.kind === "retirement")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is frozen by a RETIREMENT; a retirement freeze never reopens (SPEC 13.1: its only exit is the terminal)`);
  const row: EpGateRow = { lifecycleUid: current.row.lifecycleUid, state: "open", generation: current.row.generation + 1 };
  const revision = await putGate(authKv, args.lifecycleUid, row, args.revision);
  return { row, revision };
}

/** CAS the gate `frozen → retired` (terminal; never reopened) — op-pinned like the reopen. The
 *  activation saga uses it to terminalize a head-CAS loser's orphan gate; the retirement
 *  barrier uses it as its own gate terminalization step. Per-kind (SPEC 13.1): only an
 *  ACTIVATION orphan or a RETIREMENT terminalizes — a takeover/registration freeze aborts by
 *  reopening, never by the terminal. Idempotence at `retired` is SAME-OP idempotence: a
 *  stranger's retry on a terminal gate refuses, it does not "succeed". */
export async function retireGate(
  reg: LifecycleRegistry,
  args: { lifecycleUid: string; revision: number; opId: string },
): Promise<{ row: EpGateRow; revision: number }> {
  const { authKv } = internals(reg);
  const current = await observeGate(reg, args.lifecycleUid);
  if (current === undefined) throw new EpEnvelopeError("not-found", `the issuance gate for ${args.lifecycleUid} does not exist (SPEC 13.1)`);
  if (current.row.state === "retired") {
    if (current.row.op?.opId !== args.opId)
      throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} was terminalized by operation ${current.row.op?.opId ?? "<none>"}, not ${args.opId}; terminal idempotence is same-op idempotence (SPEC 13.1)`);
    return current; // idempotent terminal, same op
  }
  if (current.row.state !== "frozen")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}"; only a frozen gate terminalizes (freeze first — the bar precedes the terminal, SPEC 13.1)`);
  if (current.row.op?.opId !== args.opId)
    throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} is frozen by operation ${current.row.op?.opId ?? "<none>"}, not ${args.opId}; only the owning operation terminalizes its freeze (SPEC 13.1)`);
  if (current.row.op.kind !== "activation" && current.row.op.kind !== "retirement")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is frozen by a ${current.row.op.kind}; only an activation orphan or a retirement terminalizes (a ${current.row.op.kind} aborts by reopening, SPEC 13.1)`);
  const row: EpGateRow = { lifecycleUid: current.row.lifecycleUid, state: "retired", generation: current.row.generation, op: current.row.op };
  const revision = await putGate(authKv, args.lifecycleUid, row, args.revision);
  return { row, revision };
}

// ---- the activation saga (§13.1: reserve → gate frozen → head CAS → reopen LAST) -------------

/**
 * Activate the alias `(owner, actor)`: the full §13.1 initial-activation saga. Refuses an
 * `active` head (`already-exists`: a takeover advances the epoch through its barrier, never a
 * new incarnation) and a `retiring` head (`failed-precondition`: a retiring alias is NOT
 * replaceable until its barrier completes). A virgin alias activates by create-only head CAS; a
 * `retired` predecessor is replaced by revision-pinned CAS with a FRESH reserved UID. The
 * head-CAS loser terminalizes its own orphan gate (its UID stays burned forever) and rethrows
 * the `conflict`. Returns the new mapping, its store revision (= `mappingRevision`), and the
 * saga's `opId` (the durable intent a crashed caller resumes with, {@link resumeActivation}).
 *
 * NOT wired to any production spawn path in this slice; the ledger slice adds credential
 * minting under the reopened gate before this becomes reachable.
 */
export async function activateLifecycle(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; managerInstance: string },
): Promise<{ mapping: LifecycleMapping; revision: number; opId: string }> {
  const { recordsKv } = internals(reg);
  const { owner, actor } = args;
  if (typeof args.managerInstance !== "string" || args.managerInstance.length === 0)
    throw new EpEnvelopeError("failed-precondition", "activateLifecycle requires a managerInstance (the minting authority)");
  const current = await readHeadCandidate(recordsKv, owner, actor);
  if (current !== undefined && current.mapping.state === "active")
    throw new EpEnvelopeError("already-exists", `lifecycle "${owner}/${actor}" is already active (uid ${current.mapping.lifecycleUid}); a takeover advances the epoch through its barrier, it does not re-activate (SPEC 13.1)`);
  if (current !== undefined && current.mapping.state === "retiring")
    throw new EpEnvelopeError("failed-precondition", `lifecycle "${owner}/${actor}" is retiring (op ${current.mapping.op?.opId}); a retiring alias is not replaceable until its barrier completes (SPEC 13.1)`);
  const opId = mintLifecycleUid();
  // 1. Win the space-global UID reservation.
  const lifecycleUid = await reserveLifecycleUid(reg, { owner, actor, mintedBy: args.managerInstance });
  // 2. Create the gate FROZEN under this activation's durable intent (unmintable from birth).
  const gate = await createGateFrozen(reg, { lifecycleUid, op: { opId, kind: "activation" } });
  // 3. CAS the alias head (create-only for virgin; revision-pinned over the retired predecessor).
  const mapping: LifecycleMapping = { owner, actor, lifecycleUid, managerInstance: args.managerInstance, processEpoch: 1, state: "active" };
  let revision: number;
  try {
    revision = current === undefined
      ? await createRecordEntry(recordsKv, headKey(owner, actor), mapping)
      : await updateRecordEntry(recordsKv, headKey(owner, actor), mapping, current.revision);
  } catch (e) {
    if (isCasLoss(e)) {
      // The loser terminalizes ITS OWN orphan gate; its UID stays burned (never deleted, never
      // reused). A cleanup failure is NEVER swallowed as success: the caller gets the durable
      // coordinates and resumes the SAME op (resumeActivation) to finish the terminalization.
      try {
        await retireGate(reg, { lifecycleUid, revision: gate.revision, opId });
      } catch (cleanup) {
        // The resume coordinates ride STRUCTURED details (never only the prose message): a
        // recovery path reads {uid, opId} from `details`, it does not parse a sentence.
        throw new EpEnvelopeError(
          "unavailable",
          `lifecycle activation for "${owner}/${actor}" lost the head CAS AND terminalizing its orphan gate failed; the uid ${lifecycleUid} is burned but its gate is still frozen by op ${opId} — resume the same op with resumeActivation: ${(cleanup as Error)?.message ?? String(cleanup)}`,
          [{ kind: "resume-activation", owner, actor, lifecycleUid, opId }],
        );
      }
      throw new EpEnvelopeError("conflict", `lifecycle activation for "${owner}/${actor}" lost the head CAS (a concurrent activation won); this saga's uid ${lifecycleUid} is burned and its gate terminalized (SPEC 13.1)`);
    }
    throw e;
  }
  // 4. Reopen the gate at its first mintable generation — the saga's LAST step.
  await reopenGate(reg, { lifecycleUid, revision: gate.revision, opId });
  return { mapping, revision, opId };
}

/**
 * Resume a crashed activation saga from its durable coordinates (`{alias, lifecycleUid, opId}`,
 * the intent the minting authority persists before step 1 and the gate carries from step 2).
 * Reads the durable state and finishes the SAME operation deterministically:
 *  - head active at OUR uid → finish step 4 (reopen the gate) if it is still frozen by us;
 *  - head absent / retired / owned by another uid → our head CAS never won (or never ran):
 *    terminalize our orphan gate; the uid stays burned.
 * Idempotent; never advances another operation's freeze (the op-pinned CAS refuses). Returns
 * what it did.
 */
export async function resumeActivation(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"completed" | "terminalized" | "already-settled"> {
  const { recordsKv } = internals(reg);
  const head = await readHeadCandidate(recordsKv, args.owner, args.actor);
  const gate = await observeGate(reg, args.lifecycleUid);
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
    await reopenGate(reg, { lifecycleUid: args.lifecycleUid, revision: gate.revision, opId: args.opId });
    return "completed";
  }
  await retireGate(reg, { lifecycleUid: args.lifecycleUid, revision: gate.revision, opId: args.opId });
  return "terminalized";
}

// ---- the leader-served mapping reader (the currency seam) ------------------------------------

/**
 * The LEADER-SERVED mapping read (§13.1: `mappingRevision` IS the returned store revision; the
 * records bucket allows Direct Get for non-fencing reads, but an authority read of the head is
 * leader-served `STREAM.MSG.GET`, never a follower get). Returns the mapping REGARDLESS of
 * state — currency is the CALLER's rule, and the epoch seam below applies it. A DEL/PURGE
 * marker refuses loudly.
 */
export async function readLifecycleMappingLeader(
  rd: LifecycleMappingReader,
  owner: string,
  actor: string,
): Promise<{ mapping: LifecycleMapping; revision: number } | undefined> {
  const { jsm, space } = readerInternals(rd);
  const key = headKey(owner, actor);
  let entry: { value: unknown; revision: number } | undefined;
  try {
    entry = await readRecordLeader(jsm, space, key);
  } catch (e) {
    if (e instanceof EpEnvelopeError) throw e; // incl. the DEL/PURGE refusal
    throw new EpEnvelopeError("unavailable", `the leader-served lifecycle-head read for "${owner}/${actor}" failed; an authority read fails closed, never open (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
  }
  if (entry === undefined) return undefined;
  return { mapping: parseMapping(enc.encode(JSON.stringify(entry.value)), key, owner, actor), revision: entry.revision };
}

/**
 * The `readProcessEpoch` PRODUCTION SEAM the D11/D7 paths inject: the CURRENT incarnation's
 * fenced epoch, leader-served — and current means `state: "active"` ONLY (§13.1, amended):
 * `retiring` and `retired` alike yield `undefined`, so a superseded process's status write, a
 * containment-phase mint, or a leaked session grant all fail the epoch fence. Bind it as
 * `readProcessEpoch: () => lifecycleProcessEpochReader(reader, owner, actor)`.
 */
export async function lifecycleProcessEpochReader(
  rd: LifecycleMappingReader,
  owner: string,
  actor: string,
): Promise<number | undefined> {
  const read = await readLifecycleMappingLeader(rd, owner, actor);
  return read !== undefined && read.mapping.state === "active" ? read.mapping.processEpoch : undefined;
}
