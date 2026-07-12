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
import { NoRespondersError, RequestError } from "@nats-io/transport-node";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
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

/** A NATS "no responders" signal: the broker answered that the request subject had zero subscribers,
 *  distinct from a responder that exists but missed the deadline (SPEC 13.5: no responder → unavailable). */
function isNoResponders(e: unknown): boolean {
  return e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders());
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
  const reply = parseEndpointReply(JSON.parse(new TextDecoder().decode(data)));
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
 * the invoked identity (§13.2): the reply must come from `op.endpoint`, and an `inst` call pins the
 * addressed `(instanceId, epoch)` incarnation so a stale-epoch or wrong-instance reply is rejected.
 * The `inst` route carries `epoch` as the caller's currency pin (read from the registry/presence);
 * whoever answers the queued `one` rail is by definition a live current instance.
 *
 * Application-level failure is NOT a throw: the resolved `reply` carries `ok: false` with the
 * responder's structured error (§13.3). This boundary throws only for its own refusals: invalid args
 * `bad-request`; an unparseable/mis-echoed/mis-attributed reply `internal`; a stale-epoch reply
 * `expired`; NO responder `unavailable` (SPEC 13.5, distinct from a slow one via the broker's
 * no-responders signal — responders reply on the DERIVED rail, never this request's reply-to, so the
 * request inbox only ever receives that signal); a failed reply subscription `unavailable`; and the
 * elapsed budget `deadline-exceeded`.
 */
