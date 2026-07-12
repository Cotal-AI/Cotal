/**
 * v0.4 caller-side verbs (SPEC §13.5 "Verbs", §13.2 rails, §13.3 envelope) — call, cast, watch,
 * and scatter over the endpoint rails. The verb never changes the subject grammar (§13.2): a
 * call and a cast publish the same request form; the verb rides `replyExpected`, and only the
 * §13.5 gather semantics differ.
 *
 * Boundary discipline mirrors the serve side: args validate against the COMPILED input contract
 * before publish (a caller never emits a request its own contract refuses), the pinned
 * invocation digests are DERIVED from each contract's closure digest, and every consumed reply
 * or event is runtime-validated at this, its consuming boundary (§13.3) — subject-attributed
 * (instance + epoch from the SUBJECT, never the body), id-echoed, and schema-checked under the
 * same fixed §13.8 budget the responder ran. Journal-class work never rides these rails: the
 * verbs pin `class: "ephemeral"`; submissions go through the `epj` journal machinery (§13.4).
 */
import { randomBytes } from "node:crypto";
import type { Msg, NatsConnection, Subscription } from "@nats-io/transport-node";
import { spacePrefix } from "./subjects.js";
import {
  epRequestSubject, parseEpSubject, callerTokens, assertLifecycleToken, assertBoundedOwner,
  type EpCaller, type EpRoute, type EpTarget,
} from "./endpoint-subjects.js";
import {
  EpEnvelopeError, parseEndpointReply, parseEndpointEvent, assertArgsValid, assertOutputValid,
  type EndpointRequest, type EndpointReply, type EndpointEvent, type EpCorrelation, type EpTargetBlock,
} from "./endpoint-envelope.js";
import type { CompiledContract } from "./schema-profile.js";
import type { FrozenInstance } from "./endpoint-service.js";

// ---- shared request construction ---------------------------------------------------------------

/** A verb's target: one input shape that builds BOTH halves of the §13.2/§13.3 targeted form —
 *  the subject's authorization-mode token block and the body target block — so they can never
 *  disagree. `self` carries no body target (the caller triple IS the target, §13.3). */
export type EpVerbTarget =
  | { mode: "self" }
  | { mode: "owner" | "any" | "child" | "ledger" | "handle"; owner: string; actor: string; lifecycleUid: string; mappingRevision?: number };

/** What every verb needs to address one command: the compiled §13.7 contracts (digests derive
 *  from `closureDigest`, exactly like the serve table), the caller triple the credential pins,
 *  and an optional display name for the advisory `from.name`. */
export interface EpVerbOp {
  endpoint: string;
  command: string;
  contract: { input: CompiledContract; output: CompiledContract };
  caller: EpCaller;
  args?: Record<string, unknown>;
  target?: EpVerbTarget;
  correlation?: EpCorrelation;
  /** Opaque signed authorization-context slot (§13.3); carried as-is. */
  auth?: string;
  goalId?: string;
  /** Advisory display name for `from.name`; `from.id` is DERIVED from the caller triple, so it
   *  always equals the broker-authenticated sender principal (§13.3). */
  name?: string;
}

const nonce = (): string => randomBytes(24).toString("base64url"); // 32 tokens of [A-Za-z0-9_-], 192 bits

function subjectTarget(t: EpVerbTarget): EpTarget {
  if (t.mode === "self") return { mode: "self" };
  if (t.mode === "handle")
    return { mode: "handle", tOwner: t.owner, tActor: t.actor, tUid: t.lifecycleUid };
  return { mode: t.mode, tOwner: t.owner };
}

function bodyTarget(t: EpVerbTarget): EpTargetBlock | undefined {
  if (t.mode === "self") return undefined;
  return {
    owner: assertBoundedOwner(t.owner, "target owner"),
    actor: t.actor,
    lifecycleUid: assertLifecycleToken(t.lifecycleUid, "target lifecycleUid"),
    ...(t.mappingRevision !== undefined ? { mappingRevision: t.mappingRevision } : {}),
  };
}

function buildRequest(
  space: string,
  route: EpRoute,
  op: EpVerbOp,
  verb: { replyExpected: boolean; deadlineMs?: number },
): { subject: string; requestId: string; n: string; body: Uint8Array } {
  // §13.7: the caller's own contract gates the args BEFORE publish — the same validator and the
  // same budget the responder runs, so a request this boundary admits pins digests the
  // responder can honor or reject, never digests detached from the payload.
  assertArgsValid(op.contract.input.validate, op.args);
  const n = nonce();
  const subject = epRequestSubject(space, {
    route, endpoint: op.endpoint, command: op.command,
    ...(op.target ? { target: subjectTarget(op.target) } : {}),
    caller: op.caller, nonce: n,
  });
  const requestId = nonce();
  const env: EndpointRequest = {
    v: 1,
    id: requestId,
    op: {
      endpoint: op.endpoint,
      command: op.command,
      inputDigest: op.contract.input.closureDigest,
      outputDigest: op.contract.output.closureDigest,
    },
    class: "ephemeral", // journal work rides epj submissions, never a rail verb (§13.4/§13.5)
    replyExpected: verb.replyExpected,
    ...(op.goalId !== undefined ? { goalId: op.goalId } : {}),
    ...(op.target && op.target.mode !== "self" ? { target: bodyTarget(op.target) } : {}),
    ...(op.args !== undefined ? { args: op.args } : {}),
    from: { id: `${op.caller.owner}.${op.caller.actor}`, name: op.name ?? op.caller.actor },
    ...(verb.deadlineMs !== undefined ? { deadlineMs: verb.deadlineMs } : {}),
    ...(op.correlation !== undefined ? { correlation: op.correlation } : {}),
    ...(op.auth !== undefined ? { auth: op.auth } : {}),
  };
  return { subject, requestId, n, body: new TextEncoder().encode(JSON.stringify(env)) };
}

