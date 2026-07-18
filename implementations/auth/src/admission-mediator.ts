/**
 * The D13 (4) ADMISSION MEDIATOR + admission-policy coordinate (SPEC §13.6/§13.8/§13.9, as
 * amended): the per-endpoint mediated writer that owns the `oblig.` prefix — the ONE durable
 * serialization coordinate on which a durable acceptance/start contends with its authority
 * head's movement — plus the govern-head policy selector's stage/drain/promote protocol and
 * the immutable `policy.<endpoint>.<digest-hex>` version publication.
 *
 * The §13.8 protocol, implemented here end to end:
 *  1. CREATE-FENCE: immediately before the create, the mediator performs the FENCING currency
 *     reads it will pin — a leader-served read of the target's lifecycle head (REFUSING unless
 *     `active` at the presented uid) for a target-bound admission, and a leader-served read of
 *     the enforced policy under the govern head for a policy-admitted decision (REFUSING while
 *     a `pendingPolicy…` is staged: the endpoint is inside its drain window). It then creates
 *     the obligation row create-only at the deterministic acceptance-identity key; a create
 *     loser leader-reads the winner and JOINS only on the FULL pinned identity (an `epf` row on
 *     fingerprint + route; a `self` row on the ENTIRE commit intent), else `conflict`.
 *  2. PROOF-GATED ADMISSION: after winning or joining, the mediator leader-reads the SAME
 *     coordinates AGAIN and only then returns the opaque admission proof (BRANDED, bounded-
 *     lived, bound to `{ space, endpoint, obligation key, opId }`); on any movement it settles
 *     its own provisional through the row's per-class decision coordinate and refuses. An
 *     obligation created in the movement window exists durably but can never admit.
 *  3. PER-CLASS DECISION COORDINATES: an `epf` row settles through the EPF decision subject's
 *     create-only CAS (the mediator holds the terminal-REJECTION publish, §13.9, with the
 *     explicit D32 residual); a `self` row settles on ITSELF (`provisional → accepted` by the
 *     writer under an unexpired proof vs `provisional → rejected` by the drain, one CAS wins),
 *     and an `accepted` `self` row is deterministically finishable from its pinned commit
 *     intent alone ({@link recoverSelfObligation}: landed / re-apply / superseded).
 *  4. DRAIN TO QUIESCENCE: enumerate the prefix (per-run throwaway LastPerSubject PULL
 *     consumer, fail-loud on markers and parse failures), settle every provisional through its
 *     decision coordinate, drive every accepted `self` row to terminal, RE-ENUMERATE until an
 *     enumeration finds no unsettled row. Quiescence = no `provisional` and no un-driven
 *     accepted `self` rows (§13.8; accepted `epf` work is tracked by its route facts).
 *
 * AUTHORITY BOUNDARIES (§13.9): the mediator's own grant is the `oblig.` create + CAS, the
 * FENCING leader reads, and the EPF terminal-rejection publish. The guarded commit's WRITE
 * stays with the writer principal — recovery takes an injected `applyCommit` and the mediator
 * never holds the record-write grant itself. The policy-version publish and the govern-head
 * selector CAS belong to the provisioner-registration principal, so those functions take the
 * sealed {@link LifecycleRegistry} (the reference implementation's provisioner authority),
 * not the mediator. The endpoint identity bind (§13.8's confined policy reader) is structural
 * here: the mediator is SEALED per endpoint at open, every obligation key derives its endpoint
 * token from the sealed identity, and a proof never validates for another endpoint's mediator.
 *
 * NOT HERE (later slices): the exact-pool terminal cleaner and the retirement barrier
 * orchestration (D13 (5)) consume {@link drainTargetForEndpoint}; the production canonicalizer
 * wiring rides the EPF slice.
 */
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError,
  OBLIGATION, OBLIGATION_EP_SENTINEL, POLICY_VERSION, GOVERN_HEAD,
  recordAtomicKey, createRecordEntry, updateRecordEntry, readRecordLeader, recordsBucket,
  epfEffectSubject, epfSubject, epfStreamName, epwSubject, epwStreamName, goalResultSubject, parseGoalResultFact, publishFactCreateOnly, readLastFact, parseDecisionFact, parseEffectFact,
  workTerminalSubject, parseWorkTerminalFact,
  contractDigest, parseEpSubject,
  type RejectionFact, type DecisionFact, type WorkItemRef,
  mintLifecycleUid, assertLifecycleToken, assertIdToken, endpointToken, assertPoolToken,
} from "@cotal-ai/core";
import {
  assertAuthorityStreamShape, registryStores, openLifecycleMappingReader, readLifecycleMappingLeader,
  type AuthorityStreamCfg, type LifecycleRegistry, type LifecycleMappingReader,
} from "./lifecycle-registry.js";
import { assertRecordsScannerSpace, type RecordsScanner } from "./records-scanner.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Every `*Digest` scalar on the wire is `sha256:<hex>` (§13.7/§13.8), the shape core's own fact
 *  validators and canonicalizer emit; the mediator stores and compares that shape end to end and
 *  strips the prefix only at a raw-hash boundary. */
const DIGEST_SCALAR_RE = /^sha256:[0-9a-f]{64}$/;
/** The §13.4 error-detail bound: `parseDecisionFact` rejects a longer detail, so a rejection the
 *  mediator publishes must fit it or core would refuse the mediator's own fact. */
const MAX_ERROR_DETAIL = 256;
/** The proof TTL ceiling (§13.8: a proof is bounded-lived; 60 s is 4x the reference call
 *  deadline, headroom for a slow admission without letting a proof outlive its state). */
const MAX_PROOF_TTL_MS = 60_000;

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a multibyte character
 *  (the §13.4 error-detail bound is a BYTE limit; a UTF-16 `.slice` can overshoot it). */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = s;
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}
const isCasLoss = (e: unknown): boolean => e instanceof EpEnvelopeError && e.code === "conflict";
/** The CANONICAL content digest of a JSON value, `<hex>` (no prefix) for a `policy` key segment.
 *  Uses core's RFC-8785 canonicalizer (`contractDigest` = `sha256:<hex over I-JSON>`), so
 *  publication is insensitive to property order and a second implementation that content-
 *  addresses the same policy lands on the SAME key; also validates the value is I-JSON (throws
 *  otherwise), so a non-canonicalizable policy is refused before any create. */
const canonicalDigestHex = (value: unknown): string => contractDigest(value).slice("sha256:".length);

// ---- the sealed per-endpoint mediator ---------------------------------------------------------

/** The sealed admission mediator for ONE endpoint (BRANDED, §13.12: a hand-assembled object
 *  never authorizes). The endpoint bind is structural: every obligation this mediator touches
 *  carries its own sealed endpoint token, so endpoint A can never obtain, settle, or replay
 *  endpoint B's admission (§13.8's confined-reader identity bind, in-process form). */
export interface AdmissionMediator {
  readonly space: string;
  readonly endpoint: string;
}

interface MediatorInternals {
  space: string;
  endpoint: string;
  recordsKv: KV;
  jsm: JetStreamManager;
  js: JetStreamClient;
  reader: LifecycleMappingReader;
  now: () => number;
  proofTtlMs: number;
  recordsScanner: RecordsScanner;
}
const MEDIATORS = new WeakMap<AdmissionMediator, MediatorInternals>();

function internals(med: AdmissionMediator): MediatorInternals {
  const i = MEDIATORS.get(med);
  if (!i)
    throw new EpEnvelopeError("failed-precondition", "the admission mediator was not constructed by openAdmissionMediator(); a hand-assembled context never authorizes (SPEC 13.12)");
  return i;
}

/** Open the sealed per-endpoint admission mediator over the space's PRIMARY records store —
 *  shape-proved at bind exactly like every trusted consumer of that store (SPEC 13.12).
 *  `now`/`proofTtlMs` are probe seams; the proof TTL defaults to the §13.8 reference call
 *  deadline (15 s). `recordsScanner` is the SEALED records-obligation scanner the mediator's
 *  drain-to-quiescence enumeration runs on (SPEC 13.9, site 3): the mediator's own credential holds
 *  NO `CONSUMER.CREATE` on the records stream (a create-request body is not subject-ACL confinable —
 *  nats-server#8274), so it can never build a durable+PUSH exporter of its `oblig.` subtree; the
 *  CREATE lives only inside {@link ./records-scanner.ts}. Required: a mediator that cannot enumerate
 *  cannot drain (SPEC 13.8), which is a composition bug, not a silent degrade. */
