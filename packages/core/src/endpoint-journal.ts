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
import {
  epfSubject, parseEpSubject, endpointToken, assertBoundedOwner, assertIdToken,
  assertLifecycleToken, type EpCaller, type ParsedEpRequest,
} from "./endpoint-subjects.js";
import { EpEnvelopeError, isEpErrorCode, parseEndpointRequest, type EndpointRequest } from "./endpoint-envelope.js";
import { isCasLoss } from "./endpoint-records.js";

/** §13.12 stream names for the two journal-side streams. */
export function epjStreamName(space: string): string { return `EPJ_${token(space)}`; }
export function epfStreamName(space: string): string { return `EPF_${token(space)}`; }
/** The canonicalizer's durable (§13.9 consumer-name grammar): `canon_<e>`. Uses the fail-loud
 *  {@link endpointToken} (not the lenient `token`) so a malformed endpoint is refused, never
 *  silently sanitized into a colliding durable name. */
export function canonDurable(endpoint: string): string { return `canon_${endpointToken(endpoint)}`; }

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
export function epfGoalBindSubject(space: string, source: { endpoint: string; caller: { owner: string; actor: string; uid: string } }, goalId: string): string {
  const c = source.caller;
  return epfSubject(space, source.endpoint, ["goal", c.owner, c.actor, c.uid, goalId, "bind"]);
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
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

function checkError(v: unknown, what: string): { code: string; detail?: string } {
  if (!isRec(v) || typeof v.code !== "string" || !isEpErrorCode(v.code)) factFail(`${what}.code`);
  if (v.detail !== undefined && (typeof v.detail !== "string" || Buffer.byteLength(v.detail, "utf8") > 256)) factFail(`${what}.detail exceeds 256 bytes`);
  return v as { code: string; detail?: string };
}
function checkCaller(v: unknown, what: string): FactCaller {
  if (!isRec(v) || typeof v.id !== "string" || typeof v.lifecycleUid !== "string") factFail(what);
  const toks = v.id.split(".");
  if (toks.length !== 2) factFail(`${what}.id is not an <owner>.<actor> principal`);
  try {
    assertBoundedOwner(toks[0], `${what} owner`);
    assertBoundedOwner(toks[1], `${what} actor`);
    assertLifecycleToken(v.lifecycleUid, `${what}.lifecycleUid`);
  } catch (e) {
    factFail(`${what}: ${(e as Error).message}`);
  }
  return v as unknown as FactCaller;
}
function checkAuthzDecision(v: unknown, what: string): void {
  if (!isRec(v) || !wireInt(v.revision) || !wireInt(v.epoch)) factFail(what);
}
function checkTarget(v: unknown): void {
  if (!isRec(v) || typeof v.owner !== "string" || typeof v.actor !== "string" || typeof v.lifecycleUid !== "string") factFail("target");
  try {
    assertBoundedOwner(v.owner, "target owner");
    assertBoundedOwner(v.actor, "target actor");
    assertLifecycleToken(v.lifecycleUid, "target lifecycleUid");
  } catch (e) {
    factFail(`target: ${(e as Error).message}`);
  }
  if (v.mappingRevision !== undefined && !wireInt(v.mappingRevision)) factFail("target.mappingRevision");
}
/** The embedded canonical request of an acceptance: it MUST be a fully valid canonical
 *  `EndpointRequest` (§13.3/§13.4), not merely a `{v,id,class,op}` shell — so it is routed
 *  through the SAME {@link parseEndpointRequest} the request boundary uses (its boundary error,
 *  a caller-facing code, maps to `internal` here because a malformed STORED request is a writer
 *  bug, not a caller error). Then it is cross-checked against the fact address so a stored
 *  acceptance can never smuggle a request for a different id/endpoint/caller into effects or
 *  replay: journal class, id, op.endpoint, and the request's own `from.id` must all agree with
 *  the broker-authenticated fact subject. Returns the parsed request for the target cross-check. */
function checkEmbeddedRequest(v: unknown, addr: FactAddress): EndpointRequest {
  let req: EndpointRequest;
  try {
    req = parseEndpointRequest(v);
  } catch (e) {
    return factFail(`request is not a canonical EndpointRequest: ${(e as Error).message}`);
  }
  if (req.class !== "journal") factFail("request.class (only journal-class submissions produce decision facts)");
  if (req.id !== addr.id) factFail("request.id disagrees with the fact address");
  if (req.op.endpoint !== addr.endpoint) factFail("request.op.endpoint disagrees with the fact address");
  if (req.from.id !== addr.caller.id) factFail("request.from.id disagrees with the authenticated fact caller");
  return req;
}

/** The authenticated ADDRESS of a decision fact: the `epf….dec.<cO>.<cA>.<cUid>.<id>` subject
 *  tokens the broker enforced on the mediated writer's publish. */
export interface FactAddress { endpoint: string; caller: FactCaller; id: string }

/** Parse a decision-fact subject into its address — the mandatory seam through which every
 *  consuming boundary proves body↔subject agreement. Throws `internal` on a non-decision
 *  subject (a consumer wired to the wrong subject family is a bug, never a data error). */
export function parseDecisionFactSubject(subject: string): FactAddress {
  const p = parseEpSubject(subject);
  if (!p || p.plane !== "fact" || p.topic.length !== 5 || p.topic[0] !== "dec")
    throw new EpEnvelopeError("internal", `${subject} is not a decision-fact subject`);
  return { endpoint: p.endpoint, caller: { id: `${p.topic[1]}.${p.topic[2]}`, lifecycleUid: p.topic[3] }, id: p.topic[4] };
}

/** Validate a decision fact at its consuming boundary (§13.3: every plane is runtime-validated;
 *  effects and replay read THE FACT, never the raw submission). The fact must be
 *  SELF-SUFFICIENT canonical authority: every field is grammar-validated (caller principal,
 *  positive source sequence/timestamp, digest forms, the embedded canonical request, the
 *  resolved target triple), and the body's id/caller/endpoint must AGREE with the
 *  broker-authenticated fact subject — a mismatch is a writer bug or corrupt store and fails
 *  loud before effects or replay can attribute the decision. */
export function parseDecisionFact(raw: unknown, subject: string): DecisionFact {
  const addr = parseDecisionFactSubject(subject);
  const o = isRec(raw) ? raw : factFail("not an object");
  if (o.v !== 1) factFail("v");
  if (typeof o.id !== "string") factFail("id");
  try {
    assertIdToken(o.id, "fact id");
  } catch {
    factFail("id grammar");
  }
  if (o.id !== addr.id) factFail("id disagrees with the fact subject");
  if (!isDigest(o.fingerprint)) factFail("fingerprint");
  // sourceSeq is a stream sequence (>= 1); ts is a wire timestamp (>= 0, §13.7).
  if (!posInt(o.sourceSeq)) factFail("sourceSeq must be a positive stream sequence");
  if (!wireInt(o.ts)) factFail("ts must be a non-negative integer");
  const caller = checkCaller(o.caller, "caller");
  if (caller.id !== addr.caller.id || caller.lifecycleUid !== addr.caller.lifecycleUid)
    factFail("caller disagrees with the fact subject");
  if (o.decision === "rejected") {
    checkError(o.error, "error");
    if (o.authzDecision !== undefined) checkAuthzDecision(o.authzDecision, "authzDecision");
    return o as unknown as RejectionFact;
  }
  if (o.decision !== "accepted") factFail(`decision ${JSON.stringify(o.decision)}`);
  const req = checkEmbeddedRequest(o.request, addr);
  // The stored acceptance must expose ONE coherent effect authority (§13.4: self-sufficient for
  // effect and replay) — target presence is EQUIVALENT to the request's (§13.3: a body target
  // exists exactly for the targeted modes): a targeted acceptance that dropped its target is not
  // replayable, and an untargeted request with a spurious fact target smuggles authority the
  // caller never asked for.
  if ((req.target !== undefined) !== (o.target !== undefined))
    factFail(req.target !== undefined
      ? "a targeted request's acceptance must persist the resolved target"
      : "an untargeted request's acceptance must not carry a target");
  if (o.target !== undefined && req.target !== undefined) {
    checkTarget(o.target);
    // The fact target must equal the request's FULL tuple. lifecycleUid is the caller's EXPECTED
    // binding, validator-checked against the current mapping (§13.3) — resolution validates it,
    // never replaces it; goals bind (principal, lifecycleUid) (§13.6), so a substituted UID
    // redirects effect/replay to a recycled alias. A caller-pinned mappingRevision pins the
    // exact observed revision; only an OMITTED one may be filled by resolution.
    const ft = o.target as { owner: string; actor: string; lifecycleUid: string; mappingRevision?: number };
    if (req.target.owner !== ft.owner || req.target.actor !== ft.actor || req.target.lifecycleUid !== ft.lifecycleUid)
      factFail("the fact target does not equal the embedded request's target tuple");
    if (req.target.mappingRevision !== undefined && ft.mappingRevision !== req.target.mappingRevision)
      factFail("the fact target does not carry the mappingRevision the request pinned");
  }
  const cd = o.contractDigests;
  if (!isRec(cd) || !isDigest(cd.input) || !isDigest(cd.output)) factFail("contractDigests");
  // Where the request pinned contract digests (§13.3: required on every command except
  // `describe`), the fact's contractDigests must EQUAL them — otherwise consumers validate and
  // effect under a different contract than the caller accepted. An omitted digest (describe)
  // is the only fill: the fact then carries the canonicalizer-resolved digest uncompared.
  if (req.op.inputDigest !== undefined && cd.input !== req.op.inputDigest)
    factFail("contractDigests.input disagrees with the embedded request's pinned op.inputDigest");
  if (req.op.outputDigest !== undefined && cd.output !== req.op.outputDigest)
    factFail("contractDigests.output disagrees with the embedded request's pinned op.outputDigest");
  checkAuthzDecision(o.authzDecision, "authzDecision");
  if (o.route !== "effects" && !(typeof o.route === "string" && /^pool\.[a-z0-9-]{1,32}$/.test(o.route))) factFail("route");
  if (o.readinessDeadlineMs !== undefined && !wireInt(o.readinessDeadlineMs)) factFail("readinessDeadlineMs must be a non-negative integer");
  if (o.workExpiry !== undefined && !posInt(o.workExpiry)) factFail("workExpiry");
  if (String(o.route).startsWith("pool.") !== (o.workExpiry !== undefined)) factFail("workExpiry is present iff the route is a pool");
  return o as unknown as AcceptanceFact;
}

/** Validate a quarantine fact at its consuming boundary; the body's source sequence must agree
 *  with the `epf….quar.<seq>` subject it was stored under. */
export function parseQuarantineFact(raw: unknown, subject: string): QuarantineFact {
  const p = parseEpSubject(subject);
  if (!p || p.plane !== "fact" || p.topic.length !== 2 || p.topic[0] !== "quar")
    throw new EpEnvelopeError("internal", `${subject} is not a quarantine-fact subject`);
  const o = isRec(raw) ? raw : factFail("not an object");
  if (o.v !== 1 || o.decision !== "quarantined") factFail("v/decision");
  if (!posInt(o.sourceSeq)) factFail("sourceSeq must be a positive integer");
  if (String(o.sourceSeq) !== p.topic[1]) factFail("sourceSeq disagrees with the fact subject");
  if (!isDigest(o.submissionDigest)) factFail("submissionDigest");
  checkError(o.error, "error");
  if (o.caller !== undefined) checkCaller(o.caller, "caller");
  if (!wireInt(o.ts)) factFail("ts must be a non-negative integer");
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
    // The SHARED structured classifier (err_code, never message text): a missed classification
    // here would turn a benign concurrent decision into an unhandled throw in the mediated
    // writer — a normal race becoming an error/stall is exactly the failure text-matching risks.
    if (isCasLoss(e)) return { won: false };
    throw e;
  }
}

/** Last-by-subject read of a fact — LEADER-SERVED (`STREAM.MSG.GET`, never `DIRECT.GET`). The
 *  §13.4 loser-reads-winner contract needs read-your-writes against the leader that just
 *  rejected the CAS: a follower-served Direct Get carries no such guarantee and, after legal
 *  post-horizon id reuse, can return a STALE prior fact (semantically a DIFFERENT decision) or
 *  nothing — and no retry can distinguish a stale nonempty fact from the current winner. EPF
 *  keeps `allow_direct=true` for other trusted subject-confined reads (§13.12); the CAS-winner
 *  read is deliberately not one of them. `undefined` when no fact exists on the subject. */
export async function readLastFact(
  jsm: JetStreamManager,
  stream: string,
  subject: string,
): Promise<unknown | undefined> {
  let m;
  try {
    m = await jsm.streams.getMessage(stream, { last_by_subj: subject });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return undefined; // no message found on the subject
    throw e;
  }
  if (!m) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(m.data));
  } catch (e) {
    throw new EpEnvelopeError("internal", `fact on ${subject} does not decode as JSON: ${(e as Error).message}`);
  }
}
