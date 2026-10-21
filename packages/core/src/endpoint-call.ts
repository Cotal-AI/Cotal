/** The node-free call path of the §13.5 verbs (`epCall`, `epCast`, the instance probe), shared by
 *  `endpoint-verbs` and the browser entry. Moved unchanged from `endpoint-verbs.ts`. */
import { base64url } from "./base64url.js";
import type { Msg, NatsConnection, Subscription } from "@nats-io/transport-node";
import { openPublishDenialWatch } from "./endpoint-publish-denial.js";
import { spacePrefix } from "./subjects.js";
import { epRequestSubject, parseEpSubject, callerRailTokens, epPlaneTokens, assertIdToken, assertLifecycleToken, assertBoundedOwner, type EpCaller, type EpRoute, type EpTarget } from "./endpoint-subjects.js";
import { EpEnvelopeError, EP_UNBOUND_RESPONDER, EP_UNANSWERED, EP_REGISTRY_READ_FAILED, EP_UNDECLARED_ARG, EP_BIND_REFUSED, bindRefusalMarked, parseEndpointReply, assertArgsValid, assertOutputValid, type EndpointRequest, type EndpointReply, type EpCorrelation, type EpTargetBlock, type EpUnboundResponderDetail, type EpBindRefusedDetail, type EpUnansweredDetail, type EpRegistryReadFailedDetail, type EpErrorDetail, type EpBindBlock } from "./endpoint-envelope.js";
import type { CompiledContract } from "./schema-profile.js";

// ---- shared request construction ---------------------------------------------------------------

/** A verb's target: one input shape that builds BOTH halves of the §13.2/§13.3 targeted form —
 *  the subject's authorization-mode token block and the body target block — so they can never
 *  disagree. `self` carries no body target (the caller triple IS the target, §13.3). */
export type EpVerbTarget =
  | { mode: "self" }
  | { mode: "owner" | "any" | "child" | "ledger" | "handle" | "exact"; owner: string; actor: string; lifecycleUid: string; mappingRevision?: number };

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
  /** The incarnation this caller resolved against (§13.3). Carrying it makes a responder that is
   *  not that incarnation refuse BEFORE running the command, which is the only place the refusal
   *  can be a guard rather than a report. Omitted ⇒ any member of the class may serve the call. */
  bind?: EpBindBlock;
  correlation?: EpCorrelation;
  /** Opaque signed authorization-context slot (§13.3); carried as-is. */
  auth?: string;
  goalId?: string;
  /**
   * A caller-PINNED envelope id, replacing the per-publish nonce. A goal-accepting command binds
   * its goal under the envelope id, so a durable caller that must resubmit idempotently — a
   * workflow run resuming across a crash re-derives the same `requestId` and the far side serves
   * the recorded acceptance instead of accepting twice — pins the id it derived BEFORE submitting.
   * Validated as an id token; reply correlation still rides the per-publish subject nonce, so two
   * calls pinning one id cannot cross-deliver replies.
   */
  id?: string;
  /** Advisory display name for `from.name`; `from.id` is DERIVED from the caller triple, so it
   *  always equals the broker-authenticated sender principal (§13.3). */
  name?: string;
}

const nonce = (): string => base64url(globalThis.crypto.getRandomValues(new Uint8Array(24))); // 32 tokens of [A-Za-z0-9_-], 192 bits