export async function openAdmissionMediator(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  opts: { now?: () => number; proofTtlMs?: number; recordsScanner: RecordsScanner },
): Promise<AdmissionMediator> {
  assertRecordsScannerSpace(opts.recordsScanner, space);
  const ep = endpointToken(endpoint);
  const bucket = recordsBucket(space);
  const jsm = await jetstreamManager(nc);
  let recordsKv: KV;
  let cfg: AuthorityStreamCfg;
  try {
    recordsKv = await new Kvm(nc).open(bucket);
    cfg = (await jsm.streams.info(`KV_${bucket}`)).config as AuthorityStreamCfg;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the records store ${bucket} is not provisioned (run space setup; SPEC 13.12): ${(e as Error)?.message ?? String(e)}`);
  }
  assertAuthorityStreamShape(cfg, bucket);
  const reader = await openLifecycleMappingReader(nc, space);
  // The proof TTL is CAPPED to the reference call-deadline ceiling (§13.8: a proof is
  // bounded-lived, and an effectively-unbounded TTL would let a stale proof outlive the state
  // it was issued against). A larger value fails loud rather than being silently clamped.
  if (opts.proofTtlMs !== undefined && (!Number.isSafeInteger(opts.proofTtlMs) || opts.proofTtlMs <= 0 || opts.proofTtlMs > MAX_PROOF_TTL_MS))
    throw new EpEnvelopeError("failed-precondition", `proofTtlMs ${JSON.stringify(opts.proofTtlMs)} is not a positive safe integer within the ${MAX_PROOF_TTL_MS} ms bound (a proof is bounded-lived, SPEC 13.8)`);
  const med: AdmissionMediator = Object.freeze({ space, endpoint: ep });
  MEDIATORS.set(med, {
    space, endpoint: ep, recordsKv, jsm, js: jetstream(nc), reader,
    now: opts.now ?? Date.now, proofTtlMs: opts.proofTtlMs ?? 15_000,
    recordsScanner: opts.recordsScanner,
  });
  return med;
}

// ---- the obligation row (§13.7 key grammar, §13.8 closed per-class value) ---------------------

/** The §13.8 commit-value union (CLOSED): a canonical base64url JSON encoding of the committed
 *  value, or an IMMUTABLE `policy`-kind records key whose stored value IS the commit value. */
export type CommitValue = { enc: "b64u"; bytes: string } | { enc: "ref"; key: string };

/** The complete `self`-class commit intent (§13.8): a crashed writer's commit is finishable from
 *  this alone. `commitDigest` is the RFC-8785 CANONICAL content digest of the committed value,
 *  `sha256:<hex>` (the same `*Digest` scalar shape §13.7 uses). `commitValue` is RESOLVED and
 *  its canonical digest VERIFIED against `commitDigest` at obtain (before the row can accept),
 *  so a mismatched value/digest can never reach `accepted` and wedge recovery. */
export interface SelfCommitIntent {
  commitKey: string;
  commitBaseRevision: number;
  commitValue: CommitValue;
  commitDigest: string;
}

export type ObligationState = "provisional" | "accepted" | "rejected" | "terminal";

/** One obligation row (CLOSED per-class schema, §13.8). The `decision` class is fixed by the
 *  TRUSTED operation kind ({@link obtainEpfObligation} vs {@link obtainSelfObligation}), never
 *  caller-selectable. */
export interface ObligationRow {
  state: ObligationState;
  decision: "epf" | "self";
  opId: string;
  /** Present iff target-bound: the target head's store revision pinned at the create-fence. */
  mappingRevision?: number;
  /** Present iff policy-admitted: the enforced policy record's store revision. */
  policyRevision?: number;
  /** epf-class only: the canonical acceptance's identity. */
  fingerprint?: string;
  sourceSeq?: number;
  route?: string;
  /** self-class only: the complete commit intent. */
  commit?: SelfCommitIntent;
}

/** A BRANDED mediated request (§13.8: "derives the coordinate from the broker-authenticated
 *  request subject, never a body field"). The endpoint and caller triple come ONLY from parsing
 *  an authenticated request/journal subject through {@link mediatedRequestFromSubject}; a caller
 *  can never hand-assemble one, so the obligation coordinate's identity is structurally the
 *  broker-authenticated identity, not a body-supplied `caller`. */
export interface MediatedRequest {
  readonly endpoint: string;
  readonly caller: { readonly owner: string; readonly actor: string; readonly uid: string };
}
const MEDIATED_REQUESTS = new WeakSet<MediatedRequest>();

/** Build the branded mediated request from the RAW authenticated request subject the broker
 *  delivered (an `ep`-plane request or an `epj`-plane journal submission). Core's
 *  {@link parseEpSubject} extracts the endpoint + caller triple STRUCTURALLY from the subject;
 *  a malformed subject, or one that is not a request/journal, refuses. The `id` (the
 *  caller-chosen request id, §13.4) is NOT in the subject and stays an explicit operation
 *  argument; everything that identifies WHO the caller is comes from here. */
export function mediatedRequestFromSubject(subject: string): MediatedRequest {
  const parsed = parseEpSubject(subject);
  if (parsed === null || (parsed.plane !== "request" && parsed.plane !== "journal"))
    throw new EpEnvelopeError("failed-precondition", `the admission request subject ${JSON.stringify(subject)} is not an authenticated request/journal subject; the obligation identity derives from the subject, never a body field (SPEC 13.8)`);
  const c = parsed.caller;
  const req: MediatedRequest = Object.freeze({ endpoint: parsed.endpoint, caller: Object.freeze({ owner: c.owner, actor: c.actor, uid: c.uid }) });
  MEDIATED_REQUESTS.add(req);
  return req;
}

function assertMediatedRequest(med: MediatorInternals, request: MediatedRequest): void {
  if (!MEDIATED_REQUESTS.has(request))
    throw new EpEnvelopeError("permission-denied", "the admission request was not derived from an authenticated subject via mediatedRequestFromSubject(); a hand-assembled caller identity never authorizes (SPEC 13.8/13.12)");
  if (request.endpoint !== med.endpoint)
    throw new EpEnvelopeError("permission-denied", `the admission request is for endpoint "${request.endpoint}", not this mediator's "${med.endpoint}"; a mediator admits only its own endpoint's requests (SPEC 13.8/13.9)`);
}

/** The operation coordinates NOT carried by the authenticated identity: the target lifecycle
 *  this admission binds to (omitted = the `ep` sentinel), whether it pins the enforced policy
 *  (§13.6), and the caller-chosen request id (§13.4, a body field, legitimately caller-supplied
 *  because it identifies the REQUEST, not WHO the caller is). At least one of target/policy. */
export interface AdmissionOp {
  target?: { owner: string; actor: string; lifecycleUid: string };
  policy?: boolean;
  id: string;
}

function obligationKey(med: MediatorInternals, request: MediatedRequest, op: AdmissionOp): string {
  const target = op.target === undefined ? OBLIGATION_EP_SENTINEL : assertLifecycleToken(op.target.lifecycleUid, "target lifecycleUid");
  return recordAtomicKey(OBLIGATION, [target, med.endpoint, request.caller.owner, request.caller.actor, request.caller.uid, op.id]);
}

const OBLIGATION_STATES = new Set<string>(["provisional", "accepted", "rejected", "terminal"]);
const ROUTE_RE = /^(effects|pool\.[a-z0-9_-]{1,64})$/;
const DIGEST_HEX_RE = /^[0-9a-f]{64}$/; // the `policy.<endpoint>.<digest-hex>` KEY segment is bare hex (§13.7)
/** The submission fingerprint core's `parseDecisionFact` accepts — a `sha256:<hex>` scalar (the
 *  same shape `submissionFingerprint` emits). A row whose fingerprint is not this cannot settle
 *  through a core-conformant rejection fact, so it is refused at obtain, never persisted. */
const FINGERPRINT_RE = DIGEST_SCALAR_RE;

function parseCommitValue(v: unknown, key: string): CommitValue {
  if (!isRec(v)) throw new EpEnvelopeError("internal", `the obligation ${key} carries a non-object commitValue (SPEC 13.8)`);
  const keys = Object.keys(v).sort();
  if (v.enc === "b64u" && keys.join(",") === "bytes,enc" && typeof v.bytes === "string" && /^[A-Za-z0-9_-]*$/.test(v.bytes))
    return v as CommitValue;
  if (v.enc === "ref" && keys.join(",") === "enc,key" && typeof v.key === "string" && v.key.length > 0)
    return v as CommitValue;
  throw new EpEnvelopeError("internal", `the obligation ${key} carries a malformed commitValue (the CLOSED b64u|ref union, SPEC 13.8)`);
}

/** Validate an obligation row at the consuming boundary: CLOSED per-class schema, at least one
 *  currency pin, class-required fields present and class-foreign fields absent (SPEC 13.8). */
export function parseObligationRow(raw: Uint8Array, key: string): ObligationRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the obligation ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.8)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the obligation ${key} is not an object`);
  const allowed = new Set(["state", "decision", "opId", "mappingRevision", "policyRevision", "fingerprint", "sourceSeq", "route", "commit"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the obligation ${key} carries the unknown field "${k}" (closed schema, SPEC 13.8)`);
  if (typeof o.state !== "string" || !OBLIGATION_STATES.has(o.state) || (o.decision !== "epf" && o.decision !== "self") || typeof o.opId !== "string")
    throw new EpEnvelopeError("internal", `the obligation ${key} does not validate (state/decision/opId, SPEC 13.8)`);
  try {
    assertLifecycleToken(o.opId);
  } catch {
    throw new EpEnvelopeError("internal", `the obligation ${key} carries a malformed opId (SPEC 13.8)`);
  }
  if (o.mappingRevision !== undefined && !uint(o.mappingRevision))
    throw new EpEnvelopeError("internal", `the obligation ${key} carries a non-integer mappingRevision (SPEC 13.8)`);
  if (o.policyRevision !== undefined && !uint(o.policyRevision))
    throw new EpEnvelopeError("internal", `the obligation ${key} carries a non-integer policyRevision (SPEC 13.8)`);
  if (o.mappingRevision === undefined && o.policyRevision === undefined)
    throw new EpEnvelopeError("internal", `the obligation ${key} pins NO currency coordinate (at least one of mappingRevision/policyRevision, SPEC 13.8)`);
  if (o.decision === "epf") {
    if (o.commit !== undefined)
      throw new EpEnvelopeError("internal", `the obligation ${key} is epf-class but carries a self-class commit intent (SPEC 13.8)`);
    if (typeof o.fingerprint !== "string" || !FINGERPRINT_RE.test(o.fingerprint) || !uint(o.sourceSeq) || o.sourceSeq < 1 || typeof o.route !== "string" || !ROUTE_RE.test(o.route))
      throw new EpEnvelopeError("internal", `the obligation ${key} is epf-class without a valid { fingerprint (sha256:<hex>), sourceSeq (>=1), route } (SPEC 13.4/13.8)`);
  } else {
    if (o.fingerprint !== undefined || o.sourceSeq !== undefined || o.route !== undefined)
      throw new EpEnvelopeError("internal", `the obligation ${key} is self-class but carries epf-class fields (SPEC 13.8)`);
    if (!isRec(o.commit))
      throw new EpEnvelopeError("internal", `the obligation ${key} is self-class without its commit intent (SPEC 13.8)`);
    const cm = o.commit as Record<string, unknown>;
    for (const k of Object.keys(cm)) if (!["commitKey", "commitBaseRevision", "commitValue", "commitDigest"].includes(k)) throw new EpEnvelopeError("internal", `the obligation ${key} commit intent carries the unknown field "${k}" (closed schema, SPEC 13.8)`);
    if (typeof cm.commitKey !== "string" || cm.commitKey.length === 0 || !uint(cm.commitBaseRevision) || typeof cm.commitDigest !== "string" || !DIGEST_SCALAR_RE.test(cm.commitDigest))
      throw new EpEnvelopeError("internal", `the obligation ${key} commit intent does not validate (commitDigest is sha256:<hex>, SPEC 13.8)`);
    parseCommitValue(cm.commitValue, key);
  }
  return o as unknown as ObligationRow;
}

async function readObligationLeader(med: MediatorInternals, key: string): Promise<{ row: ObligationRow; revision: number } | undefined> {
  const read = await readRecordLeader(med.jsm, med.space, key);
  if (read === undefined) return undefined;
  return { row: parseObligationRow(enc.encode(JSON.stringify(read.value)), key), revision: read.revision };
}

// ---- the policy selector (§13.6) and the immutable policy version (§13.7) ---------------------

/** The govern head's normative policy selector fields (§13.6). The rest of the head value
 *  (the binding map, the provisional registration slot) is the registration path's and is
 *  PRESERVED verbatim by the selector CAS steps here. */
export interface PolicySelector {
  enforcedPolicyKey?: string;
  enforcedPolicyRevision?: number;
  pendingPolicyKey?: string;
  pendingPolicyRevision?: number;
}

function parseSelector(head: Record<string, unknown>, key: string): PolicySelector {
  const sel: PolicySelector = {};
  const pair = (kk: "enforcedPolicyKey" | "pendingPolicyKey", rk: "enforcedPolicyRevision" | "pendingPolicyRevision") => {
    const k = head[kk], r = head[rk];
    if ((k === undefined) !== (r === undefined))
      throw new EpEnvelopeError("internal", `the govern head ${key} carries ${kk}/${rk} unpaired; the selector is atomic (SPEC 13.6)`);
    if (k === undefined) return;
    if (typeof k !== "string" || k.length === 0 || !uint(r))
      throw new EpEnvelopeError("internal", `the govern head ${key} carries a malformed ${kk}/${rk} (SPEC 13.6)`);
    sel[kk] = k;
    sel[rk] = r as number;
  };
  pair("enforcedPolicyKey", "enforcedPolicyRevision");
  pair("pendingPolicyKey", "pendingPolicyRevision");
  return sel;
}

/** Publish ONE immutable policy version (§13.7 `policy.<endpoint>.<digest-hex>`): the key is the
 *  RFC-8785 CANONICAL content digest of the value (property-order-insensitive, so a conforming
 *  second implementation content-addresses the same policy to the same key), so publication is
 *  content-addressed and idempotent; an existing key whose value does not re-digest to it is
 *  corruption. Provisioner-registration authority (§13.9): takes the sealed registry, not the
 *  mediator. */
export async function publishPolicyVersion(
  reg: LifecycleRegistry,
  endpoint: string,
  value: unknown,
): Promise<{ key: string; revision: number; digestHex: string }> {
  const { recordsKv } = registryStores(reg);
  const digestHex = canonicalDigestHex(value); // throws on non-I-JSON before any create
  const key = recordAtomicKey(POLICY_VERSION, [endpoint, digestHex]);
  try {
    const revision = await createRecordEntry(recordsKv, key, value);
    return { key, revision, digestHex };
  } catch (e) {
    if (!isCasLoss(e)) throw e;
    const existing = await recordsKv.get(key);
    if (!existing || existing.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the policy version ${key} carries a ${existing?.operation ?? "missing"} marker; policy versions are never deleted (corruption, SPEC 13.12)`);
    if (canonicalDigestHex(JSON.parse(dec.decode(existing.value))) !== digestHex)
      throw new EpEnvelopeError("internal", `the policy version ${key} exists with a value that does not canonically digest to its own key; a self-certifying key never lies (corruption, SPEC 13.7)`);
    return { key, revision: existing.revision, digestHex };
  }
}

