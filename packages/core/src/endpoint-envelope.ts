/**
 * v0.4 endpoint control-surface envelope (SPEC §13.3) — the versioned typed shapes riding the
 * §13.2 rails (`EndpointRequest`/`EndpointReply`/`EndpointEvent`), the structured error catalog,
 * W3C Trace Context correlation, and the consuming-boundary validators.
 *
 * Validation is FAIL-LOUD with the exact catalog code the spec assigns to each violation
 * (`unsupported-version`, `bad-request`, `contract-mismatch`, `op-mismatch`, `target-mismatch`,
 * `sender-mismatch`) so a rejecting boundary never invents a classification. Unknown object
 * fields are ignored (§5); the parsers return a picked copy carrying exactly the defined fields,
 * so nothing downstream can quietly grow a dependency on an undeclared one. Contract-schema
 * validation of `args`/`data` is §13.7's job ({@link import("./schema-profile.js")}); the helpers
 * here only map its outcome to the invocation-time code (`bad-request`, distinct from
 * registration-time `contract-invalid`).
 */
import type { ValidateFunction } from "ajv/dist/2020.js";
import { rawDigest, isContractDigest, isWellFormedUnicode } from "./canonical.js";
import { assertCommandToken, assertIdToken, assertLifecycleToken, endpointToken, type ParsedEpRequest } from "./endpoint-subjects.js";
import { SCHEMA_PROFILE } from "./schema-profile.js";
import type { EndpointRef } from "./types.js";
// The error catalog + EpEnvelopeError live in a node-free module so the browser session bundle can
// use them without dragging in schema-profile's load-time digest (node:crypto). Re-exported here so
// every existing `@cotal-ai/core` consumer keeps its import path.
import { EP_ERROR_CODES, EpEnvelopeError, type EpErrorCode, type EpError, type EpErrorDetail, type EpEffectOutcome } from "./endpoint-error.js";
export { EP_ERROR_CODES, EpEnvelopeError, EP_UNBOUND_RESPONDER, respondedButUnbound, EP_UNANSWERED, unansweredRequest, EP_REGISTRY_READ_FAILED, registryReadFailed, EP_BIND_REFUSED, replyRefusedBeforeEffect, bindRefusalMarked, type EpErrorCode, type EpError, type EpErrorDetail, type EpUnboundResponderDetail, type EpUnansweredDetail, type EpRegistryReadFailedDetail, type EpBindRefusedDetail, type EpEffectOutcome } from "./endpoint-error.js";

/** The envelope schema version — independent of the wire `protocolVersion`; starts at its own
 *  v1 inside the v0.4 revision. Other values are rejected (`unsupported-version`). */
export const EP_ENVELOPE_V = 1;

// ---- structured errors (§13.3 error catalog) ------------------------------------------------

const EP_ERROR_SET = new Set<string>(EP_ERROR_CODES);

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
/** Reverse-DNS extension token: three or more DNS-shaped labels (`com.acme.throttled`). */
const EXTENSION_CODE = new RegExp(`^${LABEL}(\\.${LABEL}){2,}$`);

/** True iff `code` is a catalog token or a reverse-DNS extension token within the 64-byte bound. */
export function isEpErrorCode(code: string): boolean {
  if (typeof code !== "string" || Buffer.byteLength(code, "utf8") > 64) return false;
  return EP_ERROR_SET.has(code) || EXTENSION_CODE.test(code);
}

function fail(code: EpErrorCode, message: string): never {
  throw new EpEnvelopeError(code, message);
}

// ---- envelope types (§13.3 field tables) ----------------------------------------------------