function subjectTarget(t: EpVerbTarget): EpTarget {
  if (t.mode === "self") return { mode: "self" };
  if (t.mode === "handle" || t.mode === "exact")
    return { mode: t.mode, tOwner: t.owner, tActor: t.actor, tUid: t.lifecycleUid };
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

export function buildRequest(
  space: string,
  route: EpRoute,
  op: EpVerbOp,
  verb: { replyExpected: boolean; deadlineMs?: number },
): { subject: string; requestId: string; n: string; body: Uint8Array } {
  // §13.7: the caller's own contract gates the args BEFORE publish — the same validator and the
  // same budget the responder runs, so a request this boundary admits pins digests the
  // responder can honor or reject, never digests detached from the payload. The args are gated as
  // the responder will parse them: JSON drops a key whose value is undefined, and validating the
  // object itself refused, against an older responder's closed contract, a key that never reaches it.
  let args: Record<string, unknown> | undefined;
  try {
    args = op.args === undefined ? undefined : JSON.parse(JSON.stringify(op.args)) as Record<string, unknown>;
  } catch (e) {
    // A value JSON cannot carry (a BigInt, a cycle, a throwing toJSON) is malformed args that never
    // left this caller: a `not-executed` refusal like the contract check below, never an unknown outcome.
    throw new EpEnvelopeError("bad-request", `args cannot be sent as JSON: ${e instanceof Error ? e.message : String(e)}`, undefined, "not-executed");
  }
  try {
    assertArgsValid(op.contract.input.validate, args);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError)) throw e;
    // Nothing was published, so the refusal is `not-executed` (§13.3). A key the contract does not
    // declare is marked, so a surface that knows both builds can name the version skew.
    const property = op.contract.input.validate.errors?.[0]?.params?.additionalProperty;
    throw new EpEnvelopeError(e.code, e.message, typeof property === "string" ? [{ kind: EP_UNDECLARED_ARG, property }] : undefined, "not-executed");
  }
  // The responder refuses these too (§13.3), but a caller that would emit an unservable request
  // should not have to learn it from a round trip: `describe` is what produces a bind, and a
  // scatter addresses every incarnation, so neither can carry one.
  if (op.bind !== undefined) {
    if (op.command === "describe")
      throw new EpEnvelopeError("bad-request", "describe carries no bind: it is the bootstrap that produces one (SPEC 13.3)");
    if (route.mode === "all")
      throw new EpEnvelopeError("bad-request", "a scatter addresses every incarnation; a bind would make every member but one refuse (SPEC 13.5)");
    if (route.mode === "inst" && op.bind.instanceId !== route.instanceId)
      throw new EpEnvelopeError("bad-request", `bind.instanceId "${op.bind.instanceId}" contradicts the inst-rail route's instance "${route.instanceId}" (SPEC 13.2)`);
  }
  const n = nonce();
  const subject = epRequestSubject(space, {
    route, endpoint: op.endpoint, command: op.command,
    ...(op.target ? { target: subjectTarget(op.target) } : {}),
    caller: op.caller, nonce: n,
  });
  const requestId = op.id !== undefined ? assertIdToken(op.id, "pinned envelope id") : nonce();
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
    ...(op.bind !== undefined ? { bind: { instanceId: assertLifecycleToken(op.bind.instanceId, "bind instanceId"), epoch: op.bind.epoch } } : {}),
    ...(args !== undefined ? { args } : {}),
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
export function assertDeadline(deadlineMs: number, what = "deadlineMs"): number {
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

/** What a liveness probe can establish about ONE frozen instance (§13.5). Only `gone` is an
 *  AFFIRMATIVE fact — the broker itself reporting that the instance holds no subscription on its
 *  own rail. `live` and `unknown` are handled identically by the gather: they license nothing and
 *  the full deadline stands. There is deliberately NO verdict for "its presence entry expired":
 *  a lapsed heartbeat is absence of evidence, and reading absence of evidence as death is how a
 *  slow correct answer becomes a fast wrong one. */
export type EpInstanceLiveness = "gone" | "live" | "unknown";

/**
 * Ask the BROKER whether one instance still holds a subscription on its own `inst` rail (§13.2).
 *
 * A serving incarnation subscribes `ep.inst.<endpoint>.<instanceId>.<command>.>` for every command
 * it serves, so a request published there with a reply-to only the broker can reach either draws
 * the broker's no-responders 503 — an affirmative statement that this instance holds no
 * subscription — or draws nothing at all.
 *
 * NOTHING IS `unknown` BUT A REFUSED PUBLISH, AND NOTHING IS EVER DEATH. A slow broker, a responder
 * that receives the request and declines to answer, and a perfectly healthy instance are
 * indistinguishable from here, and every one of them must keep the caller waiting. A REFUSED
 * PUBLISH IS THE ONE EXCEPTION, and it is a refusal rather than a verdict: `nc.publish` returns
 * normally on a violation, so the permission watch (see {@link openPublishDenialWatch}, registered
 * before the publish and released in the `finally`) races the budget and settles the probe
 * `permission-denied` naming the refused subject as soon as the connection reports it — never a
 * silent `unknown` that consumes the full budget on a permission problem. The failure direction is
 * otherwise the whole safety argument: because only a 503 says anything, a short probe budget can
 * never turn a live instance into a fast `missing` — it can only fail to speed up a dead one.
 *
 * It rides `describe` because §13.7 makes every endpoint serve it and it carries no effect, and it
 * rides as a CAST: the verdict comes from the transport, not from an answer, so nothing is read and
 * an instance whose describe is broken still reads as present.
 */
export async function epProbeInstanceInterest(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  instanceId: string,
  caller: EpCaller,
  opts: { deadlineMs: number },
): Promise<EpInstanceLiveness> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const iId = assertLifecycleToken(instanceId, "instanceId");
  const n = nonce();
  const subject = epRequestSubject(space, { route: { mode: "inst", instanceId: iId }, endpoint, command: "describe", caller, nonce: n });
  const env = {
    v: 1, id: nonce(), op: { endpoint, command: "describe" }, class: "ephemeral",
    replyExpected: false, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor },
  };
  // The SAME reserved sentinel `epCall` uses, for the same reason: no responder holds a publish
  // grant for the `_nr._nr._nr` reply subject (§13.9), so a 503 arriving there is the broker's own
  // control frame and cannot be forged by a recipient that knows the nonce.
  const noRespReplyTo = noRespondersReplyTo(space, caller, n);
  // REGISTER THE PERMISSION WATCH BEFORE THE PUBLISH IT IS WATCHING, and race it against the
  // budget: a refused publish that expired into `unknown` would read a permission problem as "no
  // verdict" and pay the full budget for it — the exact slow masquerade the watch exists to end.
  const denialWatch = openPublishDenialWatch(nc, subject, () => new EpEnvelopeError("permission-denied",
    `the liveness probe for ${endpoint}.${iId} was REFUSED BY THE BROKER, not unanswered: this caller's credential does not authorize publishing to "${subject}" (the instance rail for ${iId}). The instance may be perfectly healthy; the grant is what is missing (SPEC 13.2)`), "probe");
  let sub: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = new Promise<EpInstanceLiveness>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), deadlineMs);
      // A PROBE MUST NEVER BE THE REASON A PROCESS IS STILL RUNNING. Against a LIVE instance no
      // answer ever comes back — the request is a cast and §13.5 forbids the responder replying to
      // one — so this timer runs its full budget on every healthy instance, every time. Wired into
      // `cotal ps` that was measured at 4.0 extra seconds AFTER the last row was printed (12.8s
      // with the probe against 8.8s without it, on a healthy two-manager mesh): the gather had long
      // since finished, and the only verdict that changes anything is `gone`, which a caller who
      // has already gathered can no longer use. Unref makes the timer stop holding the loop open
      // WITHOUT changing the probe: it still settles `unknown` at the budget for anyone still
      // waiting on it, because the connection this needs is itself an open handle, and a caller
      // still using that connection is therefore still running.
      timer.unref?.();
      sub = nc.subscribe(noRespReplyTo, {
        callback: (err, msg) => { resolve(err === null && isNoRespondersMsg(msg) ? "gone" : "unknown"); },
      });
      nc.publish(subject, new TextEncoder().encode(JSON.stringify(env)), { reply: noRespReplyTo });
    });
    // The refusal settles the probe INSTEAD of the budget: raced here, it rejects the await as the
    // thrown `permission-denied` before the deadline can resolve `unknown`. When the 503 or the
    // budget settles first, the finally below releases the watch and a refusal never observed by
    // anyone is never raised.
    return await Promise.race([verdict, denialWatch.denied]);
  } finally {
    sub?.unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    denialWatch.release();
  }
}