// Node clamps a `setTimeout` delay beyond 2^31-1 ms (~24.8 days) to 1ms, so an over-large deadline
// would fire IMMEDIATELY (an unbounded budget masquerading as a huge one). Bound every budget to the
// timer range so the deadline the caller passes is the deadline the timer honors.
const MAX_TIMER_MS = 2_147_483_647;
function assertDeadline(deadlineMs: number, what = "deadlineMs"): number {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_TIMER_MS)
    throw new EpEnvelopeError("bad-request", `${what} ${deadlineMs} must be a positive budget within the timer bound ${MAX_TIMER_MS}ms (SPEC 13.3: bounded, never unbounded; a larger setTimeout clamps to 1ms)`);
  return deadlineMs;
}

/** A NATS "no responders" control message: the broker answered that the request subject had zero
 *  subscribers (SPEC 13.5: no responder → unavailable), delivered to the publish reply-to as an empty
 *  message with a 503 status header — distinct from a responder that exists but missed the deadline.
 *  A responder CAN attach a 503 header to its own reply, so this header alone is not proof of broker
 *  authorship: callers must trust it ONLY on the reserved no-responders sentinel subject (which carries
 *  no responder publish grant), never on a normal reply subject. */
function isNoRespondersMsg(msg: Msg): boolean {
  const h = msg.headers as { code?: number; status?: string } | null | undefined;
  return h != null && (h.code === 503 || h.status === "503");
}

/** Race a caller-supplied read against a bounded budget so a never-settling hook cannot exceed the
 *  operation deadline (SPEC 13.5: deadline mandatory). Clears its timer on either outcome. */
async function raceBounded<T>(read: () => Promise<T> | T, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => read())(),
      new Promise<never>((_, reject) => { t = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `${what} did not settle within the ${ms}ms budget (SPEC 13.5)`)), ms); }),
    ]);
  } finally { if (t !== undefined) clearTimeout(t); }
}

/** The caller's per-request reply subscription: its own rail narrowed to exactly this request's
 *  nonce (contained in the §13.9 reply-read grant), so concurrent calls never see each other. */
function replySubjectFor(space: string, caller: EpCaller, n: string): string {
  return `${spacePrefix(space)}.ep.reply.*.*.*.${callerTokens(caller).join(".")}.${n}`;
}

/** One attributed reply: the structural attribution comes from the reply SUBJECT (§13.2), never
 *  from the body. */
export interface EpAttributedReply {
  reply: EndpointReply;
  responder: { endpoint: string; instanceId: string; epoch: number };
}

function parseAttributedReply(space: string, subject: string, data: Uint8Array, requestId: string, op: EpVerbOp, expect?: { instanceId?: string; epoch?: number }): EpAttributedReply {
  const parsed = parseEpSubject(subject);
  if (!parsed || parsed.plane !== "reply")
    throw new EpEnvelopeError("internal", `a message on the caller's reply rail does not parse as a reply subject: ${subject}`);
  // §13.2 (:1173-1189): ACCEPTANCE binds the subject-borne attribution to the INVOKED identity.
  // Reading the endpoint/instance/epoch off the subject is not the same as checking them against the
  // invocation: a truthfully-attributed reply from a DIFFERENT endpoint (or a stale/other instance)
  // is not the requested responder, and nonce possession is addressing, not authorization. A stale
  // process "publishes attributably stale replies that callers reject" — so the caller rejects here.
  if (parsed.endpoint !== op.endpoint)
    throw new EpEnvelopeError("internal", `reply endpoint "${parsed.endpoint}" is not the invoked endpoint "${op.endpoint}" (SPEC 13.2: the caller binds a reply to the requested identity, never trusts the subject alone)`);
  if (expect?.instanceId !== undefined && parsed.instanceId !== expect.instanceId)
    throw new EpEnvelopeError("internal", `reply instance "${parsed.instanceId}" is not the addressed instance "${expect.instanceId}" (SPEC 13.2)`);
  if (expect?.epoch !== undefined && parsed.epoch !== expect.epoch)
    throw new EpEnvelopeError("expired", `reply epoch ${parsed.epoch} is not the addressed epoch ${expect.epoch}; a superseded incarnation's reply is rejected (SPEC 13.2:1187-1189)`);
  // §13.3: an unparseable body is THIS boundary's own structured refusal — the documented catalog
  // (`internal`) holds; a raw SyntaxError must never escape the verb (the watch path already wraps
  // its decode the same way).
  let rawBody: unknown;
  try { rawBody = JSON.parse(new TextDecoder().decode(data)); }
  catch (e) { throw new EpEnvelopeError("internal", `the reply body on the caller's rail is not JSON (${e instanceof Error ? e.message : String(e)}); an unparseable reply is a responder bug surfaced as the caller boundary's structured refusal (SPEC 13.3)`); }
  const reply = parseEndpointReply(rawBody);
  if (reply.id !== requestId)
    throw new EpEnvelopeError("internal", `reply id "${reply.id}" does not echo the request id "${requestId}" on its nonce-scoped rail (SPEC 13.3)`);
  // §13.3: a success payload validates against the pinned output contract at ITS consuming
  // boundary, under the same fixed budget; the responder's bug never parses as caller success.
  if (reply.ok) assertOutputValid(op.contract.output.validate, reply.data);
  return { reply, responder: { endpoint: parsed.endpoint, instanceId: parsed.instanceId, epoch: parsed.epoch } };
}

