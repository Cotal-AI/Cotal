/**
 * v0.4 journal-contract helpers (SPEC §13.4) — the semantic fingerprint, the decision and
 * quarantine fact shapes with their consuming-boundary validators, and the create-only
 * decision CAS the canonicalizer decides with.
 *
 * The journal is an explicitly UNTRUSTED at-least-once submission log (`epj`) feeding
 * canonical accepted-fact subjects (`epf`) through ONE mediated writer, the canonicalizer.
 * Effects consume only canonical facts, never raw submissions. Submissions append PLAIN —
 * a conformant submitter never sets `Nats-Msg-Id` (native stream-wide dedupe is a
 * cross-caller suppression vector, §13.4 item 1); every transport retry simply appends again,
 * and the caller-scoped decision CAS resolves every copy to one durable decision.
 */
import { headers as natsHeaders } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { token } from "./subjects.js";
import { contractDigest, rawDigest } from "./canonical.js";
import { epfSubject, type EpCaller, type ParsedEpRequest } from "./endpoint-subjects.js";
import { EpEnvelopeError, isEpErrorCode } from "./endpoint-envelope.js";

/** §13.12 stream names for the two journal-side streams. */
export function epjStreamName(space: string): string { return `EPJ_${token(space)}`; }
export function epfStreamName(space: string): string { return `EPF_${token(space)}`; }
/** The canonicalizer's durable (§13.9 consumer-name grammar): `canon_<e>`. */
export function canonDurable(endpoint: string): string { return `canon_${token(endpoint)}`; }

/** Decision facts live on the caller-scoped subject — distinct callers can never squat each
 *  other's ids because the caller triple IS part of the subject (§13.4 item 3). Provenance is
 *  STRUCTURAL, as for {@link deriveReplySubject}: the builder takes the broker-authenticated
 *  PARSED submission and derives endpoint + caller internally — there is no argument through
 *  which a body-supplied `from`/`op.endpoint` could address another caller's rail (the
 *  canonicalizer holds broad `epf.<e>.dec.>` authority; the broker cannot catch a confused
 *  call site, so the API must). */
export function epfDecisionSubject(space: string, request: ParsedEpRequest, id: string): string {
  const c = request.caller;
  return epfSubject(space, request.endpoint, ["dec", c.owner, c.actor, c.uid, id]);
}
/** Quarantine facts key on the source SEQUENCE — a family disjoint from caller-chosen `dec`
 *  ids by construction, so no legal request id can collide with a quarantine key. */
export function epfQuarantineSubject(space: string, endpoint: string, sourceSeq: number): string {
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 1) throw new Error(`sourceSeq ${sourceSeq} is not a positive integer`);
  return epfSubject(space, endpoint, ["quar", String(sourceSeq)]);
}
/** The per-goal first-wins bind (§13.4 item 3): stops a second id naming one goalId BEFORE
 *  acceptance and effect. Structural provenance as {@link epfDecisionSubject}. */
export function epfGoalBindSubject(space: string, request: ParsedEpRequest, goalId: string): string {
  const c = request.caller;
  return epfSubject(space, request.endpoint, ["goal", c.owner, c.actor, c.uid, goalId, "bind"]);
}

/** Default idempotency horizon (§13.4 item 6; space-configurable). The horizon is REALIZED by
 *  decision-fact retention, never by a clock: the create-only CAS returns the recorded decision
 *  for exactly as long as the fact exists. */
export const IDEMPOTENCY_HORIZON_MS_DEFAULT = 24 * 60 * 60 * 1000;

// ---- the semantic fingerprint (§13.4 item 2) -------------------------------------------------

const FINGERPRINT_FIELDS = ["id", "goalId", "class", "args"] as const;

/** Build the §13.4 fingerprint for a PARSEABLE submission: the effect-defining subset it
 *  carries — absent optional fields are OMITTED, never `null`, so two implementations digest
 *  identical bytes; an incomplete envelope fingerprints the subset it has. The caller identity
 *  and authorization mode come from the broker-authenticated SUBJECT, never the body. Throws
 *  when the carried values are not canonicalizable I-JSON (lone surrogate, duplicate names
 *  survive parsing as last-wins so cannot reach here, non-finite number) — that submission has
 *  no interoperable RFC 8785 form, hence NO fingerprint, and takes the quarantine path. */
