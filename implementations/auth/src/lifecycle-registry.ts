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
  workPoolContext,
  type WorkPoolContext,
} from "@cotal-ai/core";
import { assertScannerSpace, type AuthLedgerScanner } from "./ledger-scanner.js";
import { assertRecordsScannerSpace, type RecordsScanner } from "./records-scanner.js";

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
  js: JetStreamClient;
  work: WorkPoolContext;
  /** The SEALED auth-ledger scanner (SPEC 13.9): the ONLY holder of `CONSUMER.CREATE` on the auth
   *  stream, on its own dedicated credential+connection ({@link openAuthLedgerScanner}). The
   *  barrier reaches enumeration through its CLOSED ops only ({@link registryScanner}); the raw
   *  scanner/connection never escapes. Absent on the mint-writer registry (which never enumerates),
   *  so {@link registryScanner} fails loud if a scanner-less registry is asked to enumerate. */
  scanner?: AuthLedgerScanner;
  /** The SEALED records-obligation scanner (SPEC 13.9, site 3): the ONLY holder of `CONSUMER.CREATE`
   *  on the records stream for obligation enumeration, on its own dedicated credential+connection
   *  ({@link openRecordsScanner}). The §13.1 retirement barrier's obligation drain reaches it through
   *  {@link registryRecordsScanner}; the raw scanner/connection never escapes. Absent until the
   *  retirement-drain executor is wired (#29 trigger), so {@link registryRecordsScanner} fails loud
   *  if a scanner-less registry is asked to drain obligations. */
  recordsScanner?: RecordsScanner;
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

/** The bucket-config fields the shape proofs inspect (wire names, per the JetStream API).
 *  PACKAGE-INTERNAL (with {@link assertAuthorityStreamShape}) for the sibling trusted-path
 *  modules; never re-exported from the package index. */
export interface AuthorityStreamCfg {
  allow_direct?: boolean;
  retention?: string;
  max_age?: number;
  max_msgs?: number;
  max_bytes?: number;
  mirror?: unknown;
  sources?: unknown;
  subjects?: unknown;
  storage?: string;
}

/** Prove an authority store's stream shape at bind (SPEC 13.12): PRIMARY (never a
 *  mirror/sourced copy), LIMITS retention (an Interest/WorkQueue stream deletes a message once
 *  consumers have interest/ack it — an authority row would silently vanish after a barrier's
 *  point-in-time enumeration reads it), and NO silent-eviction limit — no age retention and no
 *  finite global message/byte cap (under DiscardOld a finite global limit evicts a PRIOR
 *  authority key's latest row the moment an unrelated key is written). A store that cannot be
 *  proved never serves. (A per-subject cap is NOT a vector: NATS keeps at least the latest value
 *  per subject for any cap ≥ 1, and 0/-1 mean unlimited, so no setting drops a key's own row.) */