/** Leader-read + SELF-CERTIFY one immutable policy version: the stored bytes must digest to
 *  the key's own `<digest-hex>`, and the key must belong to THIS endpoint (the §13.8 identity
 *  bind: endpoint A can never be governed by a key smuggled from endpoint B's family). */
async function readPolicyVersionCertified(
  jsm: JetStreamManager,
  space: string,
  endpoint: string,
  key: string,
): Promise<{ value: unknown; revision: number }> {
  const expectedPrefix = `policy.${endpoint}.`;
  if (!key.startsWith(expectedPrefix))
    throw new EpEnvelopeError("failed-precondition", `the policy key ${key} does not belong to endpoint "${endpoint}" (the selector names only this endpoint's own policy family, SPEC 13.6)`);
  const digestHex = key.slice(expectedPrefix.length);
  if (!DIGEST_HEX_RE.test(digestHex))
    throw new EpEnvelopeError("failed-precondition", `the policy key ${key} is not digest-addressed (SPEC 13.7)`);
  const read = await readRecordLeader(jsm, space, key);
  if (read === undefined)
    throw new EpEnvelopeError("failed-precondition", `the policy version ${key} does not exist; the selector names a published immutable version only (SPEC 13.6)`);
  if (canonicalDigestHex(read.value) !== digestHex)
    throw new EpEnvelopeError("internal", `the policy version ${key} does not canonically digest to its own key; a self-certifying key never lies (corruption, SPEC 13.7)`);
  return read;
}

/** LEADER-SERVED govern-head read (§13.9: every govern read that fences a stage/promote/drain
 *  decision is leader-served `STREAM.MSG.GET`, never a follower Direct Get, or a multi-server
 *  stage/promote could act on a stale selector). `readRecordLeader` refuses a DEL/PURGE marker
 *  as corruption. Returns the head object + its store revision (the stage/promote CAS pins it). */
async function readGovernHeadRaw(jsm: JetStreamManager, space: string, endpoint: string): Promise<{ head: Record<string, unknown>; revision: number } | undefined> {
  const key = recordAtomicKey(GOVERN_HEAD, [endpoint]);
  const read = await readRecordLeader(jsm, space, key);
  if (read === undefined) return undefined;
  if (!isRec(read.value)) throw new EpEnvelopeError("internal", `the govern head ${key} is not an object`);
  return { head: read.value, revision: read.revision };
}

/** STAGE a policy mutation (§13.6 step 1, provisioner authority): verify the NEW immutable
 *  version exists and self-certifies, then CAS `pendingPolicy{Key,Revision}` onto the govern
 *  head, preserving every other head field verbatim (the binding map and registration slot are
 *  the registration path's). A virgin head is created with an empty binding map. A pending
 *  already staged refuses (`conflict`: one mutation at a time; promote or abandon it first). */
export async function stagePolicySelector(
  reg: LifecycleRegistry,
  endpoint: string,
  policyKey: string,
): Promise<{ pendingPolicyKey: string; pendingPolicyRevision: number; mutationOpId: string; governRevision: number }> {
  const { recordsKv, jsm, space } = registryStores(reg);
  const ep = endpointToken(endpoint);
  const version = await readPolicyVersionCertified(jsm, space, ep, policyKey);
  const govKey = recordAtomicKey(GOVERN_HEAD, [ep]);
  const cur = await readGovernHeadRaw(jsm, space, ep);
  const head: Record<string, unknown> = cur === undefined ? { commands: {} } : { ...cur.head };
  parseSelector(head, govKey);
  if (head.pendingPolicyKey !== undefined)
    throw new EpEnvelopeError("conflict", `the govern head ${govKey} already stages pending policy ${String(head.pendingPolicyKey)}; one mutation at a time; promote or abandon it first (SPEC 13.6)`);
  // A UNIQUE mutation opId stamped on the head binds this exact stage: a drain witness carries it,
  // and a later re-stage (a NEW opId) invalidates any witness from an earlier stage, even for the
  // same content-addressed policy key (the freelance's stage→drain→promote→re-stage→reuse attack).
  const mutationOpId = mintLifecycleUid();
  head.pendingPolicyKey = policyKey;
  head.pendingPolicyRevision = version.revision;
  head.pendingMutationOpId = mutationOpId;
  const governRevision = cur === undefined
    ? await createRecordEntry(recordsKv, govKey, head)
    : await updateRecordEntry(recordsKv, govKey, head, cur.revision);
  return { pendingPolicyKey: policyKey, pendingPolicyRevision: version.revision, mutationOpId, governRevision };
}

/** The BRANDED drain-quiescence witness {@link drainEndpointPolicy} mints: proof that the
 *  endpoint's POLICY-PINNED obligations enumerated quiescent for THIS exact staged mutation.
 *  {@link promotePolicySelector} accepts nothing else, and binds it to the exact
 *  `(space, endpoint, pendingKey, pendingRevision, mutationOpId, governStageRevision)` so a
 *  witness cannot be replayed across spaces (the same content-addressed key elsewhere), across
 *  re-stages (a new mutationOpId), or against a moved govern head (the promote CASes from
 *  `governStageRevision`). A promote CONSUMES the witness (§13.6). */
export interface DrainQuiescence {
  readonly space: string;
  readonly endpoint: string;
  readonly pendingPolicyKey: string;
  readonly pendingPolicyRevision: number;
  readonly mutationOpId: string;
  readonly governStageRevision: number;
}
const QUIESCENCE = new WeakSet<DrainQuiescence>();

/** PROMOTE a staged policy mutation (§13.6 step 2, provisioner authority): only under the
 *  branded drain witness for the SAME endpoint and pending key. Moves `pendingPolicy…` into
 *  `enforcedPolicy…` and clears the pending slot, preserving every other head field. */