/** Race a caller-supplied read against a bounded budget so a never-settling hook cannot exceed the
 *  operation deadline (SPEC 13.5: deadline mandatory). Clears its timer on either outcome. */
export async function raceBounded<T>(read: () => Promise<T> | T, ms: number, what: string, details?: EpErrorDetail[]): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => read())(),
      new Promise<never>((_, reject) => { t = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `${what} did not settle within the ${ms}ms budget (SPEC 13.5)`, details)), ms); }),
    ]);
  } finally { if (t !== undefined) clearTimeout(t); }
}

/** The {@link EP_UNANSWERED} detail for `op`: set ONLY where this module observed that nothing
 *  answered (the broker's no-responders control frame, or the reply deadline elapsing). */
const unansweredDetail = (op: EpVerbOp): EpUnansweredDetail => ({ kind: EP_UNANSWERED, endpoint: op.endpoint, command: op.command, rail: epPlaneTokens(op.caller).join(".") });
/** The {@link EP_REGISTRY_READ_FAILED} detail for `op`: set where the scatter's OWN registry read
 *  (freeze or reconcile) failed, so the failure is never read as the responders' silence. */
export const registryReadDetail = (op: EpVerbOp): EpRegistryReadFailedDetail => ({ kind: EP_REGISTRY_READ_FAILED, endpoint: op.endpoint, command: op.command });