// ---- call (§13.5: request/reply, deadline-bounded) ----------------------------------------------

/**
 * Call one command and await its reply within `deadlineMs`: on the `one` (queue-group anycast) or
 * `inst` (stable incarnation) rail with `replyExpected: true`, subscribe the caller's own
 * nonce-scoped reply subject BEFORE publishing, and resolve the first attributed reply — BOUND to
 * the invoked identity (§13.2:1187-1189: "callers reject" stale-process replies), on BOTH rails:
 *  - `inst` pins the addressed `(instanceId, epoch)` incarnation up front; a stale-epoch reply is
 *    `expired` and a wrong-instance reply `internal`.
 *  - `one` cannot pin an instance up front (the queue picks the responder), so the caller MUST supply
 *    `currentEpoch(instanceId)`: after the reply lands, the answering incarnation's epoch is checked
 *    against its current registry epoch, and a superseded-but-still-connected queue member's reply is
 *    `expired`. The queue winner is NOT implicitly current — that is a check, not an assumption.
 *
 * Application-level failure is NOT a throw: the resolved `reply` carries `ok: false` with the
 * responder's structured error (§13.3). This boundary throws only for its own refusals: invalid args
 * `bad-request`; an unparseable/mis-echoed/mis-attributed reply `internal` (a raw decode error never
 * escapes); a throwing `currentEpoch` hook `internal` and a garbled (non-integer/negative) currency
 * value `failed-precondition` (the read's own failure, never mislabeled staleness); a stale reply `expired`;
 * NO responder `unavailable` (SPEC 13.5:1484 — the broker's no-responders 503 lands on a reply-to that
 * sits on THIS caller's own rail, so a manual, fully-disposed probe distinguishes it from a slow
 * responder without leaving a lingering request); a failed reply subscription `unavailable`; the
 * elapsed budget `deadline-exceeded`. Every subscription and timer is released in the `finally`.
 */
