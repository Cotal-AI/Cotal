// The control plane and service-invocation region of CotalEndpoint, as an internal component. Moved
// verbatim from endpoint.ts; the endpoint keeps the public methods and forwards to them. Not
// re-exported by the index.
import { randomUUID } from "node:crypto";
import { ClosedConnectionError, type Msg, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import { withDeadline } from "./deadline.js";
import { isFromSubjectSender, type CotalEndpoint } from "./endpoint.js";
import { resolveService, invokeCommand, goalFollowRefusal, submitAndFollowGoal, BIND_SPLIT_REISSUES, type ResolvedService, type SubmitAndFollowGoalOptions } from "./endpoint-invoke.js";
import type { GoalResultFact } from "./endpoint-action.js";
import { EpEnvelopeError, respondedButUnbound, replyRefusedBeforeEffect, replyTargetUnmapped, EP_BIND_REFUSED, type EpBindRefusedDetail } from "./endpoint-envelope.js";
import { isRepeatSafeCommand } from "./endpoint-grants.js";
import type { EpCaller, IssuedCaller } from "./endpoint-subjects.js";
import { REGISTRY_ENDPOINT, REGISTRY_ENDPOINTS_COMMAND, type RegistryEndpointsInput, type RegistryEndpointsOutput } from "./registry-contract.js";
import { listRegistryEndpoints, registryListingCaller } from "./registry-client.js";
import type { EpVerbTarget, EpAttributedReply } from "./endpoint-verbs.js";
import { controlServiceSubject, parseSubject } from "./subjects.js";
import type { ControlReply, ControlRequest, ControlRequestInit, EndpointRef } from "./types.js";

/** One goal follower {@link EndpointControlPlane.followServiceGoal} registers with its endpoint. */
type GoalFollower = { cancel: () => void; reconnected: (nc: NatsConnection) => void };

/** What the control plane reads from its endpoint. State is read when it is used, never copied, and
 *  every method is looked up on the endpoint at call time. */
export interface EndpointControlPlaneDeps {
  nc: () => NatsConnection | undefined;
  space: () => string;
  owner: () => string;
  actor: () => string;
  stopped: () => boolean;
  authed: () => boolean;
  connId: () => string;
  presentedExp: () => number | undefined;
  issuedGeneration: () => string | undefined;
  acceptedToken: () => string | undefined;
  rebuildPromise: () => Promise<void> | undefined;
  subs: () => Subscription[];
  resolvedServices: () => Map<string, ResolvedService>;
  resolvedCommandServices: () => Map<string, Map<string, ResolvedService>>;
  serviceInvocations: () => WeakMap<NatsConnection, Set<Promise<void>>>;
  requestsAwaitingReply: () => Map<NatsConnection, Set<(error: Error) => void>>;
  activeGoalFollowers: () => Set<GoalFollower>;
  splitsRecovered: () => number;
  setSplitsRecovered: (count: number) => void;
  notLiveMsg: () => string;
  requireLifecycleUid: (what: string) => string;
  reportSubscriptionDenial: (error: unknown) => boolean;
  ref: () => EndpointRef;
  reconnect: () => Promise<void>;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** The request/reply control plane of one endpoint (serve, answer and request control, with the
 *  bound reply every request rides) and its service-invocation client (describe, list, invoke,
 *  and follow a goal). Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointControlPlane {
  constructor(private readonly deps: EndpointControlPlaneDeps) {}

  private get nc() { return this.deps.nc(); }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get stopped() { return this.deps.stopped(); }
  private get authed() { return this.deps.authed(); }
  private get connId() { return this.deps.connId(); }
  private get presentedExp() { return this.deps.presentedExp(); }
  private get issuedGeneration() { return this.deps.issuedGeneration(); }
  private get acceptedToken() { return this.deps.acceptedToken(); }
  private get rebuildPromise() { return this.deps.rebuildPromise(); }
  private get subs() { return this.deps.subs(); }
  private get resolvedServices() { return this.deps.resolvedServices(); }
  private get resolvedCommandServices() { return this.deps.resolvedCommandServices(); }
  private get serviceInvocations() { return this.deps.serviceInvocations(); }
  private get requestsAwaitingReply() { return this.deps.requestsAwaitingReply(); }
  private get activeGoalFollowers() { return this.deps.activeGoalFollowers(); }
  private get splitsRecovered() { return this.deps.splitsRecovered(); }
  private set splitsRecovered(count: number) { this.deps.setSplitsRecovered(count); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private requireLifecycleUid(what: string) { return this.deps.requireLifecycleUid(what); }
  private reportSubscriptionDenial(error: unknown) { return this.deps.reportSubscriptionDenial(error); }
  private ref() { return this.deps.ref(); }
  private reconnect() { return this.deps.reconnect(); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  /** Serve control requests for a service. Returns the subscription so a caller that re-registers on
   *  reconnect (the delivery daemon) can drop the stale one. `boundReply` is REQUIRED for any service
   *  whose responder holds a wildcard publish grant over the service subtree (the delivery daemon's
   *  `ctl.delivery.*.*.reply.>`): without it, an authenticated caller could set its reply target to a
   *  PEER's reply lane (`ctl.delivery.<victim>.reply.<n>`) and turn the responder into a confused
   *  deputy — the broker does NOT permission-check the requester's embedded reply subject. With it, a
   *  reply is published only when `m.reply` is under the AUTHENTICATED request subject
   *  (`${m.subject}.reply.…`), binding the reply to the broker-policed sender token.
   *
   *  Requests are answered one at a time, in arrival order. A request `concurrent` accepts is answered
   *  in its own time instead: it waits for none of the requests in front of it, including one still
   *  running, and holds up none behind it. Only for a request that shares no state with the service's
   *  other requests. */
  serveControl(
    service: string,
    handler: (req: ControlRequest) => Promise<ControlReply> | ControlReply,
    opts: { boundReply?: boolean; concurrent?: (req: ControlRequest) => boolean } = {},
  ): import("@nats-io/transport-node").Subscription {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const sub = this.nc.subscribe(controlServiceSubject(this.space, service, "*", "*"), {
      queue: service,
    });
    this.subs.push(sub);
    const inOwnTime = opts.concurrent;
    // With `concurrent`, the in-order requests are answered one after another on this chain, and the
    // reading below never waits on it, so a request answered in its own time is read and answered
    // while an in-order one is still running.
    let inOrder: Promise<void> = Promise.resolve();
    void (async () => {
      for await (const m of sub) {
        // Sender-bound reply guard (confused-deputy fix): never respond to a reply target outside the
        // authenticated request subject's own `.reply.` subtree. Drop silently (don't inject elsewhere).
        if (opts.boundReply && (!m.reply || !m.reply.startsWith(`${m.subject}.reply.`))) {
          this.emit("error", new Error(`rejected ${service} request on ${m.subject}: reply target "${m.reply ?? "(none)"}" is not under the sender's own reply subtree`));
          continue;
        }
        const answer = () => this.answerControl(service, handler, m);
        if (inOwnTime === undefined) {
          await answer();
          continue;
        }
        let own = false;
        try { own = inOwnTime(m.json<ControlRequest>()); } catch { /* unreadable: answered in order, as a refusal */ }
        if (own) void answer().catch((e) => this.emit("error", e as Error));
        else inOrder = inOrder.then(answer).catch((e) => { this.emit("error", e as Error); });
      }
    })().catch((e) => {
      if (!this.reportSubscriptionDenial(e)) this.emit("error", e as Error);
    });
    return sub;
  }

  /** Answer one control request for {@link serveControl}: the sender guard, the handler, and the reply. */
  private async answerControl(
    service: string,
    handler: (req: ControlRequest) => Promise<ControlReply> | ControlReply,
    m: import("@nats-io/transport-node").Msg,
  ): Promise<void> {
    let body: string;
    try {
      let reply: ControlReply;
      const req = m.json<ControlRequest>();
      // Authenticity guard (fail closed): control is the most privileged surface
      // (start/stop). The sender is encoded in the subject (ctl.<svc>.<sender>), which
      // the server policed who could publish; the payload `from` is advisory and must
      // match. Reject before the handler acts on a request claiming a forged sender.
      const parsed = parseSubject(m.subject);
      if (!parsed || !isFromSubjectSender(req, parsed)) {
        this.emit(
          "error",
          new Error(
            `rejected control request on ${m.subject}: from ${req.from?.id ?? "(none)"} ` +
              `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
          ),
        );
        reply = { ok: false, error: "sender mismatch - request rejected" };
      } else {
        reply = await handler(req);
      }
      body = JSON.stringify(reply);
    } catch (e) {
      body = JSON.stringify({ ok: false, error: (e as Error).message } satisfies ControlReply);
    }
    try {
      m.respond(body);
    } catch (e) {
      // `respond` signals a missing reply inbox by returning false; it throws when the reply exceeds the
      // broker's `max_payload`. Silence would leave the caller a bare timeout it cannot tell apart from
      // a dead service.
      const refused: ControlReply = { ok: false, error: `the ${service} reply is ${Buffer.byteLength(body)} bytes and was not published: ${(e as Error).message}` };
      try {
        m.respond(JSON.stringify(refused));
      } catch (err) {
        this.emit("error", new Error(`could not answer ${service} request on ${m.subject}: ${refused.error}, and the refusal failed too: ${(err as Error).message}`));
      }
    }
  }

  /** Keep native named-reply and NoResponders handling, but settle when its connection closes:
   *  nats.js can close a no-mux subscription without settling its request. One close observer per
   *  connection avoids retaining a closed-promise callback for every completed request. */
  async requestBoundReply(nc: NatsConnection, subject: string, body: string, reply: string, timeoutMs: number): Promise<Msg> {
    let pending = this.requestsAwaitingReply.get(nc);
    if (!pending) {
      const waiting = new Set<(error: Error) => void>();
      this.requestsAwaitingReply.set(nc, waiting);
      void nc.closed().then((error) => {
        this.requestsAwaitingReply.delete(nc);
        const failure = error ?? new ClosedConnectionError();
        for (const reject of waiting) reject(failure);
        waiting.clear();
      });
      pending = waiting;
    }
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject;
      pending.add(reject);
    });
    try {
      return await Promise.race([
        nc.request(subject, body, { timeout: timeoutMs, noMux: true, reply }),
        closed,
      ]);
    } finally {
      pending.delete(rejectClosed);
    }
  }

  /** Send a control request to a service and await its reply (client side). Like {@link requestDelivery},
   *  the reply rides a BOUNDED subject UNDER the request subject (`ctl.<service>.<id>.reply.<uuid>`), not
   *  the per-id `_INBOX`.
   *  `noMux` lets us name the reply subject while keeping NoResponders detection. The random suffix is
   *  defense-in-depth (a predictable suffix would let a peer target an in-flight named reply sub). The
   *  reply sits under the sender's OWN request subject, so the responder's `boundReply` guard accepts it. */
  async requestControl(
    service: string,
    req: ControlRequestInit,
    timeoutMs = 5000,
  ): Promise<ControlReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = controlServiceSubject(this.space, service, this.owner, this.actor);
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    const body: ControlRequest = { ...req, from: req.from ?? this.ref() };
    const m = await this.requestBoundReply(this.nc, reqSubject, JSON.stringify(body), reply, timeoutMs);
    return m.json<ControlReply>();
  }

  /** The caller this connection's endpoint requests ride as: the legacy triple, or the issued
   *  caller with its discovered generation (SPEC 13.15). It names the reply rail this connection's
   *  credential reads, which is where a manager's turn notice for it lands (SPEC 14.3). */
  serviceRailCaller(): EpCaller {
    return this.serviceCaller();
  }

  /** This endpoint's v0.4 caller triple (§13.2) — the identity its minted ep-rail rows pin. The
   *  owner/actor principal is mode-correct by construction (static: DEV_OWNER + the connection
   *  identity; user mode: the bearer's callout-derived pair), and the lifecycle UID is the
   *  launcher-supplied incarnation the rows are keyed on (ledger-consistent: the §13.1 presence
   *  lifecycle-proof refuses a divergent uid before any publish). */
  private serviceCaller(): EpCaller {
    const triple = { owner: this.owner, actor: this.actor, uid: this.requireLifecycleUid("invokeService") };
    if (this.acceptedToken === undefined) return triple;
    if (this.issuedGeneration === undefined) throw new Error("invokeService: the issued generation is not yet discovered on this connection");
    return { ...triple, generation: this.issuedGeneration } as IssuedCaller;
  }

  /** Follow this caller's goal on its standing connection, subscribing before submission.
   *  A submitter may use a separate short-lived control credential for the same caller triple;
   *  the accepted action's readiness budget can outlive that credential. This endpoint retains
   *  its existing credential renewal and caller-scoped progress grants. */
  async followServiceGoal(
    endpoint: string,
    submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
    deadlineMs = 10_000,
    opts: Pick<SubmitAndFollowGoalOptions, "reconcile" | "signal" | "prepare"> = {},
  ): Promise<EpAttributedReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    if (this.stopped) throw new Error("endpoint stopped - cannot follow goal");
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    let reconnectHandler: ((nc: NatsConnection) => void) | undefined;
    const entry = {
      cancel: () => abortController.abort(),
      reconnected: (nc: NatsConnection) => reconnectHandler?.(nc),
    };
    this.activeGoalFollowers.add(entry);
    try {
      const reconcile: NonNullable<SubmitAndFollowGoalOptions["reconcile"]> = opts.reconcile ?? (async (goalId, _attributed, context) => {
        const current = this.serviceCaller();
        if (current.owner !== context.caller.owner || current.actor !== context.caller.actor || current.uid !== context.caller.uid)
          throw new Error("the renewed goal reader no longer has the accepting caller's full identity");
        // Static callers retain their authorized class route; knowing an instance id grants no rights.
        const q = await this.invokeService(endpoint, "goal-result", { goalId }, {
          deadlineMs: Math.min(deadlineMs, context.deadlineMs), signal: context.signal,
        });
        if (q.reply.ok !== true) throw new Error(q.reply.error.message);
        return q.reply.data as { goalId: string; result?: GoalResultFact } | undefined;
      });
      return await submitAndFollowGoal(this.nc, this.space, endpoint, this.serviceCaller(), deadlineMs, submit, {
        reconcile,
        currentNc: () => this.nc,
        onReconnect: (cb) => {
          reconnectHandler = cb;
          return () => { reconnectHandler = undefined; };
        },
        signal: abortController.signal,
        prepare: opts.prepare,
      });
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      this.activeGoalFollowers.delete(entry);
    }
  }

  /** Drop every cached handle for one endpoint after refresh or a currency split. */
  private clearResolvedService(endpoint: string): void {
    this.resolvedServices.delete(endpoint);
    this.resolvedCommandServices.delete(endpoint);
  }

  /** Hold connection recovery through the whole pre-acceptance phase, including the progress
   *  subscription flush. Release on setup failure or the command's answer, never on goal terminal. */
  private beginServiceInvocation(nc: NatsConnection): () => void {
    let pending = this.serviceInvocations.get(nc);
    if (!pending) {
      pending = new Set();
      this.serviceInvocations.set(nc, pending);
    }
    let settle!: () => void;
    const request = new Promise<void>((resolve) => { settle = resolve; });
    pending.add(request);
    return () => { pending.delete(request); settle(); };
  }

  private async waitServiceRecovery(recovery: Promise<void>, deadline: number, signal: AbortSignal | undefined, timeout: () => Error): Promise<void> {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await withDeadline(Promise.race([recovery, cancelled]), deadline - Date.now(), timeout);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    signal?.throwIfAborted();
    if (deadline <= Date.now()) throw timeout();
  }

  /** The resolved, digest-verified command surface of `endpoint` as this connection's caller sees
   *  it. Unpinned calls cache the complete discovery surface, and `refresh` drops both the full
   *  handle and any command-specific invocation handles. `instanceId` selects one instance without
   *  reading or populating either class cache, as a pinned invoke does. The caller's existing
   *  credential must permit that route. */
  async describeService(endpoint: string, opts: { deadlineMs?: number; signal?: AbortSignal; refresh?: boolean; instanceId?: string } = {}): Promise<ResolvedService> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    if (opts.refresh) this.clearResolvedService(endpoint);
    const cached = opts.instanceId === undefined ? this.resolvedServices.get(endpoint) : undefined;
    if (cached) return cached;
    const svc = await resolveService(this.nc, this.space, endpoint, this.serviceCaller(), { deadlineMs: opts.deadlineMs ?? 10_000, signal: opts.signal, ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}) });
    if (opts.instanceId === undefined) this.resolvedServices.set(endpoint, svc);
    return svc;
  }

  /** The caller a registry listing rides (SPEC 13.15). An issued connection lists as itself. Any
   *  other connection reads the listing generation the issuer bound to the credential it presented,
   *  under the token its connection id and that credential's expiry derive. `undefined`: that
   *  credential carries no listing binding, because it predates listing issuance or has no expiry. */
  async listingCaller(): Promise<IssuedCaller | undefined> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    return registryListingCaller(this.nc, this.space, this.serviceCaller(), { connId: this.connId, ...(this.presentedExp !== undefined ? { exp: this.presentedExp } : {}) });
  }

  /** One page of the registry's `endpoints` answer (SPEC 13.20) over this connection
   *  ({@link listRegistryEndpoints}). The describe rides this connection's own caller; the question
   *  rides the listing caller on an authed mesh. `unbound`: this credential carries no listing
   *  binding. */
  async listEndpoints(input: RegistryEndpointsInput, opts: { deadlineMs?: number; signal?: AbortSignal } = {}): Promise<
    | { unbound: true }
    | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }
  > {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const nc = this.nc;
    const listing = this.authed ? await this.listingCaller() : undefined;
    if (this.authed && listing === undefined) return { unbound: true };
    return this.listEndpointsOver(nc, listing, input, opts);
  }

  /** Ask the registry over `nc` under `listing`: this connection, or another of this caller triple
   *  such as a manager-call connection. The describe rides this connection, whose view holds the
   *  registry's describe. Every endpoint the page lists has its cached describe dropped, so the next
   *  describe of it reads the surface afresh. `unbound`: the broker refused the question under
   *  `listing`, whose credential holds no listing row. */
  async listEndpointsOver(
    nc: NatsConnection,
    listing: IssuedCaller | undefined,
    input: RegistryEndpointsInput,
    opts: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ unbound: true } | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const own = this.nc;
    const result = await listRegistryEndpoints(this.space, (deadlineMs, signal) => resolveService(own, this.space, REGISTRY_ENDPOINT, this.serviceCaller(), {
      deadlineMs, signal, commands: [REGISTRY_ENDPOINTS_COMMAND],
    }), { nc, ...(listing ? { caller: listing } : {}) }, input, opts);
    if (result.unbound) return result;
    for (const row of result.page?.rows ?? []) this.clearResolvedService(row.endpoint);
    return result;
  }

  /** GENERIC v0.4 service invoke over this endpoint's own connection: resolve
   *  the named endpoint's registered surface — describe, §13.7 store fetch, digest-verified
   *  recompile ({@link resolveService}; cached per endpoint name) — and invoke one command. The
   *  resolve is describe-bound currency, and a call that reaches the wrong incarnation is recovered
   *  two ways depending on WHO caught it — the difference between knowing the command did not run
   *  and only knowing someone answered:
   *   - the RESPONDER fenced it on the request's `bind` (§13.2, an `ok:false` reply marked
   *     {@link replyRefusedBeforeEffect}): the command did not run, so the bind is dropped and the
   *     call re-issued for any command, up to {@link BIND_SPLIT_REISSUES} times while each re-issue
   *     is refused the same way. If a re-issue cannot be resolved, the refusal
   *     surfaces — still saying the command did not run — naming the resolve failure as why the
   *     repair could not be attempted. An unpinned targeted call that reached a member holding no
   *     mapping for its target ({@link replyTargetUnmapped}) is repaired the same way, and when the
   *     re-issues run out, the latest such refusal is the one surfaced.
   *   - this CLIENT caught it on the reply ({@link respondedButUnbound}: a different instance,
   *     `failed-precondition`; the same instance at any other epoch, `expired`), which is what a
   *     responder too old to know the field produces. A live instance received and answered it, so
   *     the bind is dropped but the call is re-issued only for a command on the
   *     {@link isRepeatSafeCommand} allowlist; anything else surfaces, since a second attempt could
   *     duplicate its effect.
   *  A broker permission refusal marked `not-executed` rebuilds the connection and retries once
   *  within the original deadline. A second refusal stands. Responder errors and calls that may
   *  have run never trigger this repair.
   *  Errors from the responder come back structurally on the attributed reply
   *  (`reply.ok === false`); transport/validation refusals throw {@link EpEnvelopeError}. */
  async invokeService(
    endpoint: string,
    command: string,
    args?: Record<string, unknown>,
    opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: boolean; signal?: AbortSignal; instanceId?: string; classInstanceId?: string } = {},
  ): Promise<EpAttributedReply> {
    const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
    const rebuilding = this.rebuildPromise;
    if (rebuilding) {
      await this.waitServiceRecovery(rebuilding, deadline, opts.signal,
        () => new EpEnvelopeError("deadline-exceeded", "the invocation deadline elapsed waiting for connection recovery", undefined, "not-executed"));
      opts = { ...opts, deadlineMs: deadline - Date.now() };
    }
    const nc = this.nc;
    if (!nc) throw new Error(this.notLiveMsg());
    try {
      return await this.invokeServiceOnce(endpoint, command, args, opts, rebuilding ? deadline : undefined);
    } catch (e) {
      if (!(e instanceof EpEnvelopeError) || e.code !== "permission-denied" || e.outcome !== "not-executed"
        || deadline <= Date.now()) throw e;
      opts.signal?.throwIfAborted();
      const recovery = (async () => {
        // Re-read the live set: calls admitted while earlier ones settle must keep their replies.
        // The empty check and rebuild admission have no await between them. Later calls wait on
        // rebuildPromise instead of publishing on the connection being replaced.
        for (;;) {
          opts.signal?.throwIfAborted();
          if (deadline <= Date.now()) throw e;
          const pending = this.serviceInvocations.get(nc);
          if (!pending?.size) break;
          await Promise.allSettled([...pending]);
        }
        if (this.nc === nc) await this.reconnect();
        else await this.rebuildPromise;
      })();
      await this.waitServiceRecovery(recovery, deadline, opts.signal, () => e);
      this.clearResolvedService(endpoint);
      return this.invokeServiceOnce(endpoint, command, args, { ...opts, deadlineMs: deadline - Date.now() }, deadline);
    }
  }

  private async invokeServiceOnce(
    endpoint: string,
    command: string,
    args: Record<string, unknown> | undefined,
    opts: Parameters<CotalEndpoint["invokeService"]>[3] = {},
    retryDeadline?: number,
  ): Promise<EpAttributedReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const nc = this.nc;
    const caller = this.serviceCaller();
    const resolve = async (signal = opts.signal, deadlineMs = opts.deadlineMs ?? 10_000): Promise<ResolvedService> => {
      signal?.throwIfAborted();
      if (retryDeadline !== undefined) deadlineMs = Math.min(deadlineMs, retryDeadline - Date.now());
      if (deadlineMs <= 0) throw new EpEnvelopeError("deadline-exceeded", "the invocation deadline elapsed before resolve", undefined, "not-executed");
      const needed = opts.follow ? [command, "goal-result"] : [command];
      const classSelected = opts.instanceId === undefined && opts.classInstanceId === undefined;
      const full = classSelected ? this.resolvedServices.get(endpoint) : undefined;
      if (full && needed.every((name) => full.commands.has(name))) return full;
      const cacheKey = [...needed].sort().join("\u0000");
      const commandCache = classSelected ? this.resolvedCommandServices.get(endpoint) : undefined;
      const cached = commandCache?.get(cacheKey);
      if (cached) return cached;
      const svc = await resolveService(nc, this.space, endpoint, caller, {
        deadlineMs,
        signal,
        commands: needed,
        ...(opts.follow && command !== "goal-result" ? { optionalCommands: ["goal-result"] } : {}),
        ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
        ...(opts.classInstanceId !== undefined ? { classInstanceId: opts.classInstanceId } : {}),
      });
      // Pinned resolves never enter either class cache. Narrow unpinned handles stay in their own
      // command-set cache, so they cannot truncate discovery or evict another command's handle.
      if (classSelected) {
        let byCommand = this.resolvedCommandServices.get(endpoint);
        if (!byCommand) {
          byCommand = new Map();
          this.resolvedCommandServices.set(endpoint, byCommand);
        }
        byCommand.set(cacheKey, svc);
      }
      return svc;
    };
    const invokeOpts = { ...(opts.target ? { target: opts.target } : {}), ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}) };
    const invokeResolved = (service: ResolvedService, signal?: AbortSignal): Promise<EpAttributedReply> => {
      signal?.throwIfAborted();
      const unfollowable = opts.follow ? goalFollowRefusal(service) : undefined;
      if (unfollowable) return Promise.resolve(unfollowable);
      const deadlineMs = retryDeadline === undefined ? invokeOpts.deadlineMs : retryDeadline - Date.now();
      if (deadlineMs !== undefined && deadlineMs <= 0)
        throw new EpEnvelopeError("deadline-exceeded", "the invocation deadline elapsed before publish", undefined, "not-executed");
      return invokeCommand(nc, this.space, service, command, args, { ...invokeOpts, deadlineMs, signal });
    };
    // A `failed-precondition` from the resolve is its own refusal, raised before any command was
    // published, so resolving once more is a repair. The repair spends what is left of the same
    // deadline, and with nothing left the refusal stands.
    const resolveFirst = async (signal = opts.signal, deadline = Date.now() + (opts.deadlineMs ?? 10_000)): Promise<ResolvedService> => {
      try {
        return await resolve(signal, deadline - Date.now());
      } catch (e) {
        if (!(e instanceof EpEnvelopeError) || e.code !== "failed-precondition") throw e;
        const left = deadline - Date.now();
        if (left <= 0) throw e;
        return await resolve(signal, left);
      }
    };
    const doInvoke = async (service: ResolvedService, signal = opts.signal): Promise<EpAttributedReply> => {
      signal?.throwIfAborted();
      try {
        let r = await invokeResolved(service, signal);
        // THE RESPONDER FENCED IT (§13.2 `ai.cotal.ep.bind-refused`): a class member saw the call
        // was bound to a different incarnation and refused BEFORE running the command.
        //
        // Handled here rather than below because it arrives as an ordinary `ok:false` REPLY, not a
        // throw, so the `respondedButUnbound` recovery never sees it — a long-lived client would
        // otherwise keep its stale bind and meet the same refusal forever.
        //
        // The re-issue is NOT gated on {@link isRepeatSafeCommand}: the responder states the command
        // did not run, so each re-issue is a FIRST attempt, not a second. It repeats up to the bound
        // the CLI uses, because the re-issue rides the same class queue and splits again at the same
        // rate; repairing once left a quarter of all calls in a two-manager space failing (#443).
        // A member that holds no mapping for the target also ran nothing, and on the class rail a
        // sibling may host it. A pinned call named its instance, so that refusal is its answer.
        // That member looked the target up, so when the re-issues run out its refusal is surfaced
        // in place of a trailing bind refusal, which says nothing about the target.
        const unmappedHere = (x: EpAttributedReply) => opts.instanceId === undefined && replyTargetUnmapped(x.reply.error);
        let unmapped = unmappedHere(r) ? r : undefined;
        for (let reissues = 0; reissues < BIND_SPLIT_REISSUES && r.reply.ok === false
          && (replyRefusedBeforeEffect(r.reply.error) || unmappedHere(r)); reissues++) {
          // Counted before it is repaired: a recovery that leaves no trace takes the split rate with it.
          this.splitsRecovered++;
          // `boundTo` is the other half of `servedBy`: who the handle THOUGHT it was talking to,
          // against who actually answered. Without it a listener sees that a split was recovered
          // but not which bind went stale, so it cannot tell one handle's repeated staleness from
          // splits spread across many — and that is the difference between a handle to drop and a
          // class that is churning.
          this.emit("split-recovered", {
            endpoint, command, servedBy: r.responder, splitsRecovered: this.splitsRecovered,
            boundTo: (r.reply.error.details ?? []).find(
              (d): d is EpBindRefusedDetail => d.kind === EP_BIND_REFUSED,
            )?.boundTo,
          });
          this.clearResolvedService(endpoint);
          // A FAILED RE-ISSUE RETHROWS THE ORIGINAL REFUSAL, not the resolve error: if the endpoint
          // has since retired, the resolve times out and the caller would otherwise get `no describe
          // reply within 10000ms` — about a describe it never asked for — losing the one fact that
          // says its handle is stale AND that nothing ran. The resolve failure is named as the
          // reason the repair could not be attempted.
          //
          // The code must be the refusal's own (`failed-precondition` for a different instance,
          // `expired` for the same instance at ANY other epoch — the fence does not compare
          // direction, so a superseded incarnation still answering produces it too); the marker on
          // any other code is incoherent, so it is rejected rather than trusted (§13.3).
          const raw = r.reply.error.code;
          const refusalCode = raw === "expired" ? ("expired" as const)
            : raw === "failed-precondition" ? ("failed-precondition" as const) : undefined;
          if (refusalCode === undefined)
            throw new EpEnvelopeError("internal", `${endpoint}.${command} came back marked as refused before it ran, but with code ${String(raw)}; the fence produces only failed-precondition or expired (SPEC 13.2)`, r.reply.error.details);
          // ONLY THE RESOLVE IS WRAPPED — do not widen this `try` to cover the re-issue. A re-issue
          // that PUBLISHED AND RAN can still throw (an unfenced responder answers and the post-reply
          // currency check raises `respondedButUnbound`); wrapping that as the first hop's refusal
          // would hand the caller `WAS NOT RUN` for a command that executed, and its next attempt
          // would be a second one believing it was the first. A re-issue that fails on its own terms
          // must propagate its OWN error, because `respondedButUnbound` asserts the opposite of what
          // the fence's marker does: a responder answered and the effect may have landed.
          let reissueTarget;
          try {
            reissueTarget = await resolve(signal);
            const unfollowable = opts.follow ? goalFollowRefusal(reissueTarget) : undefined;
            if (unfollowable) throw new Error(unfollowable.reply.error.message);
          } catch (reissue) {
            throw new EpEnvelopeError(
              refusalCode,
              `${endpoint}.${command} WAS NOT RUN - the incarnation that received it refused it before any effect, and the re-issue could not be resolved: ${reissue instanceof Error ? reissue.message : String(reissue)}. Re-resolve and re-issue when the endpoint is reachable (SPEC 13.2)`,
              r.reply.error.details,
              // §13.3: the message asserts the command did not run, so the FIELD a caller keys on
              // must assert it too. Omitted, it MUST be read as `unknown`, which is the opposite of
              // what this path knows: the responder fenced the call before any effect and the
              // re-issue never went out. Prose is for the reader; this is for the machine.
              "not-executed",
            );
          }
          r = await invokeResolved(reissueTarget, signal);
          if (unmappedHere(r)) unmapped = r;
        }
        return replyRefusedBeforeEffect(r.reply.error) ? unmapped ?? r : r;
      } catch (e) {
        // DO NOT auto-retry a command a responder already ANSWERED. This path covers the responders
        // WITHOUT the fence above: they ignore `bind`, run the command, and the error is raised
        // afterwards, so core cannot tell a repair from a duplicate and the allowlist is the only
        // guard left. (`failed-precondition` here is not only supersession — it also fires when a
        // DIFFERENT live instance wins the class queue and replies, an ordinary split.)
        //
        // Dropping the retry outright is not an option: in a two-manager space roughly half of all
        // class-queue calls split, so every other `ps` would surface an error this absorbs, and
        // re-running a read costs nothing.
        //
        // So it is gated on an ALLOWLIST (`REPEAT_SAFE_COMMANDS`), keyed by ENDPOINT because this
        // method is endpoint-agnostic. Polarity matters more than membership: an allowlist fails
        // CLOSED. Not a `GOAL_BEARING_COMMANDS`-only gate — `purge` is neither goal-bearing nor
        // convergent, and its second run deletes messages published after the first completed, so
        // the boundary is "changes anything", which core cannot see: commands carry no idempotency
        // declaration and every manager command shares `class: "ephemeral"`.
        //
        // Keyed on the MARKER, not the error code, because the same fact has two producers: a
        // DIFFERENT instance answering (`failed-precondition`) and the SAME instance at ANY OTHER
        // EPOCH (`expired`) — epoch inequality, not "a successor", so a superseded incarnation
        // still answering produces it too. Same rule for both, or a long-lived client stays bound
        // to a dead epoch while every call reaches whoever is actually there.
        if (respondedButUnbound(e)) {
          // Drop the stale bind FIRST, whichever way this goes: it names an incarnation that is not
          // the one answering, so every later call would reuse it and meet the same refusal. This is
          // not a retry — nothing is re-issued by it, and for a command that is not repeat-safe the
          // next call is the caller's, made after it has verified.
          this.clearResolvedService(endpoint);
          if (!isRepeatSafeCommand(endpoint, command)) throw e;
          return await invokeResolved(await resolve(signal), signal);
        }
        throw e;
      }
    };
    // A goal-bearing command (spawn/launch) follows its acceptance to the terminal so
    // the caller still returns on the real outcome (UX unchanged); every other command replies directly.
    const release = this.beginServiceInvocation(nc);
    try {
      if (!opts.follow) return await doInvoke(await resolveFirst());
      // Resolve and confirm observation before submission. Hold the barrier continuously across
      // both phases, then release when the command answers so accepted goals can outlive recovery.
      let service: ResolvedService;
      return await this.followServiceGoal(endpoint, async (signal) => {
        try { return await doInvoke(service, signal); }
        finally { release(); }
      }, opts.deadlineMs ?? 10_000, {
        signal: opts.signal,
        prepare: async (signal, deadline) => { service = await resolveFirst(signal, deadline); },
      });
    } finally {
      release();
    }
  }
}