export function assertAuthorityStreamShape(cfg: AuthorityStreamCfg, bucket: string): void {
  if (cfg.mirror !== undefined || (Array.isArray(cfg.sources) && cfg.sources.length > 0))
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} is a mirror/sourced stream; a follower copy cannot serve authority reads or CAS (SPEC 13.12); bind the primary`);
  // A KV bucket is Limits-retention by construction, but the backing stream config is what
  // actually governs eviction, so prove it (a stream reprovisioned as Interest/WorkQueue under
  // the KV_ name would delete authority rows on consumer interest/ack — the barrier's throwaway
  // enumeration consumer would itself trigger the deletion).
  if (typeof cfg.retention === "string" && cfg.retention !== "limits")
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} has ${cfg.retention} retention, not limits; a non-Limits stream deletes authority rows on consumer interest/ack (SPEC 13.12); reprovision as a KV bucket`);
  if (typeof cfg.max_age === "number" && cfg.max_age > 0)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} carries bucket-wide age eviction (max_age ${cfg.max_age}); an age-evicted authority row silently drops a fence (SPEC 13.12); reprovision`);
  if (typeof cfg.max_msgs === "number" && cfg.max_msgs >= 0)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} carries a finite global message cap (max_msgs ${cfg.max_msgs}); under discard-old it silently evicts never-deleted authority keys (SPEC 13.12); reprovision`);
  if (typeof cfg.max_bytes === "number" && cfg.max_bytes >= 0)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} carries a finite global byte cap (max_bytes ${cfg.max_bytes}); under discard-old it silently evicts never-deleted authority keys (SPEC 13.12); reprovision`);
  // STORE-BINDING (SPEC 13.12): the stream must BE the claimed KV bucket, not merely wear its
  // name — exactly the one `$KV.<bucket>.>` subject (an extra captured subject would put foreign
  // bodies inside every body-selected MSG.GET grant on this stream, breaking the metadata-only
  // residual claim) and durable file storage (a memory authority store forgets every fence and
  // revocation on broker restart). Both are REQUIRED, not skipped-when-absent: every caller
  // proves a real `streams.info` config, and an absent field here is an unproved store.
  const expectedSubject = `$KV.${bucket}.>`;
  if (!Array.isArray(cfg.subjects) || cfg.subjects.length !== 1 || cfg.subjects[0] !== expectedSubject)
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} does not carry exactly the subject ${expectedSubject} (got ${JSON.stringify(cfg.subjects)}); a stream that captures anything else is not this KV bucket, and its body-selected reads are not bounded to authority metadata (SPEC 13.12); reprovision`);
  if (cfg.storage !== "file")
    throw new EpEnvelopeError("failed-precondition", `the store ${bucket} has storage ${JSON.stringify(cfg.storage)}, not file; a non-durable authority store forgets fences and revocations on restart (SPEC 13.12); reprovision`);
}

/** Open the minting authority's sealed lifecycle registry: binds the space's primary records
 *  bucket AND its auth bucket. BOTH are shape-proved at bind (SPEC 13.12): primary, un-aged,
 *  no finite global eviction cap; the auth store additionally leader-only `allow_direct=false`. */