/** The caller's per-request reply subscription: its own rail narrowed to exactly this request's
 *  nonce (contained in the §13.9 reply-read grant), so concurrent calls never see each other. */
export function replySubjectFor(space: string, caller: EpCaller, n: string): string {
  return `${spacePrefix(space)}.${epPlaneTokens(caller).join(".")}.reply.*.*.*.${callerRailTokens(caller).join(".")}.${n}`;
}

/** The reserved no-responders sentinel on the caller's OWN rail (SPEC 13.5/13.9): no responder
 *  holds a publish grant for `_nr._nr._nr`, so only the broker's control frame reaches it. On the
 *  versioned rail the sentinel carries the generation too, inside the caller's read filter. */
function noRespondersReplyTo(space: string, caller: EpCaller, n: string): string {
  return `${spacePrefix(space)}.${epPlaneTokens(caller).join(".")}.reply._nr._nr._nr.${callerRailTokens(caller).join(".")}.${n}`;
}

/** One attributed reply: the structural attribution comes from the reply SUBJECT (§13.2), never
 *  from the body. */
export interface EpAttributedReply {
  reply: EndpointReply;
  responder: { endpoint: string; instanceId: string; epoch: number };
}

/** The stale-epoch refusal, worded by DIRECTION and by what the caller's reference epoch IS, and
 *  carrying the {@link EP_UNBOUND_RESPONDER} marker. Both rails reach it after an ATTRIBUTED reply:
 *  the responder received the request and answered it, at an epoch other than the caller's reference.
 *  The reference has two meanings, and the message must not lend one caller's meaning to the other:
 *  - `bind`: the epoch this caller's own resolve bound (the `inst` rail's pinned epoch, or the
 *    describe-bound default on `one`). `answered > held` means a SUCCESSOR of the bound incarnation
 *    answered (a same-root restart, or a supersession): the caller's handle is the stale side, and
 *    re-resolving adopts the successor. `answered < held` means a superseded incarnation still
 *    connected answered, and its reply is what is rejected.
 *  - `registry`: a currency read of the responder's CURRENT registered epoch (epCall's documented
 *    `currentEpoch` contract, {@link serviceEpochReader}). Nothing of the caller's is stale here:
 *    `answered > current` means the read lags a restart, `answered < current` a superseded
 *    incarnation still answering.
 *  Either way the marker says what the code alone cannot: a retry is a second attempt. The kind is
 *  explicit rather than inferred because a single wording names the wrong stale side on one of the
 *  two paths, whichever meaning it picks. */