export async function promotePolicySelector(
  reg: LifecycleRegistry,
  endpoint: string,
  quiescence: DrainQuiescence,
): Promise<{ enforcedPolicyKey: string; enforcedPolicyRevision: number }> {
  const { recordsKv, jsm, space } = registryStores(reg);
  const ep = endpointToken(endpoint);
  if (!QUIESCENCE.has(quiescence))
    throw new EpEnvelopeError("failed-precondition", "the promote was not given a drain-minted quiescence witness; a hand-assembled witness never authorizes (SPEC 13.6/13.12)");
  if (quiescence.space !== space)
    throw new EpEnvelopeError("permission-denied", `the quiescence witness belongs to space "${quiescence.space}", not "${space}"; a witness never crosses spaces (SPEC 13.6)`);
  if (quiescence.endpoint !== ep)
    throw new EpEnvelopeError("permission-denied", `the quiescence witness belongs to endpoint "${quiescence.endpoint}", not "${ep}" (SPEC 13.6)`);
  const govKey = recordAtomicKey(GOVERN_HEAD, [ep]);
  const cur = await readGovernHeadRaw(jsm, space, ep); // leader-served fence
  if (cur === undefined)
    throw new EpEnvelopeError("failed-precondition", `the govern head ${govKey} does not exist; nothing is staged (SPEC 13.6)`);
  // Bind to the EXACT staged mutation: the head must still carry the witness's pending key AND
  // the witness's mutation opId AND be at the witness's captured store revision. A re-stage
  // (new opId, moved revision), a clear/restage, or a foreign promote in between all fail here,
  // and the CAS from that exact revision is the final serialization.
  const sel = parseSelector(cur.head, govKey);
  if (sel.pendingPolicyKey === undefined)
    throw new EpEnvelopeError("failed-precondition", `the govern head ${govKey} stages no pending policy; nothing to promote (SPEC 13.6)`);
  if (sel.pendingPolicyKey !== quiescence.pendingPolicyKey || sel.pendingPolicyRevision !== quiescence.pendingPolicyRevision || cur.head.pendingMutationOpId !== quiescence.mutationOpId || cur.revision !== quiescence.governStageRevision)
    throw new EpEnvelopeError("conflict", `the govern head ${govKey} moved since the witness was minted (staged ${String(sel.pendingPolicyKey)}@${String(sel.pendingPolicyRevision)} op ${String(cur.head.pendingMutationOpId)} rev ${cur.revision}, witness ${quiescence.pendingPolicyKey}@${quiescence.pendingPolicyRevision} op ${quiescence.mutationOpId} rev ${quiescence.governStageRevision}); drain again under the current stage (SPEC 13.6)`);
  const head: Record<string, unknown> = { ...cur.head };
  head.enforcedPolicyKey = sel.pendingPolicyKey;
  head.enforcedPolicyRevision = sel.pendingPolicyRevision;
  delete head.pendingPolicyKey;
  delete head.pendingPolicyRevision;
  delete head.pendingMutationOpId;
  await updateRecordEntry(recordsKv, govKey, head, cur.revision);
  QUIESCENCE.delete(quiescence); // consume: a witness authorizes exactly ONE promote
  return { enforcedPolicyKey: sel.pendingPolicyKey!, enforcedPolicyRevision: sel.pendingPolicyRevision! };
}

// ---- the currency reads (the §13.8 create-fence and recheck) ----------------------------------

interface CurrencyPins {
  mappingRevision?: number;
  policyRevision?: number;
}

/** The policy currency read (§13.6): leader-read the govern head, REFUSE while a pending
 *  policy is staged (the drain-window pause), follow `enforcedPolicyKey`, self-certify it, and
 *  RE-PROVE it is still at `enforcedPolicyRevision`. Public as {@link readEnforcedPolicy}. */
async function readPolicyCurrency(med: MediatorInternals): Promise<{ policy: unknown; revision: number; key: string }> {
  const govKey = recordAtomicKey(GOVERN_HEAD, [med.endpoint]);
  const read = await readRecordLeader(med.jsm, med.space, govKey);
  if (read === undefined || !isRec(read.value))
    throw new EpEnvelopeError("failed-precondition", `endpoint "${med.endpoint}" has no govern head; no admission policy was ever enforced (SPEC 13.6)`);
  const sel = parseSelector(read.value, govKey);
  if (sel.pendingPolicyKey !== undefined)
    throw new EpEnvelopeError("failed-precondition", `endpoint "${med.endpoint}" stages a pending policy (${sel.pendingPolicyKey}); proof issuance for policy-admitted decisions PAUSES inside the drain window (SPEC 13.6)`);
  if (sel.enforcedPolicyKey === undefined)
    throw new EpEnvelopeError("failed-precondition", `endpoint "${med.endpoint}" enforces no admission policy; a policy-admitted decision has nothing to pin (SPEC 13.6)`);
  const version = await readPolicyVersionCertified(med.jsm, med.space, med.endpoint, sel.enforcedPolicyKey);
  if (version.revision !== sel.enforcedPolicyRevision)
    throw new EpEnvelopeError("failed-precondition", `the enforced policy ${sel.enforcedPolicyKey} reads at revision ${version.revision}, not the selector's ${sel.enforcedPolicyRevision}; an immutable version never moves (corruption); admission pauses rather than guessing (SPEC 13.6)`);
  return { policy: version.value, revision: version.revision, key: sel.enforcedPolicyKey };
}

/** The confined policy read for a canonicalizer's capacity decision (§13.6/§13.8): the sealed
 *  mediator IS the identity bind (it reads only its own endpoint's policy). Returns
 *  `{ policy, revision }`; revision is what an admission pins. */
export async function readEnforcedPolicy(med: AdmissionMediator): Promise<{ policy: unknown; revision: number; key: string }> {
  return readPolicyCurrency(internals(med));
}

/** The target currency read (§13.1/§13.8): leader-served head, `active` at the PRESENTED uid
 *  only (a retiring or retired target admits nothing). */
async function readTargetCurrency(
  med: MediatorInternals,
  target: { owner: string; actor: string; lifecycleUid: string },
): Promise<{ mappingRevision: number }> {
  const head = await readLifecycleMappingLeader(med.reader, target.owner, target.actor);
  if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== target.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `admission target "${target.owner}/${target.actor}" is ${head === undefined ? "unknown" : `${head.mapping.state} at uid ${head.mapping.lifecycleUid}`}, not ACTIVE at uid ${target.lifecycleUid}; a non-current target admits nothing (SPEC 13.8)`);
  return { mappingRevision: head.revision };
}

async function readPins(med: MediatorInternals, op: AdmissionOp): Promise<CurrencyPins> {
  if (op.target === undefined && op.policy !== true)
    throw new EpEnvelopeError("failed-precondition", "an admission pins at least one currency coordinate: a target lifecycle or the enforced policy (SPEC 13.8)");
  const pins: CurrencyPins = {};
  if (op.target !== undefined) pins.mappingRevision = (await readTargetCurrency(med, op.target)).mappingRevision;
  if (op.policy === true) pins.policyRevision = (await readPolicyCurrency(med)).revision;
  return pins;
}

/** The post-create RECHECK (§13.8 step 2): the SAME coordinates, and the row's own pins must
 *  still be current. Movement between the create and here leaves the row as inert debt. */
async function recheckPins(med: MediatorInternals, op: AdmissionOp, row: ObligationRow): Promise<void> {
  if (row.mappingRevision !== undefined) {
    if (op.target === undefined)
      throw new EpEnvelopeError("failed-precondition", "the winning obligation is target-bound but this join presents no target; the full pinned identity must match (SPEC 13.8)");
    const cur = await readTargetCurrency(med, op.target);
    if (cur.mappingRevision !== row.mappingRevision)
      throw new EpEnvelopeError("failed-precondition", `the target head moved (revision ${cur.mappingRevision} vs pinned ${row.mappingRevision}); the proof can never issue and the obligation is inert debt for the drain (SPEC 13.8)`);
  }
  if (row.policyRevision !== undefined) {
    const cur = await readPolicyCurrency(med);
    if (cur.revision !== row.policyRevision)
      throw new EpEnvelopeError("failed-precondition", `the enforced policy moved (revision ${cur.revision} vs pinned ${row.policyRevision}); the proof can never issue and the obligation is inert debt for the drain (SPEC 13.8)`);
  }
}

// ---- the admission proof (§13.8: opaque, branded, bounded-lived, identity-bound) --------------

/** The opaque admission proof (§13.8): BRANDED, bounded-lived, bound to
 *  `{ space, endpoint, obligation key, opId }`. Possession grants nothing to a caller that
 *  cannot present it to ITS OWN endpoint's mediator before expiry; the durable obligation is
 *  the authority, never the proof. */
export interface AdmissionProof {
  readonly space: string;
  readonly endpoint: string;
  readonly obligationKey: string;
  readonly opId: string;
  readonly exp: number;
}
const PROOFS = new WeakSet<AdmissionProof>();

function mintProof(med: MediatorInternals, key: string, opId: string): AdmissionProof {
  const proof: AdmissionProof = Object.freeze({ space: med.space, endpoint: med.endpoint, obligationKey: key, opId, exp: med.now() + med.proofTtlMs });
  PROOFS.add(proof);
  return proof;
}

/** The STRUCTURAL proof check: branded, unexpired, same space/endpoint/key (§13.8: endpoint A
 *  can never replay endpoint B's proof). This is the fast pre-check; the AUTHORITATIVE gate that
 *  admission requires is {@link verifyAdmissionProof}, which ALSO re-reads the CURRENT obligation
 *  state (§13.8: a drained or settled row leaves a locally-valid-looking proof inert). */
export function assertAdmissionProof(med: AdmissionMediator, proof: AdmissionProof, obligationKey: string): void {
  const i = internals(med);
  if (!PROOFS.has(proof))
    throw new EpEnvelopeError("permission-denied", "the presented admission proof was not issued by a mediator; a hand-assembled proof never authorizes (SPEC 13.8/13.12)");
  if (proof.space !== i.space || proof.endpoint !== i.endpoint)
    throw new EpEnvelopeError("permission-denied", `the admission proof binds ${proof.space}/${proof.endpoint}, not ${i.space}/${i.endpoint}; a proof never crosses endpoints (SPEC 13.8)`);
  if (proof.obligationKey !== obligationKey)
    throw new EpEnvelopeError("permission-denied", `the admission proof binds ${proof.obligationKey}, not ${obligationKey} (SPEC 13.8)`);
  if (i.now() >= proof.exp)
    throw new EpEnvelopeError("deadline-exceeded", `the admission proof for ${obligationKey} expired; re-obtain through the mediator (the CURRENT obligation state is re-checked, SPEC 13.8)`);
}

/** The COMPLETE proof gate (§13.8: "checked against the CURRENT obligation state"): the
 *  structural check PLUS a leader-read of the row confirming it still exists, carries the
 *  proof's opId, and is NOT settled (rejected/terminal). A proof whose row a drain settled after
 *  issuance is refused here even though its brand/bind/expiry still look valid, so admission is
 *  proof-gated on live state, never on stale possession. Every effect the proof authorizes (the
 *  EPF acceptance publish, the self-class accept) gates on THIS, not the structural check alone. */