export async function openLifecycleRegistry(nc: NatsConnection, space: string, scanner?: AuthLedgerScanner, recordsScanner?: RecordsScanner): Promise<LifecycleRegistry> {
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
    throw new EpEnvelopeError("failed-precondition", `the auth store ${authBucket} has allow_direct=${String(authCfg.allow_direct)}, not false; a Direct-Get-capable gate store defeats read-your-writes (SPEC 13.1); reprovision`);
  // The injected scanner must be a REAL scanner (built by ledger-scanner.ts) bonded to THIS space —
  // a hand-assembled structural object or a foreign-space scanner would enumerate an empty/wrong
  // family and let a barrier advance over live descendants (SPEC 13.1/13.12). Same anti-hand-
  // assembly + space-bond discipline the registry itself carries.
  if (scanner !== undefined) assertScannerSpace(scanner, space);
  // Same anti-hand-assembly + space-bond discipline for the records scanner (SPEC 13.9, site 3): a
  // foreign-space or hand-built records scanner would let the retirement barrier's obligation drain
  // declare quiescence over live obligations it never read.
  if (recordsScanner !== undefined) assertRecordsScannerSpace(recordsScanner, space);
  const reg: LifecycleRegistry = Object.freeze({ space });
  REGISTRIES.set(reg, { space, recordsKv, authKv, jsm, js: jetstream(nc), work: await workPoolContext(nc, space), scanner, recordsScanner });
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
export function registryStores(reg: LifecycleRegistry): { space: string; recordsKv: KV; authKv: KV; jsm: JetStreamManager; js: JetStreamClient; work: WorkPoolContext } {
  return internals(reg);
}

/** PACKAGE-INTERNAL: the barrier's CLOSED enumeration seam (SPEC 13.9). Returns the sealed
 *  auth-ledger scanner or throws — a registry constructed WITHOUT one (the mint writer) never
 *  enumerates, so asking it to is a composition bug, not a silent degrade. Exposes only the closed
 *  scan ops; the raw scanner/connection/credential stay inside {@link openAuthLedgerScanner}. */
export function registryScanner(reg: LifecycleRegistry): AuthLedgerScanner {
  const s = internals(reg).scanner;
  if (s === undefined)
    throw new EpEnvelopeError("failed-precondition", "this lifecycle registry was opened without a sealed auth-ledger scanner; only the barrier registry enumerates (SPEC 13.9); open it with openAuthLedgerScanner");
  return s;
}

/** PACKAGE-INTERNAL: the retirement barrier's CLOSED obligation-enumeration seam (SPEC 13.9,
 *  site 3). Returns the sealed records scanner or throws — a registry constructed WITHOUT one never
 *  drains obligations, so asking it to is a composition bug, not a silent degrade. Exposes only the
 *  closed scan op; the raw scanner/connection/credential stay inside {@link openRecordsScanner}. */
export function registryRecordsScanner(reg: LifecycleRegistry): RecordsScanner {
  const s = internals(reg).recordsScanner;
  if (s === undefined)
    throw new EpEnvelopeError("failed-precondition", "this lifecycle registry was opened without a sealed records scanner; the retirement barrier's obligation drain requires one (SPEC 13.9); open it with openRecordsScanner");
  return s;
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
    // C1 (panel HIGH): our own completed advance MUST have cleared the revoked root stamp too. If
    // the epoch advanced under our opId but `currentCredentialId` is still set, that is IMPOSSIBLE
    // persisted state (a partial write or an old binary) — fail loud rather than report success
    // over a head that still wedges the successor mint.
    if (cur.mapping.currentCredentialId !== undefined)
      throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" advanced under takeover ${args.opId} but still names root credential ${cur.mapping.currentCredentialId}; the epoch CAS clears it atomically, so a residual stamp is impossible persisted state (SPEC 13.1)`);
    return "already-advanced";
  }
  if (cur.mapping.processEpoch !== args.fromEpoch)
    throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" is at epoch ${cur.mapping.processEpoch}, not the takeover's captured epoch ${args.fromEpoch} (or its +1); a foreign operation moved it (SPEC 13.1)`);
  // C1 (panel HIGH, all lanes): advance the epoch AND clear `currentCredentialId` in the SAME CAS.
  // The takeover's family revoke marked the incarnation's root row `revoked`; leaving the head
  // still naming that revoked root permanently wedges the successor mint (`ensureRootCredential`'s
  // fast path reads the stamped id, refuses its revoked state, and `setCurrentRootCredential`
  // refuses a value flip). Clearing the stamp makes the head's root slot ABSENT, so the successor's
  // release-last stamp can win. Root rotation stays a barrier's job — this CAS IS that barrier step.
  const { currentCredentialId: _revoked, ...rest } = cur.mapping;
  void _revoked;
  await updateRecordEntry(recordsKv, headKey(args.owner, args.actor), { ...rest, processEpoch: args.fromEpoch + 1, lastTakeoverOpId: assertLifecycleToken(args.opId) }, cur.revision);
  return "advanced";
}

/**
 * The issuance path's head CAS stamping the incarnation's ROOT credential (SPEC 13.1: the head's
 * `currentCredentialId` is what the connect arm's root-path equality check reads, so a superseded
 * root issuance is denied even while its old row still reads active). The mint protocol's
 * RELEASE-LAST final step: the active `cred.` row is durable and its gate finalize has won BEFORE
 * this runs, and the bearer bytes release only after it.
 *
 * ABSENT → value ONLY (idempotent for the SAME value): a head that already names a DIFFERENT root
 * credential REFUSES — flipping `currentCredentialId` without the full family revoke would leave
 * the old root's descendants connectable under the leaf check, so root ROTATION is exclusively a
 * barrier's job (takeover/retirement), never this seam's. Revision-pinned; ACTIVE at the SAME uid
 * only; a foreign head movement between the caller's read and this CAS loses fail-closed.
 */