/** W3C Trace Context correlation slot, propagated to downstream calls, events, facts, receipts. */
export interface EpCorrelation {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

/** The invocation binding: endpoint + command MUST agree with the subject (`op-mismatch`); the
 *  digests pin the described contract and are REQUIRED on every command except `describe`
 *  (`contract-mismatch` when missing — a payload-free side pins the void schema's digest). */
export interface EpOp {
  endpoint: string;
  command: string;
  inputDigest?: string;
  outputDigest?: string;
}

/** The body target block (§13.3): present exactly for the targeted modes, `owner` pinned to the
 *  subject token; `actor`/`lifecycleUid` are validator-compared against the current mapping. */
export interface EpTargetBlock {
  owner: string;
  actor: string;
  lifecycleUid: string;
  mappingRevision?: number;
}

/** A submission's declared delivery contract (`record` is a state contract, never a request
 *  class; an action command's submissions are `journal`). */
export type EpClass = "ephemeral" | "journal";

/**
 * The BOUND INCARNATION (§13.3): the endpoint incarnation the caller's `describe` resolved
 * against, and the only one it will accept an effect from.
 *
 * It confers nothing and narrows only: a request carrying it reaches exactly the instances the
 * subject already routes it to, and can only make one of them refuse (monotonic attenuation,
 * §13.3). Attribution still comes from the reply SUBJECT — this is the caller's DECLARATION of what
 * it bound, checked by the responder against its own identity, not a claim about who answered.
 *
 * The epoch is carried even on the `inst` rail, which already pins the instance, because the
 * subject grammar has no epoch token: an instance's SUCCESSOR answers an inst-addressed request
 * today, and the caller notices only afterwards.
 */
export interface EpBindBlock {
  instanceId: string;
  epoch: number;
}

export interface EndpointRequest {
  v: typeof EP_ENVELOPE_V;
  id: string;
  op: EpOp;
  class: EpClass;
  /** The verb: `true` = call (reply expected, `deadlineMs` required), `false` = cast. The
   *  subject shape is identical for both; the verb never changes the grammar. */
  replyExpected: boolean;
  /** MUST for a command whose contract declares the action composite (a contract-level rule the
   *  serve machinery enforces with the contract in hand); shape-checked here when present. */
  goalId?: string;
  target?: EpTargetBlock;
  /** The incarnation this caller resolved against; a responder that is not it REFUSES before any
   *  effect (§13.2). Absent on `describe` (the bootstrap that PRODUCES the bind) and on the
   *  scatter rail (which addresses every incarnation by construction). */
  bind?: EpBindBlock;
  /** The input payload: a JSON object, or explicit `null` — a canonical-void side's payload is
   *  absent OR `null` (§13.7), so `null` must survive parsing for the command's own schema
   *  validator to decide (an object-input contract still rejects it there, as `bad-request`). */
  args?: Record<string, unknown> | null;
  from: EndpointRef;
  /** Caller deadline budget, bounded never unbounded: required for calls and for journal-class
   *  submissions (there it is the decision deadline, §13.4). */
  deadlineMs?: number;
  correlation?: EpCorrelation;
  /** Opaque signed authorization-context slot; identity never rides it. Its fingerprint binding
   *  is {@link authDigest} over these bytes exactly as carried. */
  auth?: string;
}

export interface EndpointReply {
  v: typeof EP_ENVELOPE_V;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: EpError;
  /** Opaque signed receipt slot (§13.10). */
  receipt?: string;
}

/** An event (incl. per-goal progress) on the `epe` plane. The publishing instance and epoch are
 *  read from the SUBJECT (§13.2), never from payload fields. */
export interface EndpointEvent {
  v: typeof EP_ENVELOPE_V;
  topic: string;
  ts: number;
  data: unknown;
  correlation?: EpCorrelation;
}

// ---- signed-artifact binding (§13.3/§13.7) --------------------------------------------------

/** `authDigest`: `sha256:<hex>` over the UTF-8 bytes of the `auth` slot EXACTLY as carried. The
 *  slot is already a canonical signed artifact, so it is digested as bytes, never
 *  re-canonicalized; absent from the §13.4 fingerprint iff `auth` is absent. A malformed-UTF-16
 *  slot is refused (`bad-request`): a lone surrogate has no UTF-8 encoding, so its "digest"
 *  would be over a substituted value and two distinct slots could share one fingerprint. */
export function authDigest(auth: string): string {
  if (typeof auth !== "string" || !isWellFormedUnicode(auth))
    throw new EpEnvelopeError("bad-request", "auth slot is not a well-formed Unicode string");
  return rawDigest(auth);
}

// ---- consuming-boundary validators ----------------------------------------------------------

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    fail("bad-request", `${what} is not a JSON object`);
  return v as Record<string, unknown>;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) fail("bad-request", `${what} is not a non-empty string`);
  return v;
}