export async function verifyAdmissionProof(med: AdmissionMediator, proof: AdmissionProof, obligationKey: string): Promise<ObligationRow> {
  const i = internals(med);
  assertAdmissionProof(med, proof, obligationKey);
  const cur = await readObligationLeader(i, obligationKey);
  if (cur === undefined)
    throw new EpEnvelopeError("failed-precondition", `the obligation ${obligationKey} no longer exists; a proof never authorizes over a vanished row (SPEC 13.8)`);
  if (cur.row.opId !== proof.opId)
    throw new EpEnvelopeError("permission-denied", `the obligation ${obligationKey} is held by operation ${cur.row.opId}, not the proof's ${proof.opId}; a superseded operation's proof never admits (SPEC 13.8)`);
  if (cur.row.state === "rejected" || cur.row.state === "terminal")
    throw new EpEnvelopeError("failed-precondition", `the obligation ${obligationKey} is ${cur.row.state}; its proof is stale (a drain or a foreign settle resolved it) and never admits (SPEC 13.8)`);
  return cur.row;
}

// ---- obtain (§13.8 step 1 + 2: create-fence, join, recheck, proof) ----------------------------

/** What an obtain returns: the durable obligation coordinates plus the bounded proof. `joined`
 *  reports whether this call created the row or joined an existing winner. */
export interface ObtainedObligation {
  key: string;
  row: ObligationRow;
  revision: number;
  proof: AdmissionProof;
  joined: boolean;
}

async function obtainObligation(
  med: MediatorInternals,
  request: MediatedRequest,
  op: AdmissionOp,
  build: (pins: CurrencyPins, opId: string) => ObligationRow,
  join: (winner: ObligationRow) => void,
): Promise<ObtainedObligation> {
  assertMediatedRequest(med, request); // the caller identity is broker-authenticated, not a body field
  assertIdToken(op.id, "id");
  const key = obligationKey(med, request, op);
  // Step 1: the create-fence currency reads, IMMEDIATELY before the create.
  const pins = await readPins(med, op);
  const opId = mintLifecycleUid();
  const fresh = build(pins, opId);
  let row: ObligationRow;
  let revision: number;
  let joined = false;
  try {
    revision = await createRecordEntry(med.recordsKv, key, fresh);
    row = fresh;
  } catch (e) {
    if (!isCasLoss(e)) throw e;
    // A create loser leader-reads the winner and joins ONLY on the full pinned identity.
    const winner = await readObligationLeader(med, key);
    if (winner === undefined)
      throw new EpEnvelopeError("failed-precondition", `the obligation ${key} lost its create but has no readable winner (a deletion marker or torn state); rows are never deleted (corruption, SPEC 13.12)`);
    if (winner.row.decision !== fresh.decision)
      throw new EpEnvelopeError("conflict", `the obligation ${key} is held by a ${winner.row.decision}-class winner; the full pinned identity must match to join (SPEC 13.8)`);
    join(winner.row);
    if (winner.row.state === "rejected" || winner.row.state === "terminal")
      throw new EpEnvelopeError("failed-precondition", `the obligation ${key} is already ${winner.row.state}; a settled acceptance identity never re-admits (SPEC 13.8)`);
    row = winner.row;
    revision = winner.revision;
    joined = true;
  }
  // Step 2: proof issuance is a post-create currency recheck. Movement settles our OWN
  // provisional through its decision coordinate and refuses.
  try {
    await recheckPins(med, op, row);
  } catch (e) {
    if (row.state === "provisional") {
      try {
        await settleObligation(med, key, row, revision, "the post-create recheck found the pinned coordinate moved");
      } catch {
        /* the drain settles it; the refusal below is the authoritative outcome */
      }
    }
    throw e;
  }
  return { key, row, revision, proof: mintProof(med, key, row.opId), joined };
}

/** Obtain an EPF-class obligation (a canonical acceptance's reservation, §13.8). The class is
 *  fixed HERE, by the trusted operation kind. */
export async function obtainEpfObligation(
  med: AdmissionMediator,
  request: MediatedRequest,
  args: AdmissionOp & { fingerprint: string; sourceSeq: number; route: string },
): Promise<ObtainedObligation> {
  const i = internals(med);
  // The fingerprint and sourceSeq must satisfy CORE's own fact validators up front (§13.4): the
  // mediator settles an unresolved row by publishing a terminal RejectionFact carrying exactly
  // these, and `parseDecisionFact` requires a `sha256:<hex>` fingerprint and a positive sourceSeq
  // — a row that could not settle through a core-conformant fact is refused before it exists.
  if (typeof args.fingerprint !== "string" || !FINGERPRINT_RE.test(args.fingerprint) || !uint(args.sourceSeq) || args.sourceSeq < 1 || typeof args.route !== "string" || !ROUTE_RE.test(args.route))
    throw new EpEnvelopeError("failed-precondition", "an epf-class obtain requires { fingerprint (sha256:<hex>), sourceSeq (>=1), route (effects | pool.<pool>) } (SPEC 13.4/13.8)");
  if (args.route.startsWith("pool.")) assertPoolToken(args.route.slice("pool.".length));
  return obtainObligation(
    i,
    request,
    args,
    (pins, opId) => ({ state: "provisional", decision: "epf", opId, ...pins, fingerprint: args.fingerprint, sourceSeq: args.sourceSeq, route: args.route }),
    (winner) => {
      // The join identity: coordinate (the key) + fingerprint + route. sourceSeq is the
      // winner's own (whichever delivery is processing publishes with the WINNER's, §13.8).
      if (winner.fingerprint !== args.fingerprint || winner.route !== args.route)
        throw new EpEnvelopeError("conflict", `the obligation winner pins fingerprint ${winner.fingerprint}/route ${winner.route}, not ${args.fingerprint}/${args.route}; a mismatched join is a conflict, never a second obligation (SPEC 13.8)`);
    },
  );
}

/** Obtain a SELF-class obligation (a guarded record commit's reservation, e.g. the
 *  restart-status CAS, §13.6/§13.8). The COMPLETE commit intent is pinned at obtain. */
export async function obtainSelfObligation(
  med: AdmissionMediator,
  request: MediatedRequest,
  args: AdmissionOp & { commit: SelfCommitIntent },
): Promise<ObtainedObligation> {
  const i = internals(med);
  const cm = args.commit;
  if (!isRec(cm) || typeof cm.commitKey !== "string" || cm.commitKey.length === 0 || !uint(cm.commitBaseRevision) || typeof cm.commitDigest !== "string" || !DIGEST_SCALAR_RE.test(cm.commitDigest))
    throw new EpEnvelopeError("failed-precondition", "a self-class obtain requires the complete commit intent { commitKey, commitBaseRevision, commitValue, commitDigest (sha256:<hex>) } (SPEC 13.8)");
  parseCommitValue(cm.commitValue, "<obtain>");
  // RESOLVE + verify the commit value canonically digests to commitDigest BEFORE the row can be
  // created/accepted (§13.8: deterministic finishability). A mismatched value/digest, a
  // non-canonical b64u, or a mutable/absent ref is refused here, never reaching `accepted` where
  // recovery would wedge every drain forever.
  await resolveCommitValue(i, { commitKey: cm.commitKey, commitBaseRevision: cm.commitBaseRevision, commitValue: cm.commitValue, commitDigest: cm.commitDigest });
  return obtainObligation(
    i,
    request,
    args,
    (pins, opId) => ({ state: "provisional", decision: "self", opId, ...pins, commit: { commitKey: cm.commitKey, commitBaseRevision: cm.commitBaseRevision, commitValue: cm.commitValue, commitDigest: cm.commitDigest } }),
    (winner) => {
      // The join identity: the ENTIRE commit intent (key + base revision + digest), so two
      // different desired values or base revisions never join under one commitKey (§13.8).
      const w = winner.commit!;
      if (w.commitKey !== cm.commitKey || w.commitBaseRevision !== cm.commitBaseRevision || w.commitDigest !== cm.commitDigest)
        throw new EpEnvelopeError("conflict", `the obligation winner pins commit ${w.commitKey}@${w.commitBaseRevision} digest ${w.commitDigest.slice(0, 12)}…, not ${cm.commitKey}@${cm.commitBaseRevision} digest ${cm.commitDigest.slice(0, 12)}…; a mismatched join is a conflict (SPEC 13.8)`);
    },
  );
}

// ---- the per-class decision coordinates (§13.8 step 3) ----------------------------------------

function epfDecisionSubjectFor(med: MediatorInternals, key: string): string {
  // The obligation key IS the acceptance identity: oblig.<target>.<endpoint>.<cO>.<cA>.<cUid>.<id>
  // (toks: [oblig, target, endpoint, cOwner, cActor, cUid, id]) — the caller triple + id start
  // at index 3, AFTER the endpoint at index 2.
  const toks = key.split(".");
  const [cOwner, cActor, cUid, id] = toks.slice(3);
  return epfSubject(med.space, med.endpoint, ["dec", cOwner, cActor, cUid, id]);
}

/** Settle ONE unresolved (provisional) obligation through its class's decision coordinate
 *  (§13.8): an `epf` row reads the decision subject — an existing acceptance advances the row
 *  (the writer crashed between the decision CAS and the row advance), otherwise the mediator
 *  publishes the create-only TERMINAL REJECTION (its §13.9 grant; a delayed acceptance CAS
 *  loses) and rejects the row; a `self` row settles on ITSELF (`provisional → rejected`,
 *  contending with the writer's own `provisional → accepted` on the one row). */
