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

function assertDeadline(deadlineMs: number): number {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)
    throw new EpEnvelopeError("bad-request", `deadlineMs ${deadlineMs} must be a positive bounded budget (SPEC 13.3: bounded, never unbounded)`);
  return deadlineMs;
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

function parseAttributedReply(space: string, subject: string, data: Uint8Array, requestId: string, op: EpVerbOp): EpAttributedReply {
  const parsed = parseEpSubject(subject);
  if (!parsed || parsed.plane !== "reply")
    throw new EpEnvelopeError("internal", `a message on the caller's reply rail does not parse as a reply subject: ${subject}`);
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
 * Call one command and await its reply within `deadlineMs`: publish on the `one` (queue-group
 * anycast) or `inst` (stable instance) rail with `replyExpected: true`, subscribe the caller's
 * own nonce-scoped reply subject BEFORE publishing, and resolve the first attributed reply.
 * Application-level failure is NOT a throw: the resolved `reply` carries `ok: false` with the
 * responder's structured error (§13.3) — this boundary throws only for its own refusals
 * (invalid args `bad-request`, an unparseable/mis-echoed reply `internal`, and the elapsed
 * budget `deadline-exceeded`).
 */
export async function epCall(
  nc: NatsConnection,
  space: string,
  route: { mode: "one" } | { mode: "inst"; instanceId: string },
  op: EpVerbOp,
  opts: { deadlineMs: number },
): Promise<EpAttributedReply> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const req = buildRequest(space, route, op, { replyExpected: true, deadlineMs });
  let sub: Subscription | undefined;
  try {
    const first = new Promise<{ subject: string; data: Uint8Array }>((resolve, reject) => {
      sub = nc.subscribe(replySubjectFor(space, op.caller, req.n), {
        callback: (err, msg) => { if (err) reject(err); else resolve({ subject: msg.subject, data: msg.data }); },
      });
    });
    nc.publish(req.subject, req.body);
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no reply to ${op.endpoint}.${op.command} within the ${deadlineMs}ms budget (SPEC 13.5)`)), deadlineMs);
      void first.finally(() => clearTimeout(t)).catch(() => { /* the race below reports it */ });
    });
    const msg = await Promise.race([first, timeout]);
    return parseAttributedReply(space, msg.subject, msg.data, req.requestId, op);
  } finally {
    sub?.unsubscribe();
  }
}

// ---- cast (§13.5: at-most-once, never replied) --------------------------------------------------

/**
 * Cast one command: the same request form with `replyExpected: false` — the responder never
 * replies, even on failure (§13.5 at-most-once), so this resolves once the request is flushed
 * to the broker. `deadlineMs` is optional and advisory for a cast (the envelope requires it
 * only for calls and journal submissions, §13.3).
 */
export async function epCast(
  nc: NatsConnection,
  space: string,
  route: EpRoute,
  op: EpVerbOp,
  opts: { deadlineMs?: number } = {},
): Promise<void> {
  const req = buildRequest(space, route, op, {
    replyExpected: false,
    ...(opts.deadlineMs !== undefined ? { deadlineMs: assertDeadline(opts.deadlineMs) } : {}),
  });
  nc.publish(req.subject, req.body);
  await nc.flush();
}

// ---- watch (§13.5: live event read on a granted epe subtree) ------------------------------------

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
 * Watch a granted `epe` subtree live (§13.5 `watch`; §13.9: the read grant is the caller's own
 * `sub.allow` row, e.g. the per-goal progress subtree — delivery lands only on this caller's own
 * subscription). Every event is validated at this consuming boundary: an unparseable subject or
 * body is reported through `onError` (§13.3: fail loud, never a silent drop) and never reaches
 * `onEvent`. Durable catch-up/replay is the §13.9 mediated read, not this live tap.
 */
export function epWatch(
  nc: NatsConnection,
  space: string,
  filter: string,
  handlers: { onEvent: (ev: EpAttributedEvent) => void; onError: (err: EpEnvelopeError) => void },
): EpWatchHandle {
  if (!filter.startsWith(`${spacePrefix(space)}.epe.`))
    throw new Error(`epWatch filter "${filter}" is not an epe subtree of space "${space}" (SPEC 13.9: watch reads the event plane)`);
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

/** The §13.5 scatter outcome: `complete` is TRUE only when every frozen slot produced exactly one
 *  valid reply at its frozen `(epoch, registrationRevision)` — a missing member, an out-of-set
 *  responder, a superseded incarnation (churn), a duplicate, a late reply, or an invalid reply is
 *  CLASSIFIED and reported, never silently folded into success (§13.5). First valid reply per frozen
 *  instance wins. */
export interface EpScatterResult {
  complete: boolean;
  /** instanceId → the first VALID attributed reply from that frozen slot at its frozen epoch. */
  replies: Map<string, EpAttributedReply>;
  /** Frozen slots that produced NO classified reply within the budget (never answered). A slot that
   *  produced only churn / duplicate / late / invalid replies is reported THERE, not here (§13.5: "a
   *  churned slot reports as churn, not missing"). */
  missing: string[];
  /** Replies from instances OUTSIDE the frozen set (C joined mid-scatter). Never count. */
  unexpected: { instanceId: string; epoch: number }[];
  /** Frozen slots whose reply came from a superseded incarnation — a DIFFERENT epoch, or (via
   *  `reconcileRegistration`) an advanced registrationRevision. Does NOT count toward completion. */
  churn: { instanceId: string; epoch: number; reason: EpChurnReason }[];
  /** Second-and-later replies from a frozen `(instanceId, epoch)` after its first valid answer:
   *  REPORTED, never silently dropped (§13.5); first reply wins. */
  duplicate: { instanceId: string; epoch: number }[];
  /** Valid frozen-slot replies observed AFTER the deadline, during the optional bounded `lateDrainMs`
   *  window: too late to count toward completion, reported not dropped. Empty unless `lateDrainMs` set. */
  late: { instanceId: string; epoch: number }[];
  /** Frozen-slot replies that failed this consuming boundary (unparseable body, id mismatch, invalid
   *  success payload) — terminal for the slot, never its valid answer. Not a §13.5-enumerated bucket,
   *  but §13.3 fail-loud forbids counting an invalid reply as valid. */
  invalid: { instanceId: string; epoch: number; message: string }[];
}

/**
 * Scatter one command to a FROZEN expected set (§13.5): publish once on the `all` rail and gather
 * attributed replies on the caller's nonce-scoped rail until every frozen slot is terminal or the
 * deadline elapses, then CLASSIFY rather than complete — membership churn, superseded incarnations,
 * duplicates, late replies, and invalid replies are all reported against the freeze. An empty
 * expected set refuses (`failed-precondition`): the freeze already refuses an empty registry, and
 * this boundary never converts "nobody was asked" into an empty success.
 *
 * Two §13.5 signals are NOT visible on the reply rail alone and are therefore OPT-IN:
 *  - `reconcileRegistration` observes each frozen slot's CURRENT registrationRevision at gather
 *    completion (the freeze's §13.9 read grant); a slot whose value advanced past its frozen one is
 *    reclassified `churn` ("registration") and uncounted. Omitted → epoch difference is the only
 *    churn signal (the reply subject carries epoch, not registrationRevision).
 *  - `lateDrainMs` keeps the subscription open for a bounded window AFTER the deadline; a valid first
 *    reply from a still-unanswered frozen slot in that window is classified `late`. Omitted → no
 *    drain, `late` stays empty.
 */
export async function epScatter(
  nc: NatsConnection,
  space: string,
  op: EpVerbOp,
  opts: {
    deadlineMs: number;
    expected: EpScatterSlot[];
    reconcileRegistration?: () => Promise<Map<string, number>>;
    lateDrainMs?: number;
  },
): Promise<EpScatterResult> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const lateDrainMs = opts.lateDrainMs !== undefined ? assertDeadline(opts.lateDrainMs) : 0;
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
  const terminal = new Set<string>();  // frozen slots with a valid or invalid frozen-epoch answer (drives early completion + dedupe)
  const responded = new Set<string>(); // frozen slots that produced ANY classified reply (so a churn/late-only slot is not `missing`)
  const regChurned = new Set<string>();
  let deadlinePassed = false;

  // Classify one reply; returns true when every frozen slot is terminal (early completion).
  const handle = (subject: string, data: Uint8Array): boolean => {
    const parsed = parseEpSubject(subject);
    if (!parsed || parsed.plane !== "reply") return false; // not a reply subject: no sender, MUST NOT be handled (§13.2)
    const { instanceId, epoch } = parsed;
    const slot = frozen.get(instanceId);
    if (slot === undefined) { result.unexpected.push({ instanceId, epoch }); return false; }
    responded.add(instanceId);
    if (epoch !== slot.epoch) { result.churn.push({ instanceId, epoch, reason: "epoch" }); return false; }
    if (terminal.has(instanceId)) { result.duplicate.push({ instanceId, epoch }); return false; } // first valid wins, dup REPORTED (§13.5)
    if (deadlinePassed) {
      // Past the deadline: a first frozen-epoch reply is LATE — validated at the consuming boundary,
      // but too late to count toward completion. A boundary failure is still `invalid` (fail loud).
      try { parseAttributedReply(space, subject, data, req.requestId, op); result.late.push({ instanceId, epoch }); }
      catch (e) { result.invalid.push({ instanceId, epoch, message: e instanceof Error ? e.message : String(e) }); terminal.add(instanceId); }
      return false;
    }
    try { result.replies.set(instanceId, parseAttributedReply(space, subject, data, req.requestId, op)); }
    catch (e) { result.invalid.push({ instanceId, epoch, message: e instanceof Error ? e.message : String(e) }); }
    terminal.add(instanceId);
    return terminal.size === frozen.size;
  };

  let sub: Subscription | undefined;
  await new Promise<void>((resolve) => {
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      deadlinePassed = true;
      if (lateDrainMs > 0) drainTimer = setTimeout(resolve, lateDrainMs); else resolve();
    }, deadlineMs);
    sub = nc.subscribe(replySubjectFor(space, op.caller, req.n), {
      callback: (err, msg) => {
        if (err) return; // a subscription error ends in the deadline path; slots stay missing (§13.5 reports, never fakes)
        if (handle(msg.subject, msg.data)) { clearTimeout(timer); if (drainTimer) clearTimeout(drainTimer); resolve(); }
      },
    });
    nc.publish(req.subject, req.body);
  });
  sub?.unsubscribe();

  // §13.5 churn-by-registration-advance (opt-in): a re-registration advances registrationRevision
  // WITHOUT advancing the epoch, so it is invisible on the reply rail. Observe each frozen slot's
  // current registrationRevision; a slot whose value advanced is churn ("registration") and its
  // reply (if any) does not count. An unreadable registry is failed-precondition (§13.5), as at freeze.
  if (opts.reconcileRegistration) {
    let current: Map<string, number>;
    try { current = await opts.reconcileRegistration(); }
    catch (e) {
      throw new EpEnvelopeError("failed-precondition", `the scatter registration reconcile is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const [instanceId, slot] of frozen) {
      const now = current.get(instanceId);
      if (now !== undefined && now > slot.registrationRevision) {
        result.replies.delete(instanceId);
        result.churn.push({ instanceId, epoch: slot.epoch, reason: "registration" });
        regChurned.add(instanceId);
      }
    }
  }

  for (const instanceId of frozen.keys())
    if (!responded.has(instanceId) && !regChurned.has(instanceId)) result.missing.push(instanceId);
  // Complete = every frozen slot produced exactly one counted valid frozen-epoch reply. A reg-churned
  // slot's reply was deleted (drops replies.size); a churn/late/invalid/missing slot never counted.
  result.complete = result.missing.length === 0 && result.invalid.length === 0 && result.replies.size === frozen.size;
  return result;
}