export function submissionFingerprint(
  raw: unknown,
  subject: ParsedEpRequest,
): { object: Record<string, unknown>; fingerprint: string } {
  const body = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const op = (body.op !== null && typeof body.op === "object" && !Array.isArray(body.op) ? body.op : {}) as Record<string, unknown>;
  const object: Record<string, unknown> = {};
  if (op.endpoint !== undefined) object.endpoint = op.endpoint;
  if (op.command !== undefined) object.command = op.command;
  for (const k of FINGERPRINT_FIELDS) if (body[k] !== undefined) object[k] = body[k];
  if (op.inputDigest !== undefined) object.inputDigest = op.inputDigest;
  if (op.outputDigest !== undefined) object.outputDigest = op.outputDigest;
  if (subject.target) object.authz = subject.target.mode;
  if (body.target !== undefined) object.target = body.target;
  if (body.auth !== undefined) {
    if (typeof body.auth === "string") object.authDigest = rawDigest(body.auth); // throws on a lone surrogate → quarantine
    // Wrong-typed but canonicalizable auth is CARRIED effect-defining content: fingerprint it
    // as carried (distinct from absent auth AND from a real authDigest), never collapse it.
    else object.auth = body.auth;
  }
  object.caller = { id: `${subject.caller.owner}.${subject.caller.actor}`, lifecycleUid: subject.caller.uid };
  return { object, fingerprint: contractDigest(object) }; // contractDigest throws on non-I-JSON → quarantine
}

// ---- fact shapes (§13.4 items 3 and 5) and their consuming-boundary validators ---------------

export interface FactCaller { id: string; lifecycleUid: string }

export interface AcceptanceFact {
  v: 1;
  id: string;
  decision: "accepted";
  fingerprint: string;
  /** The canonical EndpointRequest, args INLINE (bounded by max_payload — preflighted). */
  request: Record<string, unknown>;
  caller: FactCaller;
  target?: { owner: string; actor: string; lifecycleUid: string; mappingRevision?: number };
  contractDigests: { input: string; output: string };
  authzDecision: { revision: number; epoch: number };
  /** The acceptance's SINGLE execution route: effects consumers MUST ack a pool-routed
   *  acceptance without effect, and vice versa — no acceptance executes twice. */
  route: "effects" | `pool.${string}`;
  readinessDeadlineMs?: number;
  workExpiry?: number;
  sourceSeq: number;
  ts: number;
}

export interface RejectionFact {
  v: 1;
  id: string;
  decision: "rejected";
  fingerprint: string;
  error: { code: string; detail?: string };
  caller: FactCaller;
  authzDecision?: { revision: number; epoch: number };
  sourceSeq: number;
  ts: number;
}

export interface QuarantineFact {
  v: 1;
  decision: "quarantined";
  sourceSeq: number;
  /** `sha256:<hex>` over the RAW stored submission bytes — never the poison bytes themselves. */
  submissionDigest: string;
  error: { code: string; detail?: string };
  caller?: FactCaller;
  ts: number;
}

export type DecisionFact = AcceptanceFact | RejectionFact;

function factFail(what: string): never {
  throw new EpEnvelopeError("internal", `fact does not validate: ${what}`);
}
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const wireInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

function checkError(v: unknown, what: string): { code: string; detail?: string } {
  if (!isRec(v) || typeof v.code !== "string" || !isEpErrorCode(v.code)) factFail(`${what}.code`);
  if (v.detail !== undefined && (typeof v.detail !== "string" || Buffer.byteLength(v.detail, "utf8") > 256)) factFail(`${what}.detail exceeds 256 bytes`);
  return v as { code: string; detail?: string };
}
function checkCaller(v: unknown, what: string): FactCaller {
  if (!isRec(v) || typeof v.id !== "string" || typeof v.lifecycleUid !== "string") factFail(what);
  return v as unknown as FactCaller;
}

/** Validate a decision fact at its consuming boundary (§13.3: every plane is runtime-validated;
 *  effects and replay read THE FACT, never the raw submission). */
