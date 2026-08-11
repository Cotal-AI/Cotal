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
  recordsBucket as coreRecordsBucket,
  lifecycleHeadKey as headKey,
  parseLifecycleHead as parseMapping,
  type LifecycleMapping,
  type EpGateRow,
  type LifecycleStateTransport,
  headCandidate,
  gateObserve,
  gateCreateFrozen,
  gateFreeze,
  gateReopen,
  gateRetire,
  uidTryReserve,
  uidReserveFresh,
  uidReadReservation,
  headAdvanceEpochWithinTakeover,
  headSetCurrentRootCredential,
  headBeginRetirement,
  headCompleteRetirement,
  runActivationSaga,
  runActivationSagaAtUid,
  resumeActivationSaga,
  createRecordEntry,
  updateRecordEntry,
  readRecordLeader,
  epAuthBucket,
  workPoolContext,
  type WorkPoolContext,
} from "@cotal-ai/core";
import { assertScannerSpace, type AuthLedgerScanner } from "./ledger-scanner.js";
import { assertRecordsScannerSpace, type RecordsScanner } from "./records-scanner.js";

const enc = new TextEncoder();

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
  // ONE encoder for the records-bucket name (core `recordsBucket`): the previous inline
  // `cotal_records_${space}` skipped `token(space)` — identical for every legal space name, but
  // a second encoder of a load-bearing name is exactly the drift class the shared grammar bans.
  const recordsBucket = coreRecordsBucket(space);
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
  // ONE encoder for the records-bucket name (core `recordsBucket`): the previous inline
  // `cotal_records_${space}` skipped `token(space)` — identical for every legal space name, but
  // a second encoder of a load-bearing name is exactly the drift class the shared grammar bans.
  const recordsBucket = coreRecordsBucket(space);
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

// The head value schema (`LifecycleMapping`), the key builders, and the boundary parser are the
// §13.1 STATE GRAMMAR, lifted to @cotal-ai/core (`lifecycle-state.ts`) so every lifecycle
// executor shares ONE encoder (imported above as `headKey`/`uidKey`/`parseMapping`). The types
// are re-exported below so the package surface is unchanged.
export type { LifecycleMapping, EpGateRow } from "@cotal-ai/core";

/** The sealed registry's write transport for the shared §13.1 saga sequencing
 *  (@cotal-ai/core `lifecycle-saga.ts`): constructed ONLY from this module's sealed internals,
 *  so the WeakMap brand still gates every write; the transport carries no sequencing decisions
 *  of its own (the three-way split: adapters are TRANSPORT, never a second saga). */
function transportOf(reg: LifecycleRegistry): LifecycleStateTransport {
  const { recordsKv, authKv } = internals(reg);
  const entryOf = (e: { value: Uint8Array; revision: number; operation: string } | null) =>
    e === null ? undefined : { value: e.value, revision: e.revision, operation: e.operation };
  return {
    getRecord: async (key) => entryOf(await recordsKv.get(key)),
    createRecord: (key, value) => createRecordEntry(recordsKv, key, value),
    updateRecord: (key, value, rev) => updateRecordEntry(recordsKv, key, value, rev),
    getAuth: async (key) => entryOf(await authKv.get(key)),
    putAuth: (key, payload, rev) => authKv.put(key, payload, { previousSeq: rev }),
  };
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
  return headCandidate(transportOf(reg), owner, actor);
}

/** The takeover barrier's epoch-advance head CAS (SPEC 13.1: NO public epoch advance exists;
 *  module-internal for the credential ledger's barrier only) — delegates to the shared §13.1
 *  sequencing (core `headAdvanceEpochWithinTakeover`, which also carries the C1 same-CAS
 *  root-stamp clear) over this registry's sealed transport. */
export async function advanceEpochWithinTakeover(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; fromEpoch: number; opId: string },
): Promise<"advanced" | "already-advanced"> {
  return headAdvanceEpochWithinTakeover(transportOf(reg), args);
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
  return headSetCurrentRootCredential(transportOf(reg), args);
}

/** The retirement barrier's head CONTAINMENT CAS (SPEC 13.1: `active → retiring`, bound to the
 *  retirement operation's durable intent — from this point every currency seam yields no current
 *  mapping and no current epoch, and the alias is NOT replaceable). PACKAGE-INTERNAL for the
 *  barrier only (no public retire seam exists); idempotent for the barrier's crash-resume. */
export async function beginHeadRetirementWithinBarrier(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
): Promise<"retiring" | "already-retiring"> {
  return headBeginRetirement(transportOf(reg), args);
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
  return headCompleteRetirement(transportOf(reg), args);
}

/** PACKAGE-INTERNAL: read a UID reservation's audit `{ owner, actor }` (the minting authority
 *  recorded it at {@link tryReserveUid}). The credential ledger uses it to BIND a mint's
 *  `holderPrincipal` to the reserved identity, so a trusted caller cannot ledger a row that
 *  names a foreign principal for the barrier to evict. A DEL/PURGE marker refuses loudly. */
export async function readUidReservation(
  reg: LifecycleRegistry,
  lifecycleUid: string,
): Promise<{ owner: string; actor: string } | undefined> {
  return uidReadReservation(transportOf(reg), lifecycleUid);
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
  return uidTryReserve(transportOf(reg), lifecycleUid, audit);
}

/** Reserve a fresh lifecycle UID space-globally (§13.1): mint a CSPRNG candidate, win its
 *  create-only reservation, and on a collision burn the candidate and draw another. At ≥128
 *  bits a collision is effectively adversarial, so a handful of retries is a correctness
 *  formality, not a capacity plan; exhausting them refuses loudly. */
export async function reserveLifecycleUid(
  reg: LifecycleRegistry,
  audit: { owner: string; actor: string; mintedBy: string },
): Promise<string> {
  return uidReserveFresh(transportOf(reg), audit);
}

// ---- the issuance-gate CAS primitives (auth store, agent family `gate.<lifecycleUid>`) -------

// The gate row schema (`EpGateRow`), key builder, and boundary parser live in the shared §13.1
// STATE GRAMMAR in @cotal-ai/core (`lifecycle-state.ts`), imported above as
// `gateKey`/`parseGate`; the type is re-exported beside `LifecycleMapping`.

/** Observe the gate (the candidate read feeding a revision-pinned CAS; the auth store is
 *  leader-only by shape, `allow_direct=false`). A DEL/PURGE marker refuses loudly. */
export async function observeGate(reg: LifecycleRegistry, lifecycleUid: string): Promise<{ row: EpGateRow; revision: number } | undefined> {
  return gateObserve(transportOf(reg), lifecycleUid);
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
  return gateCreateFrozen(transportOf(reg), args);
}

/** CAS the gate `open → frozen` carrying the freezing operation's durable intent, at the
 *  observed revision. The bar of every barrier: a staged mint's own finalize CAS loses. */
export async function freezeGate(
  reg: LifecycleRegistry,
  args: { lifecycleUid: string; revision: number; op: { opId: string; kind: "takeover" | "registration" | "retirement"; successor?: string } },
): Promise<{ row: EpGateRow; revision: number }> {
  return gateFreeze(transportOf(reg), args);
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
  return gateReopen(transportOf(reg), args);
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
  return gateRetire(transportOf(reg), args);
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
  return runActivationSaga(transportOf(reg), args);
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
  return runActivationSagaAtUid(transportOf(reg), args);
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
  return resumeActivationSaga(transportOf(reg), args);
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