/** Wire integers are I-JSON interoperable: non-negative safe integers (§13.7). */
function asWireInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    fail("bad-request", `${what} is not a non-negative integer within the I-JSON range`);
  return v;
}

/** Rewrap a grammar validator's plain throw as the catalog code the boundary owes. */
function grammar<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    fail("bad-request", (e as Error).message);
  }
}

/** W3C `traceparent`: version, 32-hex trace-id, 16-hex parent-id, 2-hex flags. Version `00` is
 *  EXACTLY this 55-character form — no extension tail. A higher version may carry additional
 *  printable-ASCII fields after the flags (the W3C forward-compatibility rule), bounded to a
 *  finite profile size so nothing unbounded is retained for propagation. Version `ff` and
 *  all-zero ids are invalid per the spec. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(-[\x21-\x7e]+)?$/;
const MAX_TRACEPARENT_BYTES = 256;
const CORRELATION_BYTE_BOUNDS = { tracestate: 512, baggage: 8192 } as const;

/** Correlation is validated, never trusted opaque (§13.3 "per W3C Trace Context"): these fields
 *  are PROPAGATED downstream (calls, events, facts, receipts), so an unvalidated value becomes
 *  header injection or amplification wherever they are re-emitted. `traceparent` is checked
 *  against the W3C grammar; `tracestate`/`baggage` stay content-opaque but are bounded to the
 *  W3C size limits and refused any control character (no CR/LF crosses the boundary). */
function pickCorrelation(v: unknown): EpCorrelation | undefined {
  if (v === undefined) return undefined;
  const o = asRecord(v, "correlation");
  const out: EpCorrelation = {};
  if (o.traceparent !== undefined) {
    const tp = asString(o.traceparent, "correlation.traceparent");
    if (Buffer.byteLength(tp, "utf8") > MAX_TRACEPARENT_BYTES)
      fail("bad-request", `correlation.traceparent exceeds ${MAX_TRACEPARENT_BYTES} bytes`);
    const m = TRACEPARENT.exec(tp);
    if (!m || m[1] === "ff" || /^0+$/.test(m[2]) || /^0+$/.test(m[3]))
      fail("bad-request", "correlation.traceparent is not a valid W3C Trace Context traceparent");
    if (m[1] === "00" && m[4] !== undefined)
      fail("bad-request", "correlation.traceparent version 00 is exactly 55 characters; it carries no extension fields");
    out.traceparent = tp;
  }
  for (const k of ["tracestate", "baggage"] as const) {
    if (o[k] === undefined) continue;
    const s = asString(o[k], `correlation.${k}`);
    if (Buffer.byteLength(s, "utf8") > CORRELATION_BYTE_BOUNDS[k])
      fail("bad-request", `correlation.${k} exceeds ${CORRELATION_BYTE_BOUNDS[k]} bytes`);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(s)) fail("bad-request", `correlation.${k} carries a control character`);
    out[k] = s;
  }
  return out;
}

/** Validate the version discriminant first: any `v !== 1` is `unsupported-version`, before any
 *  other field is looked at, so version skew never masquerades as a shape error. */
function assertVersion(o: Record<string, unknown>, what: string): void {
  if (o.v !== EP_ENVELOPE_V) fail("unsupported-version", `${what} envelope version ${JSON.stringify(o.v)} is not ${EP_ENVELOPE_V}`);
}

/** Shape-validate an incoming request envelope (the pre-subject half of the consuming boundary;
 *  {@link checkRequestSubjectAgreement} is the other half). Throws {@link EpEnvelopeError} with
 *  the exact catalog code; returns a picked copy with exactly the §13.3 fields. */