export async function epCall(
  nc: NatsConnection,
  space: string,
  route: { mode: "one" } | { mode: "inst"; instanceId: string; epoch: number },
  op: EpVerbOp,
  opts: { deadlineMs: number },
): Promise<EpAttributedReply> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const req = buildRequest(space, route, op, { replyExpected: true, deadlineMs });
  const expect = route.mode === "inst" ? { instanceId: route.instanceId, epoch: route.epoch } : undefined;
  let sub: Subscription | undefined;
  try {
    const first = new Promise<{ subject: string; data: Uint8Array }>((resolve, reject) => {
      sub = nc.subscribe(replySubjectFor(space, op.caller, req.n), {
        callback: (err, msg) => { if (err) reject(new EpEnvelopeError("unavailable", `the caller's reply subscription failed: ${err.message}`)); else resolve({ subject: msg.subject, data: msg.data }); },
      });
    });
    // Publish via request/noMux so a genuine NO-RESPONDER surfaces as `unavailable` (SPEC 13.5:1484),
    // distinct from a live-but-slow responder (`deadline-exceeded`). The responder ignores this
    // reply-to and answers on the DERIVED rail (deriveReplySubject), so the request inbox only ever
    // receives the broker's no-responders signal; a live responder makes nc.request time out, which we
    // fold back into `first` (the real reply already landed on the rail).
    const noResponder = nc.request(req.subject, req.body, { noMux: true, timeout: deadlineMs }).then(
      () => first,
      (e) => { if (isNoResponders(e)) throw new EpEnvelopeError("unavailable", `no responder for ${op.endpoint}.${op.command} (SPEC 13.5)`); return first; },
    );
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no reply to ${op.endpoint}.${op.command} within the ${deadlineMs}ms budget (SPEC 13.5)`)), deadlineMs);
      void first.finally(() => clearTimeout(t)).catch(() => { /* the race below reports it */ });
    });
    const msg = await Promise.race([first, noResponder, timeout]);
    return parseAttributedReply(space, msg.subject, msg.data, req.requestId, op, expect);
  } finally {
    sub?.unsubscribe();
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
 *  registration reconcile — NOT that the gather was anomaly-free: `duplicate` and `unexpected` are
 *  reported ALONGSIDE a `complete: true` (they do not force it false), while `missing`, `churn`, and
 *  `invalid` do. First valid reply per frozen `(instanceId, epoch)` wins. */
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

/**
 * Scatter one command to a FROZEN expected set (§13.5): publish once on the `all` rail, gather
 * attributed replies on the caller's nonce-scoped rail, and CLASSIFY against the freeze. An empty set
 * refuses (`failed-precondition`, never an empty success), and the observation channel is fail-loud:
 * a failed reply subscription is `unavailable`, never fabricated member silence.
 *
 * CLASSIFICATION LINEARIZES AT THE DEADLINE. The classification point is `min(all frozen slots
 * answered-valid, deadline)`; the registration reconcile snapshots THERE and `missing` is fixed there.
 * A `lateDrainMs` window runs AFTER and is OBSERVATIONAL only — it may add to `late`/`duplicate`, never
 * move `missing`/`churn`/`complete`.
 *
 * Two §13.5 signals are not on the reply rail, so the caller supplies them as HOOKS (keeping the verb
 * free of storage coupling; the §13.9 read grant stays with the caller, and a caller-read revision is
 * more trustworthy than a responder-stamped one):
 *  - `reconcileRegistration` (REQUIRED): reads each frozen slot's CURRENT registrationRevision at the
 *    classification point; a slot whose value advanced past its frozen one is `churn` ("registration")
 *    and uncounted (a re-registration advances registrationRevision WITHOUT advancing the epoch, so the
 *    reply rail cannot see it). It is BOUNDED by the deadline: a never-settling read is `unavailable`,
 *    never a hung scatter (SPEC 13.5: deadline mandatory); an unreadable registry is
 *    `failed-precondition`. Authoritative `complete` requires it — it is not optional (a frozen third
 *    coordinate never re-compared is dead data, and `complete` would over-claim full-triple coverage).
 *  - `lateDrainMs` (optional): keeps the rail open a bounded window after the deadline; a valid first
 *    reply from a still-missing frozen slot there is `late`. Omitted → no drain, `late` empty.
 */
export async function epScatter(
  nc: NatsConnection,
  space: string,
  op: EpVerbOp,
  opts: {
    deadlineMs: number;
    expected: EpScatterSlot[];
    reconcileRegistration: () => Promise<Map<string, number>>;
    lateDrainMs?: number;
  },
): Promise<EpScatterResult> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const lateDrainMs = opts.lateDrainMs !== undefined ? assertDeadline(opts.lateDrainMs, "lateDrainMs") : 0;
  if (opts.expected.length === 0)
    throw new EpEnvelopeError("failed-precondition", "scatter requires a non-empty frozen expected set (SPEC 13.5: an empty registry is never an empty success)");
  const frozen = new Map<string, { epoch: number; registrationRevision: number }>();
  for (const slot of opts.expected) {
    const iId = assertLifecycleToken(slot.instanceId, "instanceId");
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

  try {
    if (subError !== undefined)
      throw new EpEnvelopeError("unavailable", `the scatter reply subscription failed; without a working observation channel member silence cannot be classified, never fabricated (SPEC 13.5): ${failMsg(subError)}`);

    // Phase 2 — reconcile AT the classification point (before the drain), BOUNDED by the deadline: a
    // re-registration advances registrationRevision without advancing the epoch, so the rail can't see
    // it; a slot whose value advanced is churn ("registration") and its counted reply is dropped.
    let current: Map<string, number>;
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      current = await Promise.race([
        opts.reconcileRegistration(),
        new Promise<never>((_, reject) => { reconcileTimer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `the scatter registration reconcile did not settle within the ${deadlineMs}ms bound (SPEC 13.5: deadline mandatory, never a hung scatter)`)), deadlineMs); }),
      ]);
    } catch (e) {
      if (e instanceof EpEnvelopeError && e.code === "unavailable") throw e; // the deadline bound
      throw new EpEnvelopeError("failed-precondition", `the scatter registration reconcile is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): ${failMsg(e)}`);
    } finally {
      if (reconcileTimer !== undefined) clearTimeout(reconcileTimer); // don't keep the event loop alive after a fast reconcile
    }
    for (const [instanceId, slot] of frozen) {
      const now = current.get(instanceId);
      if (now !== undefined && now > slot.registrationRevision) {
        result.replies.delete(instanceId);
        result.churn.push({ instanceId, epoch: slot.epoch, reason: "registration" });
        regChurned.add(instanceId);
      }
    }

    // Phase 3 — optional observational drain (only when the deadline, not early completion, ended the
    // gather): the rail stays open lateDrainMs longer; a valid first reply from a still-missing frozen
    // slot lands in `late`. It never moves the frozen classification above.
    if (lateDrainMs > 0 && deadlinePassed)
      await new Promise<void>((resolve) => setTimeout(resolve, lateDrainMs));
  } finally {
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