export async function epCall(
  nc: NatsConnection,
  space: string,
  route: { mode: "one" } | { mode: "inst"; instanceId: string; epoch: number },
  op: EpVerbOp,
  opts: { deadlineMs: number; currentEpoch?: (instanceId: string) => Promise<number> | number },
): Promise<EpAttributedReply> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  if (route.mode === "one" && opts.currentEpoch === undefined)
    throw new EpEnvelopeError("bad-request", "epCall on the `one` rail requires opts.currentEpoch: the queue winner is not implicitly current, and a superseded-but-connected member's reply must be rejected (SPEC 13.2:1187-1189)");
  const req = buildRequest(space, route, op, { replyExpected: true, deadlineMs });
  const expect = route.mode === "inst" ? { instanceId: route.instanceId, epoch: route.epoch } : undefined;
  // A no-responders reply-to that lands on THIS caller's OWN rail (within its §13.9 read grant, no
  // inbox prefix needed): responders answer on the DERIVED rail, so this sentinel only ever carries
  // the broker's no-responders 503, which our rail subscription observes and disposes with everything
  // else in the finally — no ghost request/subscription/timer survives a successful call.
  const noRespReplyTo = `${spacePrefix(space)}.ep.reply._nr._nr._nr.${callerTokens(op.caller).join(".")}.${req.n}`;
  const started = Date.now();
  let sub: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = new Promise<{ subject: string; data: Uint8Array }>((resolve, reject) => {
      sub = nc.subscribe(replySubjectFor(space, op.caller, req.n), {
        callback: (err, msg) => {
          if (err) { reject(new EpEnvelopeError("unavailable", `the caller's reply subscription failed: ${err.message}`)); return; }
          // Broker no-responders is authoritative ONLY on the reserved sentinel reply-to: no responder
          // holds a publish grant for the `_nr._nr._nr` subject (§13.9), so only the broker's control
          // frame reaches it. A 503 status header on a NORMAL responder subject is just a responder
          // frame carrying a status line — a recipient knows the nonce and could forge one to
          // impersonate transport absence — so it takes the ordinary attributed-reply path below, never
          // the broker-control path.
          if (msg.subject === noRespReplyTo) {
            if (isNoRespondersMsg(msg)) { reject(new EpEnvelopeError("unavailable", `no responder for ${op.endpoint}.${op.command} (SPEC 13.5)`)); return; }
            reject(new EpEnvelopeError("internal", `a non-503 message reached the reserved no-responders sentinel for ${op.endpoint}.${op.command}; nothing but the broker control frame is addressable there`)); return;
          }
          resolve({ subject: msg.subject, data: msg.data });
        },
      });
    });
    nc.publish(req.subject, req.body, { reply: noRespReplyTo });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no reply to ${op.endpoint}.${op.command} within the ${deadlineMs}ms budget (SPEC 13.5)`)), deadlineMs); });
    const msg = await Promise.race([outcome, timeout]);
    const attributed = parseAttributedReply(space, msg.subject, msg.data, req.requestId, op, expect);
    if (route.mode === "one") {
      // §13.2:1187-1189 currency for the queue winner, bounded by the REMAINING budget so the whole
      // call stays within ONE `deadlineMs` (deliberately NOT a second dedicated budget like scatter's
      // `reconcileDeadlineMs`: a call's reply usually arrives well before T, leaving room to verify,
      // whereas scatter's gather deterministically eats its whole deadline). The consequence is a
      // deliberate disposition: a VALID reply that lands with no budget left to verify currency is
      // `deadline-exceeded`, not the reply — the operation could not complete-and-verify within its
      // budget. Recorded for the panel's §13.5 reconciliation (dedicated one-rail currency budget?).
      const remaining = deadlineMs - (Date.now() - started);
      if (remaining <= 0) throw new EpEnvelopeError("deadline-exceeded", `no budget left to verify the \`one\` responder's currency within ${deadlineMs}ms (SPEC 13.5)`);
      // The hook is an untrusted caller-supplied boundary (same class as scatter's reconcile): its
      // own throw is normalized into the documented catalog, and its VALUE is runtime-fenced — a
      // NaN/garbled epoch compares unequal to any real epoch and would masquerade as staleness
      // (`expired`), mislabeling a valid reply; fail loud as the read's own failure instead.
      let cur: number;
      try {
        cur = await raceBounded(() => opts.currentEpoch!(attributed.responder.instanceId), remaining, `the \`one\` currency read for ${op.endpoint}.${op.command}`);
      } catch (e) {
        if (e instanceof EpEnvelopeError) throw e; // the bound's deadline-exceeded, or the hook's own structured refusal
        throw new EpEnvelopeError("internal", `the \`one\` currency read threw (${e instanceof Error ? e.message : String(e)}); the documented error catalog holds at this boundary (SPEC 13.3)`);
      }
      if (!Number.isSafeInteger(cur) || cur < 0)
        throw new EpEnvelopeError("failed-precondition", `the \`one\` currency read returned a non-integer/negative epoch ${String(cur)}; a garbled currency read is refused as the read's own failure, never reported as responder staleness (SPEC 13.2)`);
      if (attributed.responder.epoch !== cur)
        throw new EpEnvelopeError("expired", `the \`one\` responder ${attributed.responder.instanceId} answered at epoch ${attributed.responder.epoch}, not its current ${cur}; a superseded incarnation's reply is rejected (SPEC 13.2:1187-1189)`);
    }
    return attributed;
  } finally {
    sub?.unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- cast (§13.5: at-most-once, never replied) --------------------------------------------------

/**
 * Cast one command: the same request form with `replyExpected: false` — the responder never
 * replies, even on failure (§13.5 at-most-once), so this resolves once the request is flushed to
 * the broker. `deadlineMs` is optional and advisory for `one`/`inst` (the envelope requires it only
 * for calls and journal submissions, §13.3), but MANDATORY for `all`: §13.2's
 * `checkRequestSubjectAgreement` refuses an all-rail request without a deadline regardless of
 * `replyExpected`, and a cast has no reply on which that refusal could surface — so an all-cast
 * without a deadline would be silently dropped by every responder. Fail loud at the caller instead.
 */
export async function epCast(
  nc: NatsConnection,
  space: string,
  route: EpRoute,
  op: EpVerbOp,
  opts: { deadlineMs?: number } = {},
): Promise<void> {
  if (route.mode === "all" && opts.deadlineMs === undefined)
    throw new EpEnvelopeError("bad-request", "an all-rail cast (scatter) requires deadlineMs (SPEC 13.2: checkRequestSubjectAgreement refuses an all request without a deadline; a cast has no reply to carry that refusal, so it would be silently dropped)");
  const req = buildRequest(space, route, op, {
    replyExpected: false,
    ...(opts.deadlineMs !== undefined ? { deadlineMs: assertDeadline(opts.deadlineMs) } : {}),
  });
  nc.publish(req.subject, req.body);
  await nc.flush();
}

// ---- watch: the LIVE-EVENT half (§13.5) --------------------------------------------------------
//
// The §13.5 `watch` verb has two forms, and this file owns only the live-event one:
//   - a RECORD watch (KV watch; fell-behind ⇒ re-read, §13.4) IS {@link import("./endpoint-records.js").watchRecord};
//   - an EVENT topic watch = a live subscription within the read grant (below) PLUS filtered replay
//     from the event stream, which is the §13.9 MEDIATED read (a durable catch-up onto the caller's
//     own rail), not a raw JetStream tap here.
// `epWatchEvents` is therefore named for exactly what it is — the live event tap — so it is not read
// as the whole `watch` verb. Composing the mediated replay with this live tail is a later slice.

/** One attributed event: identity and epoch come from the SUBJECT (§13.2: forge-locked tokens;
 *  a stale-epoch event is attributably stale — surfaced, never hidden). */
export interface EpAttributedEvent {
  endpoint: string;
  instanceId: string;
  epoch: number;
  topic: string[];
  event: EndpointEvent;
}

export interface EpWatchHandle {
  stop(): Promise<void>;
}

/**
 * Watch a granted `epe` subtree LIVE (the event half of §13.5 `watch`; §13.9: the read grant is the
 * caller's own `sub.allow` row, e.g. the per-goal progress subtree — delivery lands only on this
 * caller's own subscription). Every event is validated at this consuming boundary: an unparseable
 * subject or body is reported through `onError` (§13.3: fail loud, never a silent drop) and never
 * reaches `onEvent`. This is the LIVE tap ONLY — durable catch-up / filtered replay is the §13.9
 * mediated read (see the module note above), and record watch is `watchRecord` (§13.4).
 */
export function epWatchEvents(
  nc: NatsConnection,
  space: string,
  filter: string,
  handlers: { onEvent: (ev: EpAttributedEvent) => void; onError: (err: EpEnvelopeError) => void },
): EpWatchHandle {
  if (!filter.startsWith(`${spacePrefix(space)}.epe.`))
    throw new Error(`epWatchEvents filter "${filter}" is not an epe subtree of space "${space}" (SPEC 13.9: watch reads the event plane)`);
  const sub = nc.subscribe(filter, {
    callback: (err, msg) => {
      if (err) {
        handlers.onError(new EpEnvelopeError("unavailable", `the watch subscription failed: ${err.message}`));
        return;
      }
      const parsed = parseEpSubject(msg.subject);
      if (!parsed || parsed.plane !== "event") {
        handlers.onError(new EpEnvelopeError("internal", `a message on the watch filter does not parse as an event subject: ${msg.subject}`));
        return;
      }
      let event: EndpointEvent;
      try {
        event = parseEndpointEvent(JSON.parse(new TextDecoder().decode(msg.data)));
      } catch (e) {
        handlers.onError(e instanceof EpEnvelopeError ? e : new EpEnvelopeError("internal", `event body does not decode: ${(e as Error).message}`));
        return;
      }
      handlers.onEvent({ endpoint: parsed.endpoint, instanceId: parsed.instanceId, epoch: parsed.epoch, topic: parsed.topic, event });
    },
  });
  return { stop: () => sub.drain() };
}

// ---- scatter (§13.5: frozen expected set, attributed gather) ------------------------------------

/** The scatter gathers against a request-scoped FROZEN expected set (§13.5): the live instances of
 *  the class, each `(instanceId, registrationRevision, epoch)` at send time. This is exactly
 *  {@link import("./endpoint-service.js").freezeExpectedSet}'s output — pass it through so the freeze
 *  identity (all THREE coordinates, not just instance+epoch) is what the gather classifies against. */
export type EpScatterSlot = FrozenInstance;

/** Why a frozen slot's reply is churn (§13.5): `epoch` — it replied at a DIFFERENT process epoch than
 *  frozen (a takeover restarted it); `registration` — its `svc….spec` registrationRevision advanced
 *  past the frozen value (a re-registration re-declared its surface). Both mean the reply may be from
 *  an incarnation that never saw this request, so it does NOT count toward completion. Registration
 *  churn is NOT visible on the reply rail (the reply subject carries epoch, not registrationRevision,
 *  and a re-registration does not advance the epoch), so it is observed only when a registration
 *  reconcile runs (see {@link epScatter} `reconcileRegistration`). */
export type EpChurnReason = "epoch" | "registration";

/** The §13.5 scatter outcome. `complete` means EXPECTED-SLOT COVERAGE — every frozen slot produced
 *  exactly one counted valid reply at its frozen `(epoch, registrationRevision)`, verified against the
 *  registration reconcile — NOT that the gather was anomaly-free. `missing` and `invalid` force
 *  `complete` false; a `registration`-churn drops a slot's counted reply (so that slot becomes
 *  uncovered → false). But `duplicate`, `unexpected`, and an `epoch`-churn reply do NOT by themselves
 *  force false: a slot that answered validly at its frozen epoch stays counted even if a stray
 *  different-epoch reply from another incarnation also arrived. First valid reply per frozen
 *  `(instanceId, epoch)` wins. */
export interface EpScatterResult {
  complete: boolean;
  /** instanceId → the first VALID attributed reply from that frozen slot at its frozen epoch. */
  replies: Map<string, EpAttributedReply>;
  /** Frozen slots with NO reply of any kind by the DEADLINE (the classification point). A slot that
   *  produced only churn/duplicate/invalid is reported there. A slot that produced ONLY a `late` reply
   *  is BOTH `missing` (no on-time reply) and `late` (observational): classification linearizes at the
   *  deadline, and the drain enriches, never moves it. */
  missing: string[];
  /** Replies from a DIFFERENT endpoint, or from an instance OUTSIDE the frozen set. Never count. */
  unexpected: { instanceId: string; epoch: number }[];
  /** Frozen slots whose reply came from a superseded incarnation — a DIFFERENT epoch, or (via the
   *  mandatory `reconcileRegistration`) an advanced registrationRevision. Does NOT count. */
  churn: { instanceId: string; epoch: number; reason: EpChurnReason }[];
  /** Second-and-later replies from a frozen `(instanceId, epoch)` after its first classified one:
   *  REPORTED, never silently dropped (§13.5); first reply wins, whatever it was classified. */
  duplicate: { instanceId: string; epoch: number }[];
  /** Valid frozen-slot replies observed AFTER the deadline, during the optional bounded `lateDrainMs`
   *  window: too late to count, reported not dropped. Empty unless `lateDrainMs` set. */
  late: { instanceId: string; epoch: number }[];
  /** Frozen-slot replies that failed this consuming boundary (unparseable body, id mismatch, invalid
   *  success payload, mis-attributed). NON-TERMINAL: an invalid frame does NOT consume the slot's one
   *  terminal reply — the slot stays open to a later valid reply, bounded by the deadline. But any
   *  recorded invalid keeps `complete` false (§13.3 fail-loud: an observed anomaly is not clean).
   *  Not a §13.5-enumerated bucket; kept because fail-loud forbids counting an invalid reply as valid. */
  invalid: { instanceId: string; epoch: number; message: string }[];
}

/** The reconcile hook's per-instance verdict. An instance STILL in the registry carries its current
 *  `registrationRevision`; one the mediated §13.9 read observed as GONE is `{ registered: false }`.
 *  This is an EXPLICIT value, distinct from an absent Map entry — an absent entry stays an incomplete
 *  read (`failed-precondition`), so a buggy/partial hook can never masquerade as "everyone deregistered".
 *  A mid-scatter deregistration is NOT registration-churn (a re-registration advances the revision and
 *  invalidates the reply; a plain departure does not): a valid reply the instance already gave still
 *  counts, and if it never replied its slot falls to `missing`. */
export type EpRegistrationState =
  | { registered: true; registrationRevision: number }
  | { registered: false };

/**
 * Scatter one command to a FROZEN expected set (§13.5): publish once on the `all` rail, gather
 * attributed replies on the caller's nonce-scoped rail, and CLASSIFY against the freeze. An empty set
 * refuses (`failed-precondition`, never an empty success), and the observation channel is fail-loud:
 * a failed reply subscription is `unavailable`, never fabricated member silence.
 *
 * CLASSIFICATION LINEARIZES AT THE GATHER DEADLINE. The classification point T is `min(all frozen
 * slots answered-valid, deadline)`; `missing` is fixed at T (from the `respondedAtDeadline` snapshot).
 * The `lateDrainMs` window runs AFTER T on an ABSOLUTE clock — the rail is closed exactly `lateDrainMs`
 * after T regardless of how long the reconcile takes, so late classification cannot leak past the
 * requested horizon. It is OBSERVATIONAL only: it may add to `late`/`duplicate`, never move
 * `missing`/`churn`/`complete`. With `lateDrainMs` omitted the rail closes at T (no `late`).
 *
 * WHOLE-OPERATION BUDGET. The op is bounded: the gather to T comes FIRST, then a post-T phase in which
 * the reconcile and the drain run CONCURRENTLY (the drain is armed at T, before the reconcile await).
 * So worst-case wall-clock ≈ `deadlineMs` (gather) + `max(reconcileDeadlineMs, lateDrainMs)` (post-T),
 * NOT their sum. The reconcile is a bounded read taken SHORTLY AFTER T (not a zero-width at-T snapshot):
 * a true instant-of-T revision would need a watch/frontier, so a re-registration strictly concurrent
 * with the bounded read is an inherent, documented window (recorded for the §13.5 SPEC reconciliation).
 *
 * Two §13.5 signals are not on the reply rail, so the caller supplies them as HOOKS (keeping the verb
 * free of storage coupling; the §13.9 read grant stays with the caller, and a caller-read revision is
 * more trustworthy than a responder-stamped one):
 *  - `reconcileRegistration` (REQUIRED): reads EVERY frozen slot's CURRENT state after the classification
 *    point, returning a per-instance `EpRegistrationState` verdict. A slot still registered at a revision
 *    ADVANCED past its frozen one is `churn` ("registration") and uncounted (a re-registration advances
 *    registrationRevision WITHOUT advancing the epoch, so the reply rail cannot see it). A slot the read
 *    observed as GONE (`{ registered: false }`) is an explicit mid-scatter deregistration: NOT churn, and
 *    a valid reply it already gave still counts (a plain departure does not invalidate the reply the way
 *    a re-registration would). Its result is COMPLETENESS-validated: a frozen id ABSENT from the returned
 *    Map is an incomplete read (`failed-precondition`) — distinct from an explicit `{ registered: false }`
 *    verdict — a non-integer/non-positive revision is a garbled read (`failed-precondition`), and a
 *    revision BELOW the frozen one is a non-monotonic/buggy read (`failed-precondition`); otherwise a
 *    partial hook would silently preserve the old full-triple over-claim. It is BOUNDED by
 *    `reconcileDeadlineMs`: a never-settling read is `unavailable`, never a hung scatter (SPEC 13.5:
 *    deadline mandatory); an unreadable registry is `failed-precondition`. Authoritative `complete`
 *    requires it.
 *  - `reconcileDeadlineMs` (optional, default `deadlineMs`): the explicit bound on that post-T read,
 *    named so the single `deadlineMs` is not silently spent twice.
 *  - `lateDrainMs` (optional): the absolute post-T horizon for `late` classification. Omitted → none.
 */
export async function epScatter(
  nc: NatsConnection,
  space: string,
  op: EpVerbOp,
  opts: {
    deadlineMs: number;
    expected: EpScatterSlot[];
    reconcileRegistration: () => Promise<Map<string, EpRegistrationState>>;
    reconcileDeadlineMs?: number;
    lateDrainMs?: number;
  },
): Promise<EpScatterResult> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const reconcileDeadlineMs = opts.reconcileDeadlineMs !== undefined ? assertDeadline(opts.reconcileDeadlineMs, "reconcileDeadlineMs") : deadlineMs;
  const lateDrainMs = opts.lateDrainMs !== undefined ? assertDeadline(opts.lateDrainMs, "lateDrainMs") : 0;
  if (opts.expected.length === 0)
    throw new EpEnvelopeError("failed-precondition", "scatter requires a non-empty frozen expected set (SPEC 13.5: an empty registry is never an empty success)");
  const frozen = new Map<string, { epoch: number; registrationRevision: number }>();
  for (const slot of opts.expected) {
    const iId = assertLifecycleToken(slot.instanceId, "instanceId");
    // Validate the frozen (epoch, registrationRevision) coordinates at this public ingress: an untyped
    // adapter that handed in a NaN/float/negative would otherwise slip past the currency and
    // monotonicity fences downstream (a NaN compares false both ways). Epoch is a non-negative safe
    // integer (the subject epoch), registrationRevision a positive safe integer (a KV revision, §13.7).
    if (!Number.isSafeInteger(slot.epoch) || slot.epoch < 0)
      throw new EpEnvelopeError("bad-request", `frozen instance ${iId} has a non-integer/negative epoch ${slot.epoch}; a frozen coordinate must be a safe integer so an untyped adapter cannot disable the currency fence (§13.2)`);
    if (!Number.isSafeInteger(slot.registrationRevision) || slot.registrationRevision <= 0)
      throw new EpEnvelopeError("bad-request", `frozen instance ${iId} has a non-integer/non-positive registrationRevision ${slot.registrationRevision}; a frozen coordinate must be a positive safe integer so an untyped adapter cannot disable the monotonicity fence (§13.7)`);
    if (frozen.has(iId))
      throw new EpEnvelopeError("failed-precondition", `the frozen expected set names instance ${iId} twice`);
    frozen.set(iId, { epoch: slot.epoch, registrationRevision: slot.registrationRevision });
  }

  const req = buildRequest(space, { mode: "all" }, op, { replyExpected: true, deadlineMs });
  const result: EpScatterResult = { complete: false, replies: new Map(), missing: [], unexpected: [], churn: [], duplicate: [], late: [], invalid: [] };
  const terminal = new Set<string>();  // frozen slots with a VALID frozen-epoch reply (drives early completion)
  const seen = new Set<string>();      // "(instanceId,epoch)" pairs already classified non-invalid (drives §13.5 duplicate)
  const responded = new Set<string>(); // frozen slots that produced ANY reply (live)
  const regChurned = new Set<string>();
  const failMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let respondedAtDeadline: Set<string> | undefined; // `responded` snapshotted at the classification point
  let deadlinePassed = false;
  let subError: unknown;

  // Classify one reply; returns true when every frozen slot has a VALID reply (early completion).
  const handle = (subject: string, data: Uint8Array): boolean => {
    const parsed = parseEpSubject(subject);
    if (!parsed || parsed.plane !== "reply") return false; // not a reply subject: no sender, MUST NOT be handled (§13.2)
    const { instanceId, epoch } = parsed;
    // §13.2 endpoint binding BEFORE slot matching: instanceIds are unique only within (space,
    // endpoint), so a truthfully-attributed reply from a DIFFERENT endpoint with a colliding
    // (instanceId, epoch) must never satisfy a frozen slot.
    if (parsed.endpoint !== op.endpoint) { result.unexpected.push({ instanceId, epoch }); return false; }
    const slot = frozen.get(instanceId);
    if (slot === undefined) { result.unexpected.push({ instanceId, epoch }); return false; }
    responded.add(instanceId);
    const key = `${instanceId}:${epoch}`;
    // §13.5 duplicate: a second reply from the SAME (instanceId, epoch) after its first NON-INVALID
    // classification (valid | churn-epoch | late) — reported, first wins. An invalid frame never marks
    // the coordinate seen, so a later valid frame from it is NOT mislabeled duplicate.
    if (seen.has(key)) { result.duplicate.push({ instanceId, epoch }); return false; }
    if (epoch !== slot.epoch) { result.churn.push({ instanceId, epoch, reason: "epoch" }); seen.add(key); return false; }
    if (deadlinePassed) {
      // Post-deadline, frozen epoch: a first VALID reply is LATE (observational, uncounted); a boundary
      // failure is `invalid` (NON-terminal — the coordinate stays un-seen).
      try { parseAttributedReply(space, subject, data, req.requestId, op); result.late.push({ instanceId, epoch }); seen.add(key); }
      catch (e) { result.invalid.push({ instanceId, epoch, message: failMsg(e) }); }
      return false;
    }
    // Pre-deadline, frozen epoch. An invalid frame is NON-TERMINAL: reported, the slot stays open to a
    // later valid reply, the coordinate stays un-seen, and it never triggers early completion.
    try { result.replies.set(instanceId, parseAttributedReply(space, subject, data, req.requestId, op)); }
    catch (e) { result.invalid.push({ instanceId, epoch, message: failMsg(e) }); return false; }
    terminal.add(instanceId); seen.add(key);
    return terminal.size === frozen.size;
  };

  let sub: Subscription | undefined;
  // Phase 1 — gather to the classification point T = min(all-valid, deadline). NO drain here; the drain
  // is a later observational phase so it can never move the classification.
  await new Promise<void>((resolve) => {
    const finishAtT = () => { if (respondedAtDeadline === undefined) respondedAtDeadline = new Set(responded); };
    const timer = setTimeout(() => { deadlinePassed = true; finishAtT(); resolve(); }, deadlineMs);
    sub = nc.subscribe(replySubjectFor(space, op.caller, req.n), {
      callback: (err, msg) => {
        if (err) { subError ??= err; finishAtT(); clearTimeout(timer); resolve(); return; } // fail loud, never fake `missing`
        if (handle(msg.subject, msg.data)) { finishAtT(); clearTimeout(timer); resolve(); }
      },
    });
    nc.publish(req.subject, req.body);
  });

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (subError !== undefined)
      throw new EpEnvelopeError("unavailable", `the scatter reply subscription failed; without a working observation channel member silence cannot be classified, never fabricated (SPEC 13.5): ${failMsg(subError)}`);

    // The late window is an ABSOLUTE horizon from T: close the rail exactly `lateDrainMs` after T
    // (early completion has no window), independent of how long the reconcile below runs — so a reply
    // during a slow reconcile is NOT misclassified `late`, and with no `lateDrainMs` the rail closes
    // now. Runs concurrently with the reconcile.
    const drainMs = deadlinePassed ? lateDrainMs : 0;
    const drainDone = new Promise<void>((resolve) => {
      if (drainMs > 0) drainTimer = setTimeout(() => { sub?.unsubscribe(); resolve(); }, drainMs);
      else { sub?.unsubscribe(); resolve(); }
    });

    // Reconcile shortly after T, bounded by its OWN explicit budget (not a second full `deadlineMs`):
    // a never-settling read is `unavailable`, an unreadable registry `failed-precondition`.
    let current: Map<string, EpRegistrationState>;
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      current = await Promise.race([
        opts.reconcileRegistration(),
        new Promise<never>((_, reject) => { reconcileTimer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `the scatter registration reconcile did not settle within its ${reconcileDeadlineMs}ms bound (SPEC 13.5: deadline mandatory, never a hung scatter)`)), reconcileDeadlineMs); }),
      ]);
    } catch (e) {
      if (e instanceof EpEnvelopeError && e.code === "unavailable") throw e; // the reconcile bound
      throw new EpEnvelopeError("failed-precondition", `the scatter registration reconcile is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): ${failMsg(e)}`);
    } finally {
      if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
    }
    // COMPLETENESS + MONOTONICITY: the mandatory reconcile must return an EXPLICIT verdict for every
    // frozen slot, else a partial/buggy read would silently preserve the old full-triple over-claim.
    // An ABSENT Map entry is an incomplete read (fail-loud) — distinct from an explicit deregistration
    // verdict. A still-registered slot's revision below-frozen is non-monotonic (revisions only advance
    // on mediated registration writes, §13.7), a NaN/non-integer one is garbled: both fail-loud. An
    // advanced revision is registration-churn (drops the counted reply). An explicit deregistration is
    // NOT churn: a valid reply the instance already gave still counts, and if it never replied its slot
    // falls to `missing` below.
    for (const [instanceId, slot] of frozen) {
      const state = current.get(instanceId);
      if (state === undefined)
        throw new EpEnvelopeError("failed-precondition", `the reconcile returned no verdict for frozen instance ${instanceId}; an incomplete registration read cannot authorize completion, and an absent Map entry is NOT an implicit deregistration (SPEC 13.5)`);
      // RUNTIME-validate the discriminant at this untrusted boundary (TS alone cannot fence a
      // caller-supplied/legacy hook): the verdict MUST be an explicit `{ registered: boolean }`. A bare
      // number, `{}`, or `{ registered: 0 }` must FAIL LOUD, never fall through the falsy check below as
      // an implicit deregistration and bypass the completeness fence the typed result exists to enforce.
      if (typeof state !== "object" || state === null || typeof (state as { registered?: unknown }).registered !== "boolean")
        throw new EpEnvelopeError("failed-precondition", `the reconcile verdict for instance ${instanceId} is not a typed { registered: boolean } state; an untyped/legacy value must never masquerade as a deregistration (SPEC 13.5)`);
      if (state.registered === false) continue; // explicit mid-scatter deregistration: not churn; a prior reply still counts
      const now = state.registrationRevision;
      if (!Number.isSafeInteger(now) || now <= 0)
        throw new EpEnvelopeError("failed-precondition", `the reconcile reports instance ${instanceId} at a non-integer/non-positive registrationRevision ${now}; a NaN or garbled value is neither below nor above the frozen revision and would silently disable the monotonicity fence (§13.7), so it is refused, never a counted completion`);
      if (now < slot.registrationRevision)
        throw new EpEnvelopeError("failed-precondition", `the reconcile reports instance ${instanceId} at registrationRevision ${now}, below its frozen ${slot.registrationRevision}; registration revisions are monotonic (§13.7), so a lower value is a buggy/unreadable read`);
      if (now > slot.registrationRevision) {
        result.replies.delete(instanceId);
        result.churn.push({ instanceId, epoch: slot.epoch, reason: "registration" });
        regChurned.add(instanceId);
      }
    }

    await drainDone; // let the absolute late window fully elapse (observational) before finalizing
  } finally {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    sub?.unsubscribe();
  }

  const respondedT = respondedAtDeadline ?? responded;
  for (const instanceId of frozen.keys())
    if (!respondedT.has(instanceId) && !regChurned.has(instanceId)) result.missing.push(instanceId);
  // Coverage completion: every frozen slot has a counted valid reply, none reg-churned (drops
  // replies.size), no missing, and NO observed invalid frame (fail-loud: an invalid is not clean).
  result.complete = result.missing.length === 0 && result.invalid.length === 0 && result.replies.size === frozen.size;
  return result;
}