export function parseDecisionFact(raw: unknown): DecisionFact {
  const o = isRec(raw) ? raw : factFail("not an object");
  if (o.v !== 1) factFail("v");
  if (typeof o.id !== "string" || o.id.length === 0) factFail("id");
  if (!isDigest(o.fingerprint)) factFail("fingerprint");
  if (!wireInt(o.sourceSeq) || !wireInt(o.ts)) factFail("sourceSeq/ts");
  checkCaller(o.caller, "caller");
  if (o.decision === "rejected") {
    checkError(o.error, "error");
    return o as unknown as RejectionFact;
  }
  if (o.decision !== "accepted") factFail(`decision ${JSON.stringify(o.decision)}`);
  if (!isRec(o.request)) factFail("request");
  const cd = o.contractDigests;
  if (!isRec(cd) || !isDigest(cd.input) || !isDigest(cd.output)) factFail("contractDigests");
  const az = o.authzDecision;
  if (!isRec(az) || !wireInt(az.revision) || !wireInt(az.epoch)) factFail("authzDecision");
  if (o.route !== "effects" && !(typeof o.route === "string" && /^pool\.[a-z0-9-]{1,32}$/.test(o.route))) factFail("route");
  if (o.readinessDeadlineMs !== undefined && !wireInt(o.readinessDeadlineMs)) factFail("readinessDeadlineMs");
  if (o.workExpiry !== undefined && !wireInt(o.workExpiry)) factFail("workExpiry");
  if (String(o.route).startsWith("pool.") !== (o.workExpiry !== undefined)) factFail("workExpiry is present iff the route is a pool");
  return o as unknown as AcceptanceFact;
}

export function parseQuarantineFact(raw: unknown): QuarantineFact {
  const o = isRec(raw) ? raw : factFail("not an object");
  if (o.v !== 1 || o.decision !== "quarantined") factFail("v/decision");
  if (!wireInt(o.sourceSeq)) factFail("sourceSeq");
  if (!isDigest(o.submissionDigest)) factFail("submissionDigest");
  checkError(o.error, "error");
  if (o.caller !== undefined) checkCaller(o.caller, "caller");
  if (!wireInt(o.ts)) factFail("ts");
  return o as unknown as QuarantineFact;
}

/** Preflight a fact's SERIALIZED size against the broker's max_payload (§13.4 item 5): an
 *  acceptance that would not fit is rejected `resource-exhausted` BEFORE any decision exists
 *  (the rejection fact always fits by construction — every field bounded or fixed-size). */
export function assertFactFits(fact: DecisionFact | QuarantineFact, maxPayload: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(fact));
  if (bytes.length > maxPayload)
    throw new EpEnvelopeError("resource-exhausted", `the serialized decision fact is ${bytes.length} bytes (max_payload ${maxPayload}); a submission whose acceptance cannot fit is refused loudly, never spilled into storage`);
  return bytes;
}

// ---- the decision CAS (§13.4 item 3: first decision wins atomically) -------------------------

/** Append a submission PLAIN (§13.4 item 1): never a `Nats-Msg-Id`, no dedupe header of any
 *  kind — the guarantee rests on the header rule, not the window. Returns the stream ack. */
export async function appendSubmission(js: JetStreamClient, subject: string, envelope: unknown): Promise<{ seq: number }> {
  const pa = await js.publish(subject, new TextEncoder().encode(JSON.stringify(envelope)));
  return { seq: pa.seq };
}

/** Publish a fact with create-only CAS (expected last sequence ON THE SUBJECT = 0). Returns
 *  `{ won: true, seq }` or `{ won: false }` on a lost CAS — the loser then READS the winning
 *  fact ({@link readLastFact}) instead of deciding again. Any non-CAS failure propagates. */
export async function publishFactCreateOnly(
  js: JetStreamClient,
  subject: string,
  factBytes: Uint8Array,
): Promise<{ won: true; seq: number } | { won: false }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    const pa = await js.publish(subject, factBytes, { headers: h });
    return { won: true, seq: pa.seq };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/wrong last sequence/i.test(msg)) return { won: false };
    throw e;
  }
}

/** Last-by-subject read of a fact (the §13.9 CAS-winner read: subject-confined DIRECT.GET
 *  form). `undefined` when no fact exists on the subject. */
export async function readLastFact(
  jsm: JetStreamManager,
  stream: string,
  subject: string,
): Promise<unknown | undefined> {
  const m = await jsm.direct.getMessage(stream, { last_by_subj: subject });
  if (!m) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(m.data));
  } catch (e) {
    throw new EpEnvelopeError("internal", `fact on ${subject} does not decode as JSON: ${(e as Error).message}`);
  }
}