function staleEpochRefusal(
  op: EpVerbOp,
  responder: { instanceId: string; epoch: number },
  held: number,
  reference: "bind" | "registry",
  rail: "one" | "inst",
): EpEnvelopeError {
  const who = `the ${op.endpoint} instance ${responder.instanceId}`;
  const ahead = responder.epoch > held;
  const situation = reference === "bind"
    ? (ahead
      ? `${who} answered at epoch ${responder.epoch}, but this handle resolved against it at epoch ${held}: a SUCCESSOR of the bound incarnation answered (a restart or supersession), so the handle is the stale side; re-resolve to adopt it`
      : `${who} answered at epoch ${responder.epoch}, but this handle resolved against it at epoch ${held}: a SUPERSEDED incarnation still connected answered, and its reply is rejected`)
    : (ahead
      ? `${who} answered at epoch ${responder.epoch}, but a currency read of its registered epoch returned ${held}: the responder is ahead of the registry read (the read lags a restart), so its reply is rejected until the read catches up; nothing of this caller's is stale`
      : `${who} answered at epoch ${responder.epoch}, but a currency read of its registered epoch returned ${held}: a SUPERSEDED incarnation still connected answered, and its reply is rejected`);
  const detail: EpUnboundResponderDetail = {
    kind: EP_UNBOUND_RESPONDER, endpoint: op.endpoint, command: op.command, answeredBy: responder.instanceId,
    ...(reference === "bind" ? { boundTo: responder.instanceId } : {}),
    answeredEpoch: responder.epoch, heldEpoch: held, reference, pinned: rail === "inst",
  };
  return new EpEnvelopeError("expired",
    `${situation}. THIS SAYS NOTHING ABOUT WHETHER THE COMMAND RAN: ${responder.instanceId} received the request and answered it, so if "${op.command}" mutates, that effect may already have landed; verify the outcome ('ps'/'inspect'/roster) before re-issuing (SPEC 13.2, the stale-reply rejection rule)`,
    [detail]);
}