export async function setCurrentRootCredential(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; credentialId: string },
): Promise<void> {
  const { recordsKv } = internals(reg);
  if (typeof args.credentialId !== "string" || args.credentialId.length === 0)
    throw new EpEnvelopeError("failed-precondition", "setCurrentRootCredential requires a credentialId");
  const cur = await readHeadCandidate(recordsKv, args.owner, args.actor);
  if (cur === undefined || cur.mapping.state !== "active" || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `stamping the root credential for "${args.owner}/${args.actor}" requires an ACTIVE head at uid ${args.lifecycleUid}; found ${cur === undefined ? "no head" : `${cur.mapping.state} at ${cur.mapping.lifecycleUid}`} (SPEC 13.1)`);
  if (cur.mapping.currentCredentialId === args.credentialId) return; // our own completed stamp
  if (cur.mapping.currentCredentialId !== undefined)
    throw new EpEnvelopeError("permission-denied", `the head for "${args.owner}/${args.actor}" already names root credential ${cur.mapping.currentCredentialId}; rotating it takes the full family-revoke barrier, never a bare head flip (the old root's descendants would stay connectable under the leaf check, SPEC 13.1)`);
  await updateRecordEntry(recordsKv, headKey(args.owner, args.actor), { ...cur.mapping, currentCredentialId: args.credentialId }, cur.revision);
}

/** The retirement barrier's head CONTAINMENT CAS (SPEC 13.1: `active → retiring`, bound to the
 *  retirement operation's durable intent — from this point every currency seam yields no current
 *  mapping and no current epoch, and the alias is NOT replaceable). PACKAGE-INTERNAL for the
 *  barrier only (no public retire seam exists); idempotent for the barrier's crash-resume. */