async function settleObligation(
  med: MediatorInternals,
  key: string,
  row: ObligationRow,
  revision: number,
  why: string,
): Promise<"accepted" | "rejected"> {
  if (row.state !== "provisional")
    throw new EpEnvelopeError("failed-precondition", `the obligation ${key} is ${row.state}, not provisional; only an unresolved row settles here (SPEC 13.8)`);
  if (row.decision === "self") {
    try {
      await updateRecordEntry(med.recordsKv, key, { ...row, state: "rejected" }, revision);
      return "rejected";
    } catch (e) {
      if (!isCasLoss(e)) throw e;
      // Exactly one of { writer's accept, our reject } wins the one-row CAS. Re-read and report.
      const after = await readObligationLeader(med, key);
      if (after === undefined) throw new EpEnvelopeError("internal", `the obligation ${key} vanished mid-settle; rows are never deleted (corruption, SPEC 13.12)`);
      if (after.row.state === "accepted") return "accepted";
      if (after.row.state === "rejected" || after.row.state === "terminal") return "rejected";
      throw new EpEnvelopeError("conflict", `the obligation ${key} moved during its settle (still ${after.row.state}); re-read and re-decide (SPEC 13.8)`);
    }
  }
  // epf: the EPF decision subject is the coordinate.
  const subject = epfDecisionSubjectFor(med, key);
  const stream = epfStreamName(med.space);
  const existing = await readLastFact(med.jsm, stream, subject);
  if (existing !== undefined) {
    const fact = parseDecisionFact(existing, subject);
    assertDecisionMatchesRow(fact, row, key); // the fact on this coordinate must be THIS obligation's identity
    const to = fact.decision === "accepted" ? "accepted" : "rejected";
    await advanceRowSettled(med, key, row, revision, to);
    return to;
  }
  const toks = key.split(".");
  const [cOwner, cActor, cUid, id] = toks.slice(3); // [oblig, target, endpoint, cOwner, cActor, cUid, id]
  // The detail is BOUNDED to the §13.4 error-detail limit, which counts UTF-8 BYTES (what
  // `parseDecisionFact` enforces), not UTF-16 code units — a multibyte `why` truncated by
  // `.slice` could still exceed the byte limit and make core refuse the mediator's own fact.
  const detail = truncateUtf8(`settled by the admission mediator: ${why}`, MAX_ERROR_DETAIL);
  const rejection: RejectionFact = {
    v: 1, id, decision: "rejected", fingerprint: row.fingerprint!,
    error: { code: "failed-precondition", detail },
    caller: { id: `${cOwner}.${cActor}`, lifecycleUid: cUid },
    sourceSeq: row.sourceSeq!, ts: med.now(),
  };
  const published = await publishFactCreateOnly(med.js, subject, enc.encode(JSON.stringify(rejection)));
  if (!published.won) {
    // A decision landed between our read and our publish: the loser reads the winner (§13.4).
    const winner = await readLastFact(med.jsm, stream, subject);
    if (winner === undefined) throw new EpEnvelopeError("internal", `the decision subject ${subject} rejected our create but reads empty; fail closed (SPEC 13.4)`);
    const fact = parseDecisionFact(winner, subject);
    assertDecisionMatchesRow(fact, row, key);
    const to = fact.decision === "accepted" ? "accepted" : "rejected";
    await advanceRowSettled(med, key, row, revision, to);
    return to;
  }
  await advanceRowSettled(med, key, row, revision, "rejected");
  return "rejected";
}

/** A decision fact found on an obligation's coordinate MUST be THIS obligation's acceptance
 *  identity (§13.4/§13.8): the caller-scoped subject can only bear one first-wins decision, so a
 *  fact whose fingerprint (or, for an acceptance, route) differs from the row is a foreign
 *  identity on the same coordinate — never allowed to silently advance this row. Fail loud. */
function assertDecisionMatchesRow(fact: DecisionFact, row: ObligationRow, key: string): void {
  if (fact.fingerprint !== row.fingerprint)
    throw new EpEnvelopeError("internal", `the decision fact on ${key}'s coordinate pins fingerprint ${fact.fingerprint}, not this obligation's ${row.fingerprint}; a foreign acceptance identity never settles this obligation (SPEC 13.4/13.8)`);
  if (fact.sourceSeq !== row.sourceSeq)
    throw new EpEnvelopeError("internal", `the decision fact on ${key}'s coordinate pins sourceSeq ${fact.sourceSeq}, not this obligation's ${row.sourceSeq}; the winner's full acceptance identity (fingerprint + sourceSeq + route) must match (SPEC 13.4/13.8)`);
  if (fact.decision === "accepted" && fact.route !== row.route)
    throw new EpEnvelopeError("internal", `the acceptance fact on ${key}'s coordinate pins route ${fact.route}, not this obligation's ${row.route} (SPEC 13.4/13.8)`);
}

async function advanceRowSettled(med: MediatorInternals, key: string, row: ObligationRow, revision: number, to: "accepted" | "rejected"): Promise<void> {
  try {
    await updateRecordEntry(med.recordsKv, key, { ...row, state: to }, revision);
  } catch (e) {
    if (!isCasLoss(e)) throw e;
    const after = await readObligationLeader(med, key);
    if (after === undefined) throw new EpEnvelopeError("internal", `the obligation ${key} vanished mid-advance (corruption, SPEC 13.12)`);
    if (after.row.state !== to && !(to === "rejected" && after.row.state === "terminal"))
      throw new EpEnvelopeError("conflict", `the obligation ${key} advanced to ${after.row.state} while settling to ${to}; re-read and re-decide (SPEC 13.8)`);
  }
}

/** Public settle of one unresolved obligation (the drains call it; the recheck refusals call
 *  it internally). Leader-reads the current row first. */
export async function settleEpfOrSelfObligation(
  med: AdmissionMediator,
  obligationKey: string,
  why: string,
): Promise<"accepted" | "rejected" | "already-settled"> {
  const i = internals(med);
  assertObligationOfEndpoint(i, obligationKey);
  const cur = await readObligationLeader(i, obligationKey);
  if (cur === undefined)
    throw new EpEnvelopeError("not-found", `no obligation exists at ${obligationKey} (SPEC 13.8)`);
  if (cur.row.state !== "provisional") return "already-settled";
  return settleObligation(i, obligationKey, cur.row, cur.revision, why);
}

function assertObligationOfEndpoint(med: MediatorInternals, key: string): void {
  const toks = key.split(".");
  if (toks[0] !== "oblig" || toks.length !== 7 || toks[2] !== med.endpoint)
    throw new EpEnvelopeError("permission-denied", `the obligation ${key} does not belong to endpoint "${med.endpoint}"; a mediator settles only its own endpoint's rows (SPEC 13.9)`);
}

// ---- the self-class writer protocol (accept → guarded commit → terminal) ----------------------

/** Advance a `self`-class obligation `provisional → accepted` under an unexpired proof
 *  (§13.8 step 3: the guarded commit is authorized only while the row is `accepted`). */
export async function acceptSelfObligation(med: AdmissionMediator, proof: AdmissionProof): Promise<{ revision: number }> {
  const i = internals(med);
  // The state-aware proof gate (§13.8): re-reads the CURRENT row (opId + not-settled), so a
  // drain that settled the row after the proof issued refuses the accept here.
  const row = await verifyAdmissionProof(med, proof, proof.obligationKey);
  if (row.decision !== "self")
    throw new EpEnvelopeError("failed-precondition", `the obligation ${proof.obligationKey} is epf-class; only a self-class row advances on itself (SPEC 13.8)`);
  const cur = await readObligationLeader(i, proof.obligationKey);
  if (cur === undefined)
    throw new EpEnvelopeError("not-found", `no obligation exists at ${proof.obligationKey} (SPEC 13.8)`);
  if (cur.row.state === "accepted") return { revision: cur.revision }; // the writer's own resume
  if (cur.row.state !== "provisional")
    throw new EpEnvelopeError("failed-precondition", `the obligation ${proof.obligationKey} is ${cur.row.state}; a settled row never re-accepts (the drain won the one-row CAS, SPEC 13.8)`);
  try {
    const revision = await updateRecordEntry(i.recordsKv, proof.obligationKey, { ...cur.row, state: "accepted" }, cur.revision);
    return { revision };
  } catch (e) {
    if (!isCasLoss(e)) throw e;
    throw new EpEnvelopeError("permission-denied", `the obligation ${proof.obligationKey} moved during the accept (a drain's rejection contends on the one row and exactly one wins); the delayed commit's authority is gone (SPEC 13.8)`);
  }
}

/** The injected commit applier for {@link recoverSelfObligation}: the record write stays with
 *  a principal that holds it (the mediator's own grant is the obligation family, §13.9). */
export type ApplyCommit = (commitKey: string, valueBytes: Uint8Array, baseRevision: number) => Promise<void>;

/** Strictly decode a `b64u` commit value: CANONICAL base64url (a round-trip re-encode must
 *  reproduce the input exactly, rejecting non-zero pad bits that Node's decoder tolerates) and
 *  FATAL UTF-8 (no replacement chars), then parse JSON. A strict second implementation refuses
 *  exactly what a lax one would silently accept, so the closed union stays interoperable (§13.8). */