export function parseAttributedReply(space: string, subject: string, data: Uint8Array, requestId: string, op: EpVerbOp, expect?: { instanceId?: string; epoch?: number }): EpAttributedReply {
  const parsed = parseEpSubject(subject);
  if (!parsed || parsed.plane !== "reply")
    throw new EpEnvelopeError("internal", `a message on the caller's reply rail does not parse as a reply subject: ${subject}`);
  // SPEC §13.2: ACCEPTANCE binds the subject-borne attribution to the INVOKED identity.
  // Reading the endpoint/instance/epoch off the subject is not the same as checking them against the
  // invocation: a truthfully-attributed reply from a DIFFERENT endpoint (or a stale/other instance)
  // is not the requested responder, and nonce possession is addressing, not authorization. A stale
  // process "publishes attributably stale replies that callers reject" — so the caller rejects here.
  if (parsed.endpoint !== op.endpoint)
    throw new EpEnvelopeError("internal", `reply endpoint "${parsed.endpoint}" is not the invoked endpoint "${op.endpoint}" (SPEC 13.2: the caller binds a reply to the requested identity, never trusts the subject alone)`);
  if (expect?.instanceId !== undefined && parsed.instanceId !== expect.instanceId)
    throw new EpEnvelopeError("internal", `reply instance "${parsed.instanceId}" is not the addressed instance "${expect.instanceId}" (SPEC 13.2)`);
  if (expect?.epoch !== undefined && parsed.epoch !== expect.epoch)
    throw staleEpochRefusal(op, { instanceId: parsed.instanceId, epoch: parsed.epoch }, expect.epoch, "bind", "inst");
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
 * the invoked identity (§13.2, the stale-reply rejection rule: "callers reject" stale-process replies), on BOTH rails:
 *  - `inst` pins the addressed `(instanceId, epoch)` incarnation up front; a stale-epoch reply is
 *    `expired` and a wrong-instance reply `internal`.
 *  - `one` cannot pin an instance up front (the queue picks the responder), so the caller MUST supply
 *    `currentEpoch(instanceId)`: after the reply lands, the answering incarnation's epoch is checked
 *    against its current registry epoch, and a superseded-but-still-connected queue member's reply is
 *    `expired`. The queue winner is NOT implicitly current — that is a check, not an assumption.
 *    `currencyReference` says what that hook returns, for the refusal's wording and marker: the
 *    documented `registry` read (default), or `bind` when a caller supplies its own resolve's epoch
 *    instead (the describe-bound default in {@link invokeCommand}), where a responder ahead of it is
 *    a successor and the caller's handle is the stale side.
 *
 * Application-level failure is NOT a throw: the resolved `reply` carries `ok: false` with the
 * responder's structured error (§13.3). This boundary throws only for its own refusals: invalid args
 * `bad-request`; an unparseable/mis-echoed/mis-attributed reply `internal` (a raw decode error never
 * escapes); a throwing `currentEpoch` hook `internal` and a garbled (non-integer/negative) currency
 * value `failed-precondition` (the read's own failure, never mislabeled staleness); a stale reply `expired`;
 * NO responder `unavailable` (SPEC 13.5, the broker no-responders answer — the broker's no-responders 503 lands on a reply-to that
 * sits on THIS caller's own rail, so a manual, fully-disposed probe distinguishes it from a slow
 * responder without leaving a lingering request); a failed reply subscription `unavailable`; a
 * broker publish violation `permission-denied` naming the refused subject (the connection-status
 * watch that keeps a missing GRANT from reading as an unanswered deadline); the elapsed budget
 * `deadline-exceeded`. Every subscription, timer, and status watch is released in the `finally`.
 */
export async function epCall(
  nc: NatsConnection,
  space: string,
  route: { mode: "one" } | { mode: "inst"; instanceId: string; epoch: number },
  op: EpVerbOp,
  opts: { deadlineMs: number; currentEpoch?: (instanceId: string) => Promise<number> | number; currencyReference?: "bind" | "registry"; signal?: AbortSignal },
): Promise<EpAttributedReply> {
  opts.signal?.throwIfAborted();
  const deadlineMs = assertDeadline(opts.deadlineMs);
  if (route.mode === "one" && opts.currentEpoch === undefined)
    throw new EpEnvelopeError("bad-request", "epCall on the `one` rail requires opts.currentEpoch: the queue winner is not implicitly current, and a superseded-but-connected member's reply must be rejected (SPEC 13.2, the stale-reply rejection rule)");
  const req = buildRequest(space, route, op, { replyExpected: true, deadlineMs });
  const expect = route.mode === "inst" ? { instanceId: route.instanceId, epoch: route.epoch } : undefined;
  // A no-responders reply-to that lands on THIS caller's OWN rail (within its §13.9 read grant, no
  // inbox prefix needed): responders answer on the DERIVED rail, so this sentinel only ever carries
  // the broker's no-responders 503, which our rail subscription observes and disposes with everything
  // else in the finally — no ghost request/subscription/timer survives a successful call.
  const noRespReplyTo = noRespondersReplyTo(space, op.caller, req.n);
  const started = Date.now();
  let sub: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let denialWatch: { denied: Promise<never>; release(): void } | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new EpEnvelopeError("unavailable", `${op.endpoint}.${op.command} observation cancelled; the request may have executed`, undefined, "unknown"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Register denial observation before publishing. Keep subscription and publication in the
    // same promise executor: a closed/draining connection must not strand a rejected reply wait.
    // The broker dropped the publish, so no responder received the command: `not-executed` (§13.3).
    denialWatch = openPublishDenialWatch(nc, req.subject, () => new EpEnvelopeError("permission-denied",
      `the call for ${op.endpoint}.${op.command} was REFUSED BY THE BROKER, not unanswered: this caller's credential does not authorize publishing to "${req.subject}"${route.mode === "inst" ? ` (the instance rail for ${route.instanceId})` : ""}. The responder may be perfectly healthy; the grant is what is missing: the current credential did not authorize this route, command or target, and the broker does not say which (SPEC 13.2)`, undefined, "not-executed"), "call");
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
            if (isNoRespondersMsg(msg)) { reject(new EpEnvelopeError("unavailable", `no responder for ${op.endpoint}.${op.command} (SPEC 13.5)`, [unansweredDetail(op)])); return; }
            reject(new EpEnvelopeError("internal", `a non-503 message reached the reserved no-responders sentinel for ${op.endpoint}.${op.command}; nothing but the broker control frame is addressable there`)); return;
          }
          resolve({ subject: msg.subject, data: msg.data });
        },
      });
      opts.signal?.throwIfAborted();
      nc.publish(req.subject, req.body, { reply: noRespReplyTo });
    });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no reply to ${op.endpoint}.${op.command} within the ${deadlineMs}ms budget (SPEC 13.5)`, [unansweredDetail(op)])), deadlineMs); });
    const msg = await Promise.race([outcome, timeout, denialWatch.denied, cancelled]);
    const attributed = parseAttributedReply(space, msg.subject, msg.data, req.requestId, op, expect);
    // Taken BEFORE the currency check below, because a responder that fenced on the bind settled
    // the same question better: it knows it did not run the command, where the check can only
    // observe that the answer came from elsewhere. Returning the refusal keeps it an ordinary
    // application-level failure (§13.5) that tells the caller a retry is safe, instead of a throw
    // that says nothing about whether the command ran. Cross-checked against the SUBJECT first: a
    // reply attributed to the very incarnation the caller bound cannot coherently claim it is not
    // that incarnation (§13.3).
    // Gated on the marker's PRESENCE, not on the outcome. Whether the caller may act on this
    // refusal is a separate question, settled downstream by `replyRefusedBeforeEffect`; whether the
    // reply is coherent is settled here, and a reply that omits the outcome is no less obliged to
    // agree with its own attribution. Gating both on the same predicate let a refusal buy its way
    // out of the checks by leaving a field off.
    if (attributed.reply.ok === false && bindRefusalMarked(attributed.reply.error)) {
      if (op.bind === undefined)
        throw new EpEnvelopeError("internal", `${op.endpoint}.${op.command} replied with a bind refusal to a request that carried no bind`);
      const r = attributed.responder;
      if (r.instanceId === op.bind.instanceId && r.epoch === op.bind.epoch)
        throw new EpEnvelopeError("internal", `${op.endpoint} instance ${r.instanceId} refused ${op.command} as the wrong incarnation, but the reply subject attributes it to exactly the bound one (${op.bind.instanceId} epoch ${op.bind.epoch}); the body does not get to contradict its own attribution (SPEC 13.3)`);
      // AND THE REFUSAL MUST BE AN ANSWER TO *THIS* REQUEST, FROM *THIS* RESPONDER. THREE CHECKS ARE
      // JOINTLY REQUIRED here — the subject check above, plus `boundTo` and `servedBy` below — and
      // removing any one of them accepts a "did not run" the caller cannot derive. A caller acts on
      // this marker by re-issuing a command it would otherwise never repeat, so it is checked rather
      // than believed: a fence computes it from the request's own bind against its own identity, so
      // both halves are DERIVABLE. A `boundTo` that is not the block this request carried was not
      // computed from this request; a `servedBy` disagreeing with the reply subject is a body
      // contradicting its own attribution. Both are `internal`, not a retry.
      const refusal = (attributed.reply.error?.details ?? []).find((d) => d.kind === EP_BIND_REFUSED) as EpBindRefusedDetail | undefined;
      if (refusal === undefined)
        throw new EpEnvelopeError("internal", `${op.endpoint}.${op.command} came back marked ${EP_BIND_REFUSED} with no such detail to derive it from (SPEC 13.3)`);
      if (refusal.boundTo.instanceId !== op.bind.instanceId || refusal.boundTo.epoch !== op.bind.epoch)
        throw new EpEnvelopeError("internal", `${op.endpoint} refused ${op.command} against bind ${refusal.boundTo.instanceId} epoch ${refusal.boundTo.epoch}, but this request carried ${op.bind.instanceId} epoch ${op.bind.epoch}; a refusal computed from another request proves nothing about this one (SPEC 13.3)`);
      if (refusal.servedBy.instanceId !== r.instanceId || refusal.servedBy.epoch !== r.epoch)
        throw new EpEnvelopeError("internal", `${op.endpoint} refused ${op.command} claiming to be served by ${refusal.servedBy.instanceId} epoch ${refusal.servedBy.epoch}, but the reply subject attributes it to ${r.instanceId} epoch ${r.epoch}; the body does not get to contradict its own attribution (SPEC 13.3)`);
      return attributed;
    }
    if (route.mode === "one") {
      // §13.2, the stale-reply rejection rule currency for the queue winner, bounded by the REMAINING budget so the whole
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
        throw staleEpochRefusal(op, attributed.responder, cur, opts.currencyReference ?? "registry", "one");
    }
    return attributed;
  } finally {
    sub?.unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    denialWatch?.release();
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
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
 *
 * A broker publish refusal is NOT a flushed cast: `nc.publish` returns normally on a violation, so
 * the permission watch (see {@link openPublishDenialWatch}, registered before the publish and
 * released in the `finally`) races the flush, and a refused cast settles `permission-denied`
 * naming the refused subject as soon as the connection reports it — never a resolution the caller
 * could read as "it was cast". Nothing is added to the healthy path: a permitted publish is
 * unaffected and the flush round-trip stands as the settling time.
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
  // REGISTER THE PERMISSION WATCH BEFORE THE PUBLISH IT IS WATCHING, and race it against the
  // flush: a refused cast that resolved with the flush would be the exact success masquerade the
  // watch exists to eliminate, and the caller has no reply or deadline of its own to notice
  // otherwise. The refusal is not wall-clock latency: the broker writes the permission ERROR
  // before the PONG that answers the flush, so the violation is already on the connection when
  // the flush resolves — but its dispatch to this race rides a longer microtask chain than the
  // flush's own continuation, and `Promise.race` would hand the flush the win on arrival order
  // alone. Chaining ONE EVENT-LOOP TURN (`setImmediate`, not a timer) after the flush lets that
  // chain complete first: a refused publish rejects deterministically, and a permitted one
  // settles on the next loop turn — the flush round-trip remains the entire cost.
  const denialWatch = openPublishDenialWatch(nc, req.subject, () => new EpEnvelopeError("permission-denied",
    `the cast for ${op.endpoint}.${op.command} was REFUSED BY THE BROKER, not cast: this caller's credential does not authorize publishing to "${req.subject}". The responder may be perfectly healthy; the grant is what is missing (SPEC 13.2)`), "cast");
  try {
    nc.publish(req.subject, req.body);
    await Promise.race([
      nc.flush().then(() => new Promise<void>((resolve) => setImmediate(resolve))),
      denialWatch.denied,
    ]);
  } finally {
    denialWatch.release();
  }
}