export function parseEndpointRequest(raw: unknown): EndpointRequest {
  const o = asRecord(raw, "request");
  assertVersion(o, "request");
  const id = grammar(() => assertIdToken(asString(o.id, "id"), "id"));

  const op = asRecord(o.op, "op");
  const endpoint = asString(op.endpoint, "op.endpoint");
  grammar(() => endpointToken(endpoint));
  const command = grammar(() => assertCommandToken(asString(op.command, "op.command")));
  const digests: Pick<EpOp, "inputDigest" | "outputDigest"> = {};
  for (const k of ["inputDigest", "outputDigest"] as const) {
    const d = op[k];
    if (d === undefined) {
      if (command !== "describe")
        fail("contract-mismatch", `op.${k} is required on every command except describe (a payload-free side pins the void schema digest)`);
      continue;
    }
    if (typeof d !== "string" || !isContractDigest(d)) fail("bad-request", `op.${k} is not a sha256:<hex> digest`);
    digests[k] = d;
  }

  const cls = o.class;
  if (cls !== "ephemeral" && cls !== "journal")
    fail("bad-request", `class ${JSON.stringify(cls)} is not "ephemeral" | "journal" (record is a state contract, never a request class)`);
  if (typeof o.replyExpected !== "boolean") fail("bad-request", "replyExpected is not a boolean");
  const replyExpected = o.replyExpected;
  if (cls === "journal" && replyExpected)
    fail("bad-request", "a journal-class submission sets replyExpected: false; the decision is observed on the caller's decision subtree (SPEC 13.4)");

  let deadlineMs: number | undefined;
  if (o.deadlineMs !== undefined) {
    deadlineMs = asWireInt(o.deadlineMs, "deadlineMs");
    if (deadlineMs === 0) fail("bad-request", "deadlineMs must be a positive budget, never zero");
  } else if (replyExpected || cls === "journal") {
    fail("bad-request", `deadlineMs is required for ${replyExpected ? "a call" : "a journal-class submission (the decision deadline)"}`);
  }

  const goalId = o.goalId === undefined ? undefined : grammar(() => assertIdToken(asString(o.goalId, "goalId"), "goalId"));

  let target: EpTargetBlock | undefined;
  if (o.target !== undefined) {
    const t = asRecord(o.target, "target");
    target = {
      owner: asString(t.owner, "target.owner"),
      actor: asString(t.actor, "target.actor"),
      lifecycleUid: grammar(() => assertLifecycleToken(asString(t.lifecycleUid, "target.lifecycleUid"), "target.lifecycleUid")),
      ...(t.mappingRevision !== undefined ? { mappingRevision: asWireInt(t.mappingRevision, "target.mappingRevision") } : {}),
    };
  }

  let bind: EpBindBlock | undefined;
  if (o.bind !== undefined) {
    // `describe` is what PRODUCES a bind, so it cannot consume one: a bind on describe would have
    // to come from somewhere other than this handle's own resolve, and there is nowhere else. It
    // is refused rather than ignored, like every other field that cannot be honored where it sits.
    if (command === "describe")
      fail("bad-request", "describe carries no bind: it is the discovery bootstrap that produces one, so a bind on it could not have come from this handle's own resolve (SPEC 13.3)");
    const b = asRecord(o.bind, "bind");
    bind = {
      instanceId: grammar(() => assertLifecycleToken(asString(b.instanceId, "bind.instanceId"), "bind.instanceId")),
      epoch: asWireInt(b.epoch, "bind.epoch"),
    };
  }

  // §13.7: explicit `null` is a VALID canonical-void payload and must reach the command's own
  // schema validator, so only non-null args are shape-gated here.
  const args = o.args === undefined || o.args === null ? (o.args as undefined | null) : asRecord(o.args, "args") as Record<string, unknown>;

  const f = asRecord(o.from, "from");
  const from: EndpointRef = {
    id: asString(f.id, "from.id"),
    name: asString(f.name, "from.name"),
    ...(f.role !== undefined ? { role: asString(f.role, "from.role") } : {}),
  };

  const auth = o.auth === undefined ? undefined : asString(o.auth, "auth");
  if (auth !== undefined && !isWellFormedUnicode(auth))
    fail("bad-request", "auth slot is not well-formed Unicode (a lone surrogate has no UTF-8 encoding, so it cannot be digested as carried)");
  const correlation = pickCorrelation(o.correlation);

  return {
    v: EP_ENVELOPE_V, id, op: { endpoint, command, ...digests }, class: cls, replyExpected,
    ...(goalId !== undefined ? { goalId } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(bind !== undefined ? { bind } : {}),
    ...(args !== undefined ? { args } : {}),
    from,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(correlation !== undefined ? { correlation } : {}),
    ...(auth !== undefined ? { auth } : {}),
  };
}

/** The body↔subject agreement half of the consuming boundary (§13.3): `op` MUST agree with the
 *  subject (`op-mismatch`); the body target is ABSENT for `self`/untargeted forms (a supplied
 *  one is `target-mismatch`, never ignored) and REQUIRED with a subject-equal owner (and, in
 *  `handle` mode, subject-equal actor + lifecycleUid) for the targeted forms; `from.id` MUST
 *  equal the subject sender principal (`sender-mismatch`). Currency of `target.actor`/
 *  `target.lifecycleUid` against the live mapping is the handler's fresh-read (`expired`),
 *  deliberately not checkable here. */
export function checkRequestSubjectAgreement(env: EndpointRequest, subject: ParsedEpRequest): void {
  if (env.op.endpoint !== subject.endpoint)
    fail("op-mismatch", `op.endpoint "${env.op.endpoint}" does not agree with the subject endpoint "${subject.endpoint}"`);
  if (env.op.command !== subject.command)
    fail("op-mismatch", `op.command "${env.op.command}" does not agree with the subject command "${subject.command}"`);

  // §13.3: deadlineMs is a MUST for call, SCATTER, and journal submissions. Call and journal
  // are enforced at parse time; scatter is only knowable here, where the route is in hand.
  if (subject.route === "all" && env.deadlineMs === undefined)
    fail("bad-request", "deadlineMs is required on the scatter rail (SPEC 13.3: MUST for call/scatter and journal submissions)");

  if (env.bind !== undefined) {
    // A scatter addresses EVERY live incarnation and its gather is reconciled against the frozen
    // expected set (§13.5). A bind would make every member but one refuse, so the scatter would
    // report the rest as failures of the call rather than as what they are — members that were
    // never meant to be excluded. There is no coherent reading, so it is refused, not ignored.
    if (subject.route === "all")
      fail("bad-request", "a bind on the scatter rail has no coherent reading: the scatter addresses every incarnation and reconciles the gather against the frozen expected set (SPEC 13.5)");
    // The subject is the authorization boundary and the body only ever narrows (§13.2/§13.3). On
    // the inst rail the subject ALREADY names an instance, so a bind naming a different one is a
    // body contradicting the rail it rode in on — the request is incoherent as sent, and the
    // responder must not pick a winner between them.
    if (subject.route === "inst" && env.bind.instanceId !== subject.instanceId)
      fail("bad-request", `bind.instanceId "${env.bind.instanceId}" contradicts the inst-rail subject's instance "${subject.instanceId}"; the subject is the boundary and the body only narrows (SPEC 13.2)`);
  }

  const t = subject.target;
  if (!t || t.mode === "self") {
    if (env.target !== undefined)
      fail("target-mismatch", `a body target on ${t ? `a "self"-mode` : "an untargeted"} request is target-mismatch, never ignored (SPEC 13.3)`);
  } else {
    if (!env.target) fail("target-mismatch", `the "${t.mode}" form requires a body target (SPEC 13.3)`);
    if (env.target.owner !== t.tOwner)
      fail("target-mismatch", `target.owner "${env.target.owner}" does not equal the subject target owner "${t.tOwner}"`);
    if (t.mode === "handle" && (env.target.actor !== t.tActor || env.target.lifecycleUid !== t.tUid))
      fail("target-mismatch", "in handle mode the body target actor and lifecycleUid must equal the subject redemption triple");
  }

  const sender = `${subject.caller.owner}.${subject.caller.actor}`;
  if (env.from.id !== sender)
    fail("sender-mismatch", `from.id "${env.from.id}" does not equal the subject sender principal "${sender}"`);
}

/** The contract-class agreement check (`class-mismatch`): the envelope's declared class MUST
 *  equal the command's contract class. Split out because it needs the contract in hand. */
export function assertClassMatches(env: EndpointRequest, declaredClass: EpClass): void {
  if (env.class !== declaredClass)
    fail("class-mismatch", `class "${env.class}" does not equal the command's contract class "${declaredClass}"`);
}

/** The ACTION-COMPOSITE agreement check: `goalId` is a MUST for a command whose registered
 *  declaration carries the action marker and MUST be absent otherwise. Split out for
 *  the same reason as the class check — it needs the contract in hand.
 *
 *  Both directions are refusals, and neither is a default. A missing `goalId` on an action command
 *  cannot be minted here: the goal id is CLIENT-generated, so a server-side substitute would invent
 *  the very identity the caller uses to correlate its own work. A `goalId` on a non-action command
 *  cannot be dropped: it names a goal the command has no machinery to bind, and accepting it
 *  silently would let a caller believe work is tracked that nothing tracks. */
export function assertActionGoalId(env: EndpointRequest, declaresAction: boolean): void {
  if (declaresAction && env.goalId === undefined)
    fail("bad-request", `command declares the action composite: goalId is REQUIRED (SPEC 13.7) and is client-generated, never minted by the servicer`);
  if (!declaresAction && env.goalId !== undefined)
    fail("bad-request", `goalId ${JSON.stringify(env.goalId)} on a command that does not declare the action composite: there is no goal to bind it to`);
}

function pickError(v: unknown): EpError {
  const e = asRecord(v, "error");
  const code = asString(e.code, "error.code");
  if (!isEpErrorCode(code)) fail("bad-request", `error.code ${JSON.stringify(code)} is neither a catalog token nor a reverse-DNS extension token within 64 bytes`);
  const message = typeof e.message === "string" ? e.message : fail("bad-request", "error.message is not a string");
  let details: EpErrorDetail[] | undefined;
  if (e.details !== undefined) {
    if (!Array.isArray(e.details)) fail("bad-request", "error.details is not an array");
    details = e.details.map((d, i) => {
      const o = asRecord(d, `error.details[${i}]`);
      const kind = asString(o.kind, `error.details[${i}].kind`);
      if (!EXTENSION_CODE.test(kind)) fail("bad-request", `error.details[${i}].kind "${kind}" is not reverse-DNS namespaced`);
      return o as EpErrorDetail;
    });
  }
  // §13.3 Effect outcome, parsed rather than dropped: this rebuilds the error from scratch, so an
  // unnamed field is discarded — and discarding THIS one downgrades a responder's `not-executed`
  // to an omitted outcome, which §13.3 says MUST be read as `unknown`, turning a proof of
  // non-execution into an absence of evidence at the parser. An unrecognised value is refused
  // rather than coerced.
  let outcome: EpEffectOutcome | undefined;
  if (e.outcome !== undefined) {
    if (e.outcome !== "executed" && e.outcome !== "not-executed" && e.outcome !== "unknown")
      fail("bad-request", `error.outcome ${JSON.stringify(e.outcome)} is not one of executed, not-executed, unknown (SPEC 13.3)`);
    outcome = e.outcome;
  }
  return { code, message, ...(details ? { details } : {}), ...(outcome ? { outcome } : {}) };
}

/** Shape-validate a reply at the caller's consuming boundary. `data` is schema-validated by the
 *  caller against its PINNED output digest (§13.7), not here. */
export function parseEndpointReply(raw: unknown): EndpointReply {
  const o = asRecord(raw, "reply");
  assertVersion(o, "reply");
  const id = grammar(() => assertIdToken(asString(o.id, "id"), "id"));
  if (typeof o.ok !== "boolean") fail("bad-request", "ok is not a boolean");
  if (o.ok && o.error !== undefined) fail("bad-request", "an ok reply must not carry an error");
  if (!o.ok && o.data !== undefined) fail("bad-request", "a failed reply must not carry data");
  const error = o.ok ? undefined : pickError(o.error);
  const receipt = o.receipt === undefined ? undefined : asString(o.receipt, "receipt");
  return {
    v: EP_ENVELOPE_V, id, ok: o.ok,
    ...(o.ok && o.data !== undefined ? { data: o.data } : {}),
    ...(error ? { error } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  };
}

/** Shape-validate an event at its consuming boundary (§13.3: every plane is runtime-validated).
 *  The publishing instance and epoch come from the SUBJECT; payload claims are display data. */
export function parseEndpointEvent(raw: unknown): EndpointEvent {
  const o = asRecord(raw, "event");
  assertVersion(o, "event");
  const topic = asString(o.topic, "topic");
  if (Buffer.byteLength(topic, "utf8") > 256) fail("bad-request", "topic exceeds 256 bytes");
  const ts = asWireInt(o.ts, "ts");
  if (!("data" in o)) fail("bad-request", "event carries no data field");
  const correlation = pickCorrelation(o.correlation);
  return { v: EP_ENVELOPE_V, topic, ts, data: o.data, ...(correlation !== undefined ? { correlation } : {}) };
}

// ---- invocation-time contract validation (§13.7, distinct from registration time) -----------

/**
 * Report — never refuse on — an over-budget validation on the REQUEST path.
 *
 * §13.8's validate budget used to throw: `bad-request` for args, `internal` for output. It cannot
 * be measured soundly enough to justify that. Elapsed time counts the whole machine (it refused an
 * 82ms cold-JIT validation of a small, schema-VALID object during a gate run). `process.cpuUsage()`
 * counts every thread in the process, so V8's background optimizing-compiler threads and any
 * sibling Worker land in the number too — measured at 16.4ms of process CPU against 0.18ms on the
 * measuring thread, already over this 10ms ceiling with almost no work done here. Node exposes no
 * per-thread CPU below 22.19 and the package floor is `>=22`, so there is no third instrument.
 *
 * A false refusal HERE answers the CALLER: a manager on a loaded or Worker-using host would tell
 * clients their valid arguments are malformed and silently degrade a live control plane. That is
 * strictly worse than the DoS this was guarding, which needs an attacker able to register a
 * contract. So enforcement stays where the attack actually lives — the REGISTRATION path, where
 * {@link import("./schema-profile.js").compileContract} still refuses `contract-invalid`, a false
 * positive fails a boot loudly rather than lying to a caller.
 *
 * WHAT THIS COMMENT USED TO CLAIM, AND WHY IT WAS WRONG. It said the deterministic profile bounds
 * "do the pre-emptive work", i.e. that registration-time bounds REPLACE request-path enforcement.
 * They do not, and that was disproved by execution rather than argued: a four-node schema —
 * trivially inside every byte, depth, ref-chain, node and closure bound — declaring
 * `uniqueItems: true` over an array of OBJECTS makes validation QUADRATIC IN THE CALLER'S DATA.
 * 3,000 valid objects measured 75ms and 5,000 measured 227ms, from ~54KB of entirely legitimate
 * input. No registration power, no oversized payload, no forgery. The profile bounds the SIZE and
 * SHAPE of a schema and the BACKTRACKING class via `maxPatternChars`; it has nothing for keywords
 * whose cost is non-linear in the VALUE being validated.
 *
 * BE PRECISE ABOUT WHAT THE DEMOTION DID AND DID NOT COST, because the obvious reading is wrong.
 * The gap is real and it PRE-DATES the demotion. The old code was
 *
 *     const okValid = validate(value);          // the whole cost is ALREADY PAID here
 *     const cpu = process.cpuUsage(startedCpu); // measured afterwards
 *     if (cpuMs > budget) fail("bad-request", …)
 *
 * so the refusal fired AFTER validation ran to completion. On a quadratic payload the enforcing
 * build burns exactly the same CPU as this one; it merely answers with an error instead of a
 * result. AGAINST RESOURCE EXHAUSTION, POST-HOC ENFORCEMENT BOUGHT NOTHING — an authorized caller
 * repeating the call cost the host the same before this change as after. What was removed was a
 * post-hoc classification, never a fence.
 *
 * AN INSTRUMENT ONLY GUARDS WHAT HAPPENS AFTER IT. That is the whole rule, and it is why the
 * reply-payload case is genuinely different: THAT throw preceded a downstream publish, so removing
 * it really did let an oversized reply through. Position, not intent, decides whether a check is a
 * fence or a verdict.
 *
 * So the honest statement is that this path has ALWAYS been unbounded for validation cost, and a
 * deterministic PRE-EMPTIVE defence is owed: a bound on argument bytes and items checked BEFORE
 * `validate` runs, refused as `resource-exhausted` (the caller's arguments are not malformed, they
 * are too expensive to admit — see `assertFactFits` in endpoint-journal.ts for the same shape), plus
 * a registration-time refusal of keywords whose cost is non-linear in the value. `max_payload` is
 * NOT that bound: at ~1 MiB it admits thousands of small objects, which is deep into the quadratic.
 *
 * The transferable lesson stands and is worth more than the incident: one unsound timer was standing
 * in for three jobs and was removed having enumerated one. REMOVING A GUARD REQUIRES ENUMERATING
 * WHAT IT WAS HOLDING UP — and then checking, for each, whether the guard actually PRECEDED the
 * thing it appeared to hold up. Two of the three here did not.
 *
 * The number stays, as an approximate observation, because it is still the only signal that a
 * registered contract is costing more than the profile intended. Treat it as a hint to go look at
 * the contract, never as a verdict about this request.
 */
function reportValidateBudget(what: "args" | "output", startedCpu: NodeJS.CpuUsage, startedMs: number): void {
  const cpu = process.cpuUsage(startedCpu);
  const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
  if (cpuMs <= SCHEMA_PROFILE.validateBudgetMs) return;
  console.error(
    `! schema: ${what} validation took ~${cpuMs}ms of process CPU (§13.8 reference budget ${SCHEMA_PROFILE.validateBudgetMs}ms; ` +
    `${Date.now() - startedMs}ms elapsed). Approximate - process-wide CPU includes JIT/Worker threads. ` +
    `Not a refusal - and note that refusing HERE would not have helped: this fires after validate() completed, so the cost is already paid. Validation cost on this path is bounded by nothing pre-emptively; a byte/item bound before validate is owed.`,
  );
}

/** Validate `args` against the command's compiled input schema BEFORE any effect: failure is the
 *  invocation-time `bad-request` (registration-time violations are `contract-invalid`,
 *  {@link import("./schema-profile.js").ContractInvalidError}). Against the void schema the
 *  payload is absent or `null` (§13.7), so `undefined` args validate as `null` here and only
 *  here; an explicit `null` passes through unchanged, and it is the SCHEMA (an object-typed
 *  input contract) that rejects null for non-void commands.
 *
 *  The §13.8 validation budget is REPORTED here, not enforced — see {@link reportValidateBudget}
 *  for why no available instrument can justify refusing a request on it. The only `bad-request`
 *  this raises is the schema's own verdict. Enforcement lives at registration
 *  ({@link import("./schema-profile.js").compileContract}), which is where the COMPILE-time DoS
 *  lives - not the only place a DoS lives, see the note on `reportValidateBudget` - and where
 *  a false positive fails loudly instead of lying to a caller. */
export function assertArgsValid(validate: ValidateFunction, args: Record<string, unknown> | null | undefined): unknown {
  const value = args === undefined ? null : args;
  const startedCpu = process.cpuUsage();
  const started = Date.now();
  const okValid = validate(value);
  reportValidateBudget("args", startedCpu, started);
  if (!okValid) {
    const first = validate.errors?.[0];
    fail("bad-request", `args do not validate against the input schema${first ? `: ${first.instancePath || "/"} ${first.message ?? ""}` : ""}`);
  }
  return value;
}

/** Validate an output payload against the command's compiled output schema at EITHER §13.7
 *  boundary — the responder's, before the success publish, or the caller's, on the consumed
 *  reply — the symmetric half of {@link assertArgsValid}. An invalid output is a responder bug
 *  (§13.3/§13.7) whichever side detects it, so it is structured `internal`, never the caller's
 *  `bad-request`. The §13.8 budget is REPORTED, not enforced, for the same reason as the args side
 *  ({@link reportValidateBudget}). A void output is `undefined`, validated as `null` against the
 *  void schema, mirroring the args side. */
export function assertOutputValid(validate: ValidateFunction, data: unknown): void {
  const value = data === undefined ? null : data;
  const startedCpu = process.cpuUsage();
  const started = Date.now();
  const okValid = validate(value);
  reportValidateBudget("output", startedCpu, started);
  if (!okValid) {
    const first = validate.errors?.[0];
    fail("internal", `output does not validate against the pinned output schema; an invalid reply is a responder bug, never success (SPEC 13.7)${first ? `: ${first.instancePath || "/"} ${first.message ?? ""}` : ""}`);
  }
}