function strictB64uToJson(b64u: string, commitKey: string): { value: unknown; bytes: Uint8Array } {
  if (!/^[A-Za-z0-9_-]*$/.test(b64u))
    throw new EpEnvelopeError("failed-precondition", `the b64u commit value for ${commitKey} is not base64url (RFC 4648 §5, no pad); a non-canonical encoding never resolves (SPEC 13.8)`);
  const bytes = new Uint8Array(Buffer.from(b64u, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== b64u)
    throw new EpEnvelopeError("failed-precondition", `the b64u commit value for ${commitKey} is not canonical base64url (its bytes re-encode differently); a lax decoder would tolerate stray pad bits (SPEC 13.8)`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EpEnvelopeError("failed-precondition", `the b64u commit value for ${commitKey} is not valid UTF-8; a recovery never writes replacement-decoded bytes (SPEC 13.8)`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EpEnvelopeError("failed-precondition", `the b64u commit value for ${commitKey} is not JSON; a recovery never writes non-JSON (SPEC 13.8)`);
  }
  return { value, bytes };
}

/** Resolve a commit intent's value + bytes (§13.8) and VERIFY its canonical digest equals
 *  `commitDigest` — the SINGLE integrity gate used at BOTH obtain (before the row can accept)
 *  and recovery, so a mismatched value/digest never reaches `accepted` to wedge a drain. A
 *  `b64u` value is strictly decoded (canonical base64url + fatal UTF-8); a `ref` MUST name an
 *  IMMUTABLE `policy`-kind key (a mutable ref could move after acceptance and permanently wedge
 *  recovery), leader-read and self-certified. The digest is over the canonical VALUE, so a
 *  non-canonical storage stringify never breaks the comparison (RFC-8785). */
async function resolveCommitValue(med: MediatorInternals, intent: SelfCommitIntent): Promise<{ value: unknown; bytes: Uint8Array }> {
  let value: unknown;
  let bytes: Uint8Array;
  if (intent.commitValue.enc === "b64u") {
    ({ value, bytes } = strictB64uToJson(intent.commitValue.bytes, intent.commitKey));
  } else {
    const refKey = intent.commitValue.key;
    if (!/^policy\.[^.]+\.[0-9a-f]{64}$/.test(refKey))
      throw new EpEnvelopeError("failed-precondition", `the commit-value ref ${refKey} is not an immutable policy.<endpoint>.<digest> key; only an immutable create-only kind may be referenced (a mutable ref could move after acceptance and wedge recovery, SPEC 13.8)`);
    const read = await readRecordLeader(med.jsm, med.space, refKey);
    if (read === undefined)
      throw new EpEnvelopeError("failed-precondition", `the commit-value ref ${refKey} does not exist; a recovery cannot resolve the promised value (SPEC 13.8)`);
    // SELF-CERTIFY the referenced version against ITS OWN key digest (§13.7: every policy
    // reader refuses a key/content mismatch), not only against the caller-pinned commitDigest
    // below — a corrupted row whose content matches the caller's pin but not its key would
    // otherwise launder a non-canonical version through the ref form.
    const keyHex = refKey.split(".").pop()!;
    const valueHex = contractDigest(read.value).slice("sha256:".length);
    if (valueHex !== keyHex)
      throw new EpEnvelopeError("failed-precondition", `the commit-value ref ${refKey} resolves to content whose canonical digest is ${valueHex}, not the key's own digest; a policy version is self-certifying and a mismatch is corruption, refused (SPEC 13.7)`);
    value = read.value;
    bytes = enc.encode(JSON.stringify(read.value));
  }
  if (contractDigest(value) !== intent.commitDigest)
    throw new EpEnvelopeError("failed-precondition", `the resolved commit value does not canonically digest to the pinned commitDigest; the intent is refused before it can accept (SPEC 13.8)`);
  return { value, bytes };
}

/** Drive an `accepted` `self`-class obligation to `terminal` deterministically from its pinned
 *  intent alone (§13.8): landed (digest matches) / re-apply (still at base; via the injected
 *  {@link ApplyCommit}) / superseded (moved past to a foreign value). The writer's own resume
 *  AND the drain reconciler both use this — an accepted commit is never an unrecoverable
 *  orphan. Returns what it found. */
export async function recoverSelfObligation(
  med: AdmissionMediator,
  obligationKey: string,
  deps: { applyCommit: ApplyCommit },
): Promise<"landed" | "re-applied" | "superseded"> {
  return recoverSelfCore(internals(med), obligationKey, deps);
}

async function recoverSelfCore(
  i: MediatorInternals,
  obligationKey: string,
  deps: { applyCommit: ApplyCommit },
): Promise<"landed" | "re-applied" | "superseded"> {
  assertObligationOfEndpoint(i, obligationKey);
  const cur = await readObligationLeader(i, obligationKey);
  if (cur === undefined)
    throw new EpEnvelopeError("not-found", `no obligation exists at ${obligationKey} (SPEC 13.8)`);
  if (cur.row.decision !== "self" || cur.row.state !== "accepted")
    throw new EpEnvelopeError("failed-precondition", `the obligation ${obligationKey} is ${cur.row.decision}/${cur.row.state}; recovery drives ACCEPTED self-class rows only (a provisional settles through the drain, SPEC 13.8)`);
  const intent = cur.row.commit!;
  const record = await readRecordLeader(i.jsm, i.space, intent.commitKey);
  // The terminal CAS is idempotent under concurrency (distsys H3): two recoveries, or a drain
  // reconciler racing the writer's own resume, both drive `accepted → terminal`. On a lost CAS,
  // re-read: already terminal is SUCCESS, still accepted (a foreign advance bumped the revision)
  // retries once at the fresh revision, anything else is a real conflict.
  const terminal = async (): Promise<void> => {
    try {
      await updateRecordEntry(i.recordsKv, obligationKey, { ...cur.row, state: "terminal" }, cur.revision);
    } catch (e) {
      if (!isCasLoss(e)) throw e;
      const after = await readObligationLeader(i, obligationKey);
      if (after === undefined) throw new EpEnvelopeError("internal", `the obligation ${obligationKey} vanished mid-terminalize (corruption, SPEC 13.12)`);
      if (after.row.state === "terminal") return;
      if (after.row.state === "accepted") { await updateRecordEntry(i.recordsKv, obligationKey, { ...after.row, state: "terminal" }, after.revision); return; }
      throw new EpEnvelopeError("conflict", `the obligation ${obligationKey} is ${after.row.state} while terminalizing; re-read and re-decide (SPEC 13.8)`);
    }
  };
  if (record !== undefined && contractDigest(record.value) === intent.commitDigest) {
    await terminal();
    return "landed";
  }
  const atBase = (record === undefined && intent.commitBaseRevision === 0) || (record !== undefined && record.revision === intent.commitBaseRevision);
  if (atBase) {
    const { bytes } = await resolveCommitValue(i, intent);
    await deps.applyCommit(intent.commitKey, bytes, intent.commitBaseRevision);
    await terminal();
    return "re-applied";
  }
  // Moved past the base to a foreign value: the guarded CAS could never land. Terminal as
  // superseded (§13.8) — the intended commit is dead, not pending.
  await terminal();
  return "superseded";
}

// ---- the drains (§13.8: enumerate → settle → re-enumerate → quiescence) -----------------------

/** One enumerated obligation (its key, parsed row, and store revision). */
export interface EnumeratedObligation {
  key: string;
  row: ObligationRow;
  revision: number;
}

/** Enumerate an obligation filter through the SEALED records scanner (§13.9, site 3), turning each
 *  raw entry into a parsed, closed-schema obligation row. Markers and parse failures abort LOUD: a
 *  drain that skipped either would declare quiescence over rows it never read. The scanner holds the
 *  ONLY `CONSUMER.CREATE` on the records stream (fence-free LastPerSubject; the caller — mediator or
 *  §13.1 retirement barrier — holds none, so a compromise can never durable-export the `oblig.`
 *  subtree, nats-server#8274). The barrier enumerates the target-wide `oblig.<targetUid>.>` (its
 *  endpoint discovery + quiescence re-check) through the registry's records scanner; each mediator
 *  enumerates its own endpoint's subtree through the scanner injected at open. INVARIANT: the
 *  `scanner` argument MUST come from one of those brand-asserted seams (`med.recordsScanner`,
 *  `registryRecordsScanner(reg)`), never a hand-passed instance; the brand assert lives at
 *  INJECTION (openAdmissionMediator / openLifecycleRegistry), not here, so a new caller that
 *  hand-passes a scanner bypasses the space bond. */
export async function enumerateObligationRows(
  scanner: RecordsScanner,
  filter: string,
): Promise<EnumeratedObligation[]> {
  const out: EnumeratedObligation[] = [];
  for (const e of await scanner.scanObligations(filter)) {
    if (e.op === "DEL" || e.op === "PURGE")
      throw new EpEnvelopeError("failed-precondition", `the obligation ${e.key} carries a ${e.op} marker; obligation rows are never deleted (corruption, SPEC 13.12)`);
    out.push({ key: e.key, row: parseObligationRow(e.data, e.key), revision: e.seq });
  }
  return out;
}

function enumerateObligations(med: MediatorInternals, filter: string): Promise<EnumeratedObligation[]> {
  return enumerateObligationRows(med.recordsScanner, filter);
}

/** The injected ACCEPTED-EPF route reconciler (§13.8: a drain must complete accept-side
 *  reconciliation — enqueue/goal/effect/terminal — for an accepted EPF row before it declares
 *  quiescence; an accepted decision whose route never materialized would otherwise be lost or
 *  execute PAST the barrier). Idempotent; drives THIS row's route to durable establishment. */
export type ReconcileAcceptedRoute = (row: ObligationRow, key: string) => Promise<void>;

/** What one drain pass acted on. */
export interface DrainResult {
  passes: number;
  settledProvisional: number;
  recoveredSelf: number;
  /** Accepted epf rows whose route reconciliation this drain drove (they do not BLOCK quiescence
   *  — their route facts track them — but their accept-side reconciliation MUST run first). */
  reconciledAcceptedEpf: number;
}

/** Verify an ACCEPTED epf row's route reached its durable postcondition before the drain counts
 *  it quiescent (§13.8 accept-side reconciliation). The drain OWNS the check so a presence-only
 *  reconciler cannot fake it: an `effects` route is established by its own acceptance decision
 *  fact (the row is accepted, so that fact exists); a `pool.<pool>` route is established by the
 *  EXACT §13.6 reconciliation predicate: a VALIDATED terminal `wrk` fact (the item is SETTLED —
 *  EPW is a WorkQueue, so a terminally-acked item is normally ABSENT, and settled work is never
 *  re-enqueued) OR a live EPW entry at the acceptance identity (the enqueue landed and is in
 *  flight). Only BOTH absent is the repairable crash-before-enqueue state: the injected
 *  reconciler repairs it and the drain RE-READS both coordinates; still unestablished fails
 *  closed. */
async function verifyAcceptedEpfRoute(
  med: MediatorInternals,
  key: string,
  row: ObligationRow,
  reconciler: ReconcileAcceptedRoute | undefined,
): Promise<void> {
  const [cOwner, cActor, cUid, id] = key.split(".").slice(3); // [oblig, target, endpoint, cO, cA, cUid, id]
  if (row.route === "effects") {
    const decSubject = epfSubject(med.space, med.endpoint, ["dec", cOwner, cActor, cUid, id]);
    const decRaw = await readLastFact(med.jsm, epfStreamName(med.space), decSubject);
    if (decRaw === undefined)
      throw new EpEnvelopeError("internal", `accepted effects obligation ${key} has no decision fact; accepted rows derive from a durable decision (corruption, SPEC 13.8)`);
    const fact = parseDecisionFact(decRaw, decSubject);
    if (fact.decision !== "accepted")
      throw new EpEnvelopeError("internal", `accepted effects obligation ${key} points at a rejected decision fact; obligation/decision state diverged (corruption, SPEC 13.8)`);
    assertDecisionMatchesRow(fact, row, key);
    const goalId = typeof fact.request.goalId === "string" ? fact.request.goalId : undefined;
    const goalRef = goalId !== undefined
      ? { endpoint: med.endpoint, caller: { owner: cOwner, actor: cActor, uid: cUid }, goalId }
      : undefined;
    const doneSubject = goalRef !== undefined
      ? goalResultSubject(med.space, goalRef)
      : epfEffectSubject(med.space, med.endpoint, { owner: cOwner, actor: cActor, uid: cUid }, id);
    const established = async (): Promise<boolean> => {
      const doneRaw = await readLastFact(med.jsm, epfStreamName(med.space), doneSubject);
      if (doneRaw === undefined) return false;
      if (goalRef !== undefined) {
        const done = parseGoalResultFact(doneRaw, doneSubject, goalRef);
        if (done.fingerprint !== fact.fingerprint)
          throw new EpEnvelopeError("internal", `goal completion ${doneSubject} does not match accepted decision ${decSubject}; a mismatched terminal never proves quiescence (SPEC 13.6/13.9)`);
        return true;
      }
      const done = parseEffectFact(doneRaw, doneSubject);
      if (done.fingerprint !== fact.fingerprint || done.sourceSeq !== fact.sourceSeq)
        throw new EpEnvelopeError("internal", `effect completion ${doneSubject} does not match accepted decision ${decSubject}; a mismatched marker never proves quiescence (SPEC 13.9)`);
      return true;
    };
    if (await established()) return;
    if (reconciler === undefined)
      throw new EpEnvelopeError("failed-precondition", `accepted effects obligation ${key} has no durable completion marker ${doneSubject} and no reconcileAcceptedRoute was given; a drain never declares quiescence over executable accepted effects work (SPEC 13.8/13.9)`);
    await reconciler(row, key);
    if (!(await established()))
      throw new EpEnvelopeError("unavailable", `the reconciler for accepted effects obligation ${key} did not establish durable completion marker ${doneSubject}; effects work is still executable and quiescence fails closed (SPEC 13.8/13.9)`);
    return;
  }
  const pool = row.route!.slice("pool.".length);
  const ref: WorkItemRef = { endpoint: med.endpoint, pool, acceptance: { owner: cOwner, actor: cActor, uid: cUid, id } };
  const wrkSubject = workTerminalSubject(med.space, ref);
  const itemSubject = epwSubject(med.space, med.endpoint, pool, ref.acceptance);
  const established = async (): Promise<boolean> => {
    const wrk = await readLastFact(med.jsm, epfStreamName(med.space), wrkSubject);
    if (wrk !== undefined) {
      parseWorkTerminalFact(wrk, wrkSubject, ref); // a garbled terminal never counts as settled
      return true;
    }
    return (await readLastFact(med.jsm, epwStreamName(med.space), itemSubject)) !== undefined;
  };
  if (await established()) return;
  if (reconciler === undefined)
    throw new EpEnvelopeError("failed-precondition", `accepted pool obligation ${key} has no terminal wrk fact and no live EPW item (its enqueue did not land) and no reconcileAcceptedRoute was given; a drain never declares quiescence over unmaterialized accepted work (SPEC 13.8)`);
  await reconciler(row, key);
  if (!(await established()))
    throw new EpEnvelopeError("unavailable", `the reconciler for accepted pool obligation ${key} established neither a terminal wrk fact nor a live EPW item; the route is still unmaterialized and quiescence fails closed (SPEC 13.8)`);
}

/** Drain the rows a `counts` predicate SELECTS under `filter` to quiescence (§13.8): settle
 *  every counted provisional through its decision coordinate, drive every counted accepted
 *  self-class row to terminal, and run the injected route reconciler for every counted accepted
 *  EPF row; re-enumerate until a pass finds no counted provisional or accepted-self left. A row
 *  the predicate does NOT count is skipped (a policy drain must not settle a target-only row it
 *  does not govern). */
async function drainFilter(
  med: MediatorInternals,
  filter: string,
  why: string,
  counts: (row: ObligationRow) => boolean,
  deps: { applyCommit?: ApplyCommit; reconcileAcceptedRoute?: ReconcileAcceptedRoute } = {},
): Promise<DrainResult> {
  let settledProvisional = 0, recoveredSelf = 0, reconciledAcceptedEpf = 0;
  for (let pass = 1; pass <= 8; pass++) {
    const rows = await enumerateObligations(med, filter);
    let unsettled = 0;
    for (const item of rows) {
      if (!counts(item.row)) continue; // not this drain's concern (e.g. a target-only row in a policy drain)
      if (item.row.state === "provisional") {
        unsettled++;
        assertObligationOfEndpoint(med, item.key);
        await settleObligation(med, item.key, item.row, item.revision, why);
        settledProvisional++;
      } else if (item.row.state === "accepted" && item.row.decision === "self") {
        unsettled++;
        if (deps.applyCommit === undefined)
          throw new EpEnvelopeError("failed-precondition", `the drain found an ACCEPTED self-class obligation ${item.key} but was given no applyCommit; an accepted commit is drivable to terminal and a drain must drive it, never skip it (SPEC 13.8)`);
        await recoverSelfCore(med, item.key, { applyCommit: deps.applyCommit });
        recoveredSelf++;
      } else if (item.row.state === "accepted") {
        // Accepted EPF: the drain VERIFIES the route's durable postcondition BEFORE declaring
        // quiescence (an accepted decision whose enqueue never landed must not be silently
        // declared quiescent). The drain OWNS the check (it reads the route marker itself), so a
        // no-op reconciler cannot fake it — for a pool route a missing EPW item calls the
        // injected reconciler and then RE-READS, failing closed if still unmaterialized.
        await verifyAcceptedEpfRoute(med, item.key, item.row, deps.reconcileAcceptedRoute);
        reconciledAcceptedEpf++;
      }
    }
    // RE-ENUMERATE (§13.8): quiescence is declared only by an enumeration that finds no counted
    // provisional or un-driven accepted-self row — never by having settled a PREVIOUS enumeration.
    if (unsettled === 0) return { passes: pass, settledProvisional, recoveredSelf, reconciledAcceptedEpf };
  }
  throw new EpEnvelopeError("unavailable", `the drain under ${filter} did not reach quiescence in 8 passes; admission traffic is outrunning it; investigate before promoting or retiring (SPEC 13.8)`);
}

/** The POLICY drain (§13.6): settles ONLY the obligations pinned to the OLD enforced policy
 *  revision (the one being replaced), across the endpoint's whole prefix. Target-only rows and
 *  rows pinned to a different revision are NOT this drain's concern (settling them would burn a
 *  target-bound acceptance the policy movement does not govern, and target-only traffic would
 *  block convergence). Run AFTER {@link stagePolicySelector} (new policy-admitted proofs are
 *  paused, so no new old-revision row appears and the drain converges); RE-READS the govern head
 *  after draining to confirm the stage did not move, then mints the exact-revision-bound
 *  quiescence witness {@link promotePolicySelector} consumes. */
export async function drainEndpointPolicy(
  med: AdmissionMediator,
  deps: { applyCommit?: ApplyCommit; reconcileAcceptedRoute?: ReconcileAcceptedRoute } = {},
): Promise<DrainResult & { quiescence: DrainQuiescence }> {
  const i = internals(med);
  const govKey = recordAtomicKey(GOVERN_HEAD, [i.endpoint]);
  const gov = await readGovernHeadRaw(i.jsm, i.space, i.endpoint);
  if (gov === undefined)
    throw new EpEnvelopeError("failed-precondition", `endpoint "${i.endpoint}" has no govern head; the policy drain runs inside a stage → drain → promote mutation (SPEC 13.6)`);
  const sel = parseSelector(gov.head, govKey);
  if (sel.pendingPolicyKey === undefined || typeof gov.head.pendingMutationOpId !== "string")
    throw new EpEnvelopeError("failed-precondition", `endpoint "${i.endpoint}" stages no pending policy; the policy drain runs inside a stage → drain → promote mutation (SPEC 13.6)`);
  if (sel.enforcedPolicyRevision === undefined)
    throw new EpEnvelopeError("failed-precondition", `endpoint "${i.endpoint}" enforces no policy to drain from; a first policy has nothing to migrate (SPEC 13.6)`);
  const retiringRevision = sel.enforcedPolicyRevision;
  const mutationOpId = gov.head.pendingMutationOpId;
  const result = await drainFilter(
    i, `oblig.*.${i.endpoint}.>`,
    `the enforced policy for "${i.endpoint}" is moving (stage → drain → promote)`,
    (row) => row.policyRevision === retiringRevision, // ONLY rows pinned to the OLD enforced revision
    deps,
  );
  // Confirm the stage did not move under us (a concurrent clear/re-stage): the witness binds the
  // EXACT current govern revision + mutation opId; the promote CASes from it.
  const after = await readGovernHeadRaw(i.jsm, i.space, i.endpoint);
  const afterSel = after === undefined ? {} : parseSelector(after.head, govKey);
  if (after === undefined || afterSel.pendingPolicyKey !== sel.pendingPolicyKey || afterSel.pendingPolicyRevision !== sel.pendingPolicyRevision || after.head.pendingMutationOpId !== mutationOpId)
    throw new EpEnvelopeError("conflict", `the pending policy for "${i.endpoint}" moved during its drain (op ${mutationOpId}); re-stage and drain again (SPEC 13.6)`);
  const quiescence: DrainQuiescence = Object.freeze({
    space: i.space, endpoint: i.endpoint, pendingPolicyKey: sel.pendingPolicyKey,
    pendingPolicyRevision: sel.pendingPolicyRevision!, mutationOpId, governStageRevision: after.revision,
  });
  QUIESCENCE.add(quiescence);
  return { ...result, quiescence };
}

/** The RETIREMENT-side drain for THIS endpoint's rows under one target
 *  (`oblig.<targetUid>.<endpoint>.>`): the §13.1 terminal barrier (D13 (5)) runs one per
 *  endpoint found under the target. Both coordinates stay inside this mediator's own grant. */
export async function drainTargetForEndpoint(
  med: AdmissionMediator,
  targetUid: string,
  deps: { applyCommit?: ApplyCommit; reconcileAcceptedRoute?: ReconcileAcceptedRoute } = {},
): Promise<DrainResult> {
  const i = internals(med);
  // A retirement drains EVERY row bound to the target (the prefix is target-scoped and excludes
  // the `ep` sentinel), regardless of policy pin — a retiring target admits nothing new either way.
  return drainFilter(i, `oblig.${assertLifecycleToken(targetUid, "targetUid")}.${i.endpoint}.>`, `the target lifecycle ${targetUid} is retiring`, () => true, deps);
}