export async function beginHeadRetirementWithinBarrier(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"retiring" | "already-retiring"> {
  const { recordsKv } = internals(reg);
  const cur = await readHeadCandidate(recordsKv, args.owner, args.actor);
  if (cur === undefined || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the retirement of uid ${args.lifecycleUid} requires the head for "${args.owner}/${args.actor}" to name it; found ${cur === undefined ? "no head" : `uid ${cur.mapping.lifecycleUid}`} (SPEC 13.1)`);
  if (cur.mapping.state === "retiring") {
    if (cur.mapping.op?.opId !== args.opId)
      throw new EpEnvelopeError("permission-denied", `the head for "${args.owner}/${args.actor}" is retiring under operation ${cur.mapping.op?.opId ?? "<none>"}, not ${args.opId}; one retirement at a time, and a stranger never advances it (SPEC 13.1)`);
    return "already-retiring";
  }
  if (cur.mapping.state !== "active")
    throw new EpEnvelopeError("failed-precondition", `the head for "${args.owner}/${args.actor}" is "${cur.mapping.state}", not active; only an active head enters retirement containment (a completed terminal is decided at the gate, never re-entered here, SPEC 13.1)`);
  await updateRecordEntry(recordsKv, headKey(args.owner, args.actor), { ...cur.mapping, state: "retiring", op: { opId: assertLifecycleToken(args.opId), kind: "retirement" } }, cur.revision);
  return "retiring";
}

/** The retirement barrier's TERMINAL head CAS (`retiring → retired`, op-pinned) — the barrier's
 *  LAST step (SPEC 13.1: `retired` ASSERTS completed cleanup, which is what makes the alias
 *  replaceable). The op intent is dropped (it belongs to `retiring` only); idempotence at
 *  `retired` is decided by the CALLER against the gate's terminal op (the retired head itself
 *  carries no retirement stamp). PACKAGE-INTERNAL for the barrier only. */
export async function completeHeadRetirementWithinBarrier(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"retired" | "already-retired"> {
  const { recordsKv } = internals(reg);
  const cur = await readHeadCandidate(recordsKv, args.owner, args.actor);
  if (cur === undefined || cur.mapping.lifecycleUid !== args.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `the retirement terminal for uid ${args.lifecycleUid} requires the head for "${args.owner}/${args.actor}" to name it; found ${cur === undefined ? "no head" : `uid ${cur.mapping.lifecycleUid}`}; a replaced head is settled at the gate, never here (SPEC 13.1)`);
  if (cur.mapping.state === "retired") return "already-retired";
  if (cur.mapping.state !== "retiring" || cur.mapping.op?.opId !== args.opId)
    throw new EpEnvelopeError("permission-denied", `the head for "${args.owner}/${args.actor}" is ${cur.mapping.state === "retiring" ? `retiring under operation ${cur.mapping.op?.opId ?? "<none>"}` : `"${cur.mapping.state}"`}, not retiring under ${args.opId}; only the containing operation terminalizes its own retirement (SPEC 13.1)`);
  const { op: _op, ...rest } = cur.mapping;
  await updateRecordEntry(recordsKv, headKey(args.owner, args.actor), { ...rest, state: "retired" }, cur.revision);
  return "retired";
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
  throw new EpEnvelopeError("internal", "four fresh 128-bit UID candidates collided with existing reservations; that is not chance; inspect the uid.> family (SPEC 13.1)");
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
    throw new EpEnvelopeError("failed-precondition", "the freeze carries an empty successor token; a summary token is a non-empty stage.<opId> reference or absent (SPEC 13.1); validate before the CAS, never persist corruption");
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
    throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${current.row.state}"; only a frozen gate terminalizes (freeze first; the bar precedes the terminal, SPEC 13.1)`);
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
          `lifecycle activation for "${owner}/${actor}" lost the head CAS AND terminalizing its orphan gate failed; the uid ${lifecycleUid} is burned but its gate is still frozen by op ${opId}; resume the same op with resumeActivation: ${(cleanup as Error)?.message ?? String(cleanup)}`,
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
 * Activate the alias `(owner, actor)` AT THE CALLER'S uid — the production ISSUANCE activation
 * (SPEC 13.1). The grant row already minted the incarnation's uid and every bearer's
 * lifecycle-equality is bound to it, so a fresh reservation ({@link activateLifecycle}) would
 * strand the grant. Same saga order (reserve → gate frozen → head CAS → reopen LAST) with
 * ADOPT-instead-of-burn resume semantics: a reservation or frozen ACTIVATION gate already carried
 * by OUR alias at this uid is a prior attempt's durable progress and is adopted — burning the
 * grant's uid would permanently brick the grant — and a CAS loss to a SIBLING (same alias, same
 * uid) converges on the winner's state instead of refusing.
 *
 * Returns with the head ACTIVE at `lifecycleUid` and the issuance gate OPEN. Refuses loudly: an
 * active head at a DIFFERENT uid (`already-exists` — retiring a live predecessor is the takeover
 * barrier's job, which production issuance does not run in R1), a retiring head, a reservation
 * held by a FOREIGN alias, a foreign-operation freeze, and a terminally retired gate.
 */
export async function activateLifecycleAtUid(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; managerInstance: string },
): Promise<void> {
  const { recordsKv } = internals(reg);
  const { owner, actor, lifecycleUid } = args;
  assertLifecycleToken(lifecycleUid);
  if (typeof args.managerInstance !== "string" || args.managerInstance.length === 0)
    throw new EpEnvelopeError("failed-precondition", "activateLifecycleAtUid requires a managerInstance (the minting authority)");
  const current = await readHeadCandidate(recordsKv, owner, actor);
  if (current !== undefined && current.mapping.state === "active" && current.mapping.lifecycleUid !== lifecycleUid)
    throw new EpEnvelopeError("already-exists", `lifecycle "${owner}/${actor}" is active at uid ${current.mapping.lifecycleUid}, not this grant's ${lifecycleUid}; retiring a live predecessor is the takeover barrier's job and production issuance does not run it (R1) - despawn/retire the predecessor first, or grant a fresh actor name (SPEC 13.1)`);
  if (current !== undefined && current.mapping.state === "retiring")
    throw new EpEnvelopeError("failed-precondition", `lifecycle "${owner}/${actor}" is retiring (op ${current.mapping.op?.opId}); a retiring alias is not replaceable until its barrier completes (SPEC 13.1)`);
  const headIsOurs = current !== undefined && current.mapping.state === "active"; // same uid, by the guard above

  // 1. The uid reservation: win it, or adopt a prior attempt's — SAME alias only.
  if (!headIsOurs && (await tryReserveUid(reg, lifecycleUid, { owner, actor, mintedBy: args.managerInstance })) === "burned") {
    const res = await readUidReservation(reg, lifecycleUid);
    if (res === undefined || res.owner !== owner || res.actor !== actor)
      throw new EpEnvelopeError("permission-denied", `uid ${lifecycleUid} is reserved by ${res ? `"${res.owner}/${res.actor}"` : "an unreadable reservation"}, not "${owner}/${actor}"; a grant's uid is never adopted across aliases (SPEC 13.1)`);
  }

  // 2. The activation gate: create frozen, or adopt OUR prior attempt's frozen activation gate
  //    (the reservation above already binds this uid to this alias, so any activation freeze on
  //    it is this alias's own activation). A retry loop absorbs the sibling-race CAS losses.
  for (let attempt = 0; ; attempt++) {
    if (attempt > 4)
      throw new EpEnvelopeError("unavailable", `activation for "${owner}/${actor}" at uid ${lifecycleUid} keeps losing its gate/head CASes to concurrent movement; re-read and re-decide (SPEC 13.1)`);
    let gate = await observeGate(reg, lifecycleUid);
    let opId: string;
    if (gate === undefined) {
      try {
        gate = await createGateFrozen(reg, { lifecycleUid, op: { opId: mintLifecycleUid(), kind: "activation" } });
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
      const head = await readHeadCandidate(recordsKv, owner, actor);
      if (head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === lifecycleUid) return;
      throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${lifecycleUid} is open but the head for "${owner}/${actor}" is ${head === undefined ? "absent" : `${head.mapping.state} at ${head.mapping.lifecycleUid}`}; an activation reopens only AFTER its head CAS - this is foreign movement or corruption, refuse (SPEC 13.1/13.12)`);
    }

    // 3. The head CAS (create-only for virgin; revision-pinned over a retired predecessor). A
    //    loss converges if the sibling won for the SAME uid, refuses on a foreign winner.
    if (!headIsOurs) {
      const mapping: LifecycleMapping = { owner, actor, lifecycleUid, managerInstance: args.managerInstance, processEpoch: 1, state: "active" };
      try {
        if (current === undefined) await createRecordEntry(recordsKv, headKey(owner, actor), mapping);
        else await updateRecordEntry(recordsKv, headKey(owner, actor), mapping, current.revision);
      } catch (e) {
        if (!isCasLoss(e)) throw e;
        const head = await readHeadCandidate(recordsKv, owner, actor);
        if (!(head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === lifecycleUid))
          throw new EpEnvelopeError("conflict", `activation for "${owner}/${actor}" at uid ${lifecycleUid} lost the head CAS to a foreign movement (now ${head === undefined ? "absent" : `${head.mapping.state} at ${head.mapping.lifecycleUid}`}); re-grant raced this exchange - re-exchange (SPEC 13.1)`);
      }
    }

    // 4. Reopen the gate — the saga's LAST step. A loss to the sibling's reopen is convergence.
    try {
      await reopenGate(reg, { lifecycleUid, revision: gate.revision, opId });
      return;
    } catch (e) {
      const g = await observeGate(reg, lifecycleUid);
      if (g !== undefined && g.row.state === "open") return; // the sibling finished it
      if (e instanceof EpEnvelopeError && e.code === "conflict") continue; // revision moved; re-observe
      throw e;
    }
  }
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
