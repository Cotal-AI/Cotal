// The principal serve and prompts of CotalEndpoint, as an internal component: binding and arming each
// principal-route serve, confirming it, re-binding it on a new connection, ending and stopping it, the
// `prompts` presence field and its `seq`, and calling a principal. Moved verbatim from endpoint.ts. The
// component owns the `prompts` presence field; the endpoint keeps the shared fields and a servePrincipal
// forwarder, which a smoke replaces on an instance, and forwards to these. Not re-exported by the index.
import type { DeliveryState } from "./endpoint-delivery-state.js";
import type { ConnectionState } from "./endpoint-connection-state.js";
import type { EndpointIdentity } from "./endpoint-identity.js";
import type { EndpointParts } from "./endpoint-parts.js";
import { AGENT_CLUSTER, AGENT_CONTRACTS, AGENT_ENDPOINT } from "./agent-endpoint.js";
import { epPrincipalCall } from "./endpoint-call.js";
import { EpEnvelopeError, type EndpointReply } from "./endpoint-envelope.js";
import type { PrincipalServe, PrincipalServeIntent } from "./endpoint-options.js";
import { servePrincipalRoute, describeContracts, type EpPrincipalCommandDef, type EpPrincipalServeHandle } from "./endpoint-serve.js";
import { assertRuntimeToken, endpointToken, type EpCaller, type EpPrincipal, type PrincipalAuthority } from "./endpoint-subjects.js";
import { processRuntime } from "./process-runtime.js";
import type { CompiledContract } from "./schema-profile.js";
import { spacePrefix } from "./subjects.js";
import type { PresenceAgentEndpoint, PresencePrompts } from "./types.js";
import type { NatsConnection, PermissionViolationError } from "@nats-io/transport-node";

/** The highest `prompts` presence `seq` this process used under each runtime id (SPEC §6). A reader
 *  orders lists by `seq` within one `runtime.id`, and a runtime id lives as long as the process, so
 *  this does too: across a stopped serve, a stopped endpoint and a new endpoint for the lifecycle. */
const promptsSeqs = new Map<string, number>();

/** The principal endpoint each `{space, runtime id, endpoint}` is served by in this process. Two
 *  would subscribe the same subject and both answer one request (SPEC 13.21). */
const principalServers = new Map<string, PrincipalServeIntent>();

/** What the principal-serve component reads from its endpoint. State is read when it is used, never
 *  copied, a field it reassigns is written back through its setter, and every method is looked up on the
 *  endpoint at call time, so a member a caller replaced on the endpoint is the one that runs. A peer part
 *  is read from the parts record at call time. */
export interface EndpointPrincipalServeDeps {
  emitRecoverable: (err: Error) => void;
  requireLifecycleUid: (what: string) => string;
  notLiveMsg: () => string;
}

/** One endpoint's principal serve and prompts. Internal: it owns the `prompts` presence field, and
 *  `CotalEndpoint` keeps the shared fields and forwards to it. */
export class EndpointPrincipalServe {
  /** The `prompts` presence field {@link setPromptsPresence} last set. Shown only while the `agent`
   *  endpoint is served and its subscription was accepted on the current connection. */
  private promptsPresence?: PresencePrompts;
  /** The `agentEndpoint` presence field {@link setAgentEndpointPresence} last set, shown under the
   *  same gate as `prompts`. */
  private agentEndpointPresence?: PresenceAgentEndpoint;

  constructor(private readonly identity: Readonly<EndpointIdentity>, private readonly conn: Readonly<ConnectionState>, private readonly delivery: Readonly<DeliveryState>, private readonly deps: EndpointPrincipalServeDeps, private readonly parts: Pick<EndpointParts, "presence">) {}

  private get principalServers() { return principalServers; }
  private emitRecoverable(err: Error): void { return this.deps.emitRecoverable(err); }
  private requireLifecycleUid(what: string): string { return this.deps.requireLifecycleUid(what); }
  private notLiveMsg(): string { return this.deps.notLiveMsg(); }

  servePrincipal(spec: { handlers: EpPrincipalCommandDef[] }): PrincipalServe {
    if ("endpoint" in spec || "cluster" in spec)
      throw new Error(`servePrincipal serves only the "${AGENT_ENDPOINT}" endpoint with AGENT_CLUSTER and takes handlers alone; an endpoint or cluster is refused, never ignored (SPEC 13.22)`);
    const serve = { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: spec.handlers };
    const uid = this.identity.ownLifecycleUid;
    if (uid === undefined)
      throw new Error("serving the principal route needs this endpoint's lifecycleUid: the subject names it (SPEC 13.21)");
    const nc = this.conn.nc;
    if (!nc) throw new Error(this.notLiveMsg());
    endpointToken(serve.endpoint);
    if (this.delivery.principalServes.has(serve.endpoint))
      throw new Error(`this endpoint already serves "${serve.endpoint}" on the principal route`);
    const self: EpPrincipal = { owner: this.identity.owner, actor: this.identity.actor, uid, runtimeId: assertRuntimeToken(processRuntime(uid).id) };
    const serverKey = `${this.identity.space}\n${self.runtimeId}\n${serve.endpoint}`;
    if (this.principalServers.has(serverKey))
      throw new Error(`another endpoint in this process already serves "${serve.endpoint}" for lifecycle ${uid}: both would subscribe the same principal-route subject and answer one request twice (SPEC 13.21); stop that one first`);
    let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveFailed!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => { /* the caller observes it; this keeps an unobserved refusal from being unhandled */ });
    const failed = new Promise<Error>((resolve) => { resolveFailed = resolve; });
    const intent: PrincipalServeIntent = {
      serve, self, serverKey, handles: [], ended: false, readySettled: false, resolveReady, rejectReady, resolveFailed,
    };
    // Construction refuses an invalid cluster before anything is kept or subscribed.
    const handle = this.bindPrincipalHandle(intent, nc);
    this.delivery.principalServes.set(serve.endpoint, intent);
    this.principalServers.set(serverKey, intent);
    // A fresh `seq` per serve: the last serve may have ended with prompts open, and the pair
    // `(runtime.id, seq)` it showed then must not name this serve's empty list (SPEC §6).
    if (serve.endpoint === AGENT_ENDPOINT) this.openPrompts();
    void this.armPrincipalServe(intent, nc, handle);
    return { ready, failed, stop: () => this.stopPrincipalServe(intent) };
  }

  /** Subscribe `intent` on `nc`. */
  bindPrincipalHandle(intent: PrincipalServeIntent, nc: NatsConnection): EpPrincipalServeHandle {
    return servePrincipalRoute(nc, this.identity.space, intent.self, intent.serve);
  }

  /** A principal-route refusal a call or a serve reports itself: a request publish, a serve
   *  subscription or a reply read. Only a reply publish is left, which no call or serve awaits. */
  ownedPrincipalRouteRefusal(err: PermissionViolationError): boolean {
    const p = `${spacePrefix(this.identity.space)}.ep.`;
    if (err.operation === "publish") return err.subject.startsWith(`${p}prin.`);
    return err.subject.startsWith(`${p}prin.`) || err.subject.startsWith(`${p}prin-reply.`);
  }

  /** Track one binding: a refusal ends the serve, and an accepted subscription on the current
   *  connection shows the presence field. */
  async armPrincipalServe(intent: PrincipalServeIntent, nc: NatsConnection, handle: EpPrincipalServeHandle): Promise<void> {
    intent.binding = { nc, handle };
    // Every earlier binding is on a replaced connection: retire it once its handlers finish.
    for (const old of intent.handles)
      void old.stop().finally(() => {
        const i = intent.handles.indexOf(old);
        if (i >= 0) intent.handles.splice(i, 1);
      });
    intent.handles.push(handle);
    intent.readyOn = undefined;
    void handle.refused.then((err) => {
      if (!intent.ended && intent.binding?.handle === handle) this.endPrincipalServe(intent, err);
    });
    try {
      await handle.ready;
    } catch {
      // A refusal ends the serve through `refused`. A flush that failed because the connection
      // went away is answered by the binding the next connection makes.
      return;
    }
    this.principalServeConfirmed(intent, nc, handle);
  }

  /** The broker accepted `handle` on `nc`. When that is still the current binding, the serve is
   *  ready there. */
  private principalServeConfirmed(intent: PrincipalServeIntent, nc: NatsConnection, handle: EpPrincipalServeHandle): void {
    if (intent.ended || intent.binding?.handle !== handle || this.conn.nc !== nc) return;
    intent.readyOn = nc;
    if (!intent.readySettled) {
      intent.readySettled = true;
      intent.resolveReady();
    }
    if (intent.serve.endpoint === AGENT_ENDPOINT) this.parts.presence.publishPresence().catch((e) => this.emitRecoverable(e as Error));
  }

  /** Re-bind every principal serve on a replaced connection (a rebuild), or re-run the check on the
   *  connection the library reconnected and re-subscribed itself. */
  rebindPrincipalServes(reconnected: boolean): void {
    const nc = this.conn.nc;
    if (!nc) return;
    for (const intent of this.delivery.principalServes.values()) {
      if (intent.ended) continue;
      const bound = intent.binding;
      if (bound && bound.nc === nc) {
        if (!reconnected) continue;
        intent.readyOn = undefined;
        void bound.handle.check().then(() => this.principalServeConfirmed(intent, nc, bound.handle), () => { /* a refusal ends it through `refused` */ });
        continue;
      }
      let handle: EpPrincipalServeHandle;
      try {
        handle = this.bindPrincipalHandle(intent, nc);
      } catch (e) {
        this.endPrincipalServe(intent, e as Error);
        continue;
      }
      void this.armPrincipalServe(intent, nc, handle);
    }
  }

  /** End a serve the broker refused: no more serving, `failed` resolves, the presence field goes. */
  private endPrincipalServe(intent: PrincipalServeIntent, err: Error): void {
    if (intent.ended) return;
    this.forgetPrincipalServe(intent);
    const wasReady = intent.readySettled;
    if (!intent.readySettled) {
      intent.readySettled = true;
      intent.rejectReady(err);
    }
    intent.resolveFailed(err);
    for (const handle of intent.handles) void handle.stop();
    if (intent.serve.endpoint === AGENT_ENDPOINT) {
      this.promptsPresence = this.agentEndpointPresence = undefined;
      this.parts.presence.publishPresence().catch((e) => this.emitRecoverable(e as Error));
    }
    // `ready` already carried a refusal that came before it settled; a later one is reported here.
    if (wasReady) this.emitRecoverable(new Error(`stopped serving "${intent.serve.endpoint}" on the principal route: ${err.message}`, { cause: err }));
  }

  /** Mark `intent` ended and release what it holds in this endpoint and in this process. */
  private forgetPrincipalServe(intent: PrincipalServeIntent): void {
    intent.ended = true;
    intent.readyOn = undefined;
    if (this.delivery.principalServes.get(intent.serve.endpoint) === intent) this.delivery.principalServes.delete(intent.serve.endpoint);
    if (this.principalServers.get(intent.serverKey) === intent) this.principalServers.delete(intent.serverKey);
  }

  /** Stop serving `intent` and wait for its handlers in flight, each until its request's deadline
   *  at most. The ending is synchronous, so a
   *  `ready` still waiting for the broker rejects before the caller's next step. `republish` writes
   *  presence without the `prompts` field; the endpoint's own stop writes it offline instead. */
  async stopPrincipalServe(intent: PrincipalServeIntent, republish = true): Promise<void> {
    if (!intent.ended) {
      this.forgetPrincipalServe(intent);
      if (!intent.readySettled) {
        intent.readySettled = true;
        intent.rejectReady(new Error(`stopped serving "${intent.serve.endpoint}" before the broker confirmed the subscription`));
      }
      if (intent.serve.endpoint === AGENT_ENDPOINT) {
        this.promptsPresence = this.agentEndpointPresence = undefined;
        if (republish) this.parts.presence.publishPresence().catch((e) => this.emitRecoverable(e as Error));
      }
    }
    await Promise.all(intent.handles.map((handle) => handle.stop()));
  }

  /**
   * Set this process's `prompts` presence field and write presence at once (SPEC §6): how many
   * prompts it holds `open` or `sent`, and a counter that goes up by one each time a prompt opens or
   * changes state. The field shows only while the `agent` endpoint is served and the broker accepted
   * its subscription on the current connection. Until this is called it shows `open: 0` with the
   * fresh `seq` the serve took from {@link nextPromptsSeq} when it started. Throws when the `agent`
   * endpoint is not served, and a RangeError for a `seq` below one this runtime already used.
   */
  async setPromptsPresence(prompts: PresencePrompts): Promise<void> {
    for (const k of ["open", "seq"] as const)
      if (!Number.isSafeInteger(prompts?.[k]) || prompts[k] < 0) throw new TypeError(`prompts.${k} must be a non-negative safe integer`);
    const intent = this.delivery.principalServes.get(AGENT_ENDPOINT);
    if (!intent)
      throw new Error(`the prompts presence field belongs to a served "${AGENT_ENDPOINT}" endpoint: call servePrincipal first (SPEC §6)`);
    const used = promptsSeqs.get(intent.self.runtimeId) ?? 0;
    if (prompts.seq < used)
      throw new RangeError(`prompts.seq ${prompts.seq} is below ${used}, which this process already used under runtime ${intent.self.runtimeId}: seq never goes back under one runtime id (SPEC §6)`);
    promptsSeqs.set(intent.self.runtimeId, prompts.seq);
    this.promptsPresence = { open: prompts.open, seq: prompts.seq };
    await this.parts.presence.publishPresence();
  }

  /**
   * Set this process's `agentEndpoint` presence field (SPEC §6): the `agent` endpoint commands it
   * serves now. It shows under the same gate as `prompts`, and presence is written at once when the
   * value changed. An absent `setModel` is written as false. Throws when the `agent` endpoint is not
   * served, and a TypeError for a flag that is not a boolean.
   */
  async setAgentEndpointPresence(served: PresenceAgentEndpoint): Promise<void> {
    for (const k of ["interrupt", "turn", "images", "usage"] as const)
      if (typeof served?.[k] !== "boolean") throw new TypeError(`agentEndpoint.${k} must be a boolean`);
    if (served.setModel !== undefined && typeof served.setModel !== "boolean") throw new TypeError("agentEndpoint.setModel must be a boolean");
    if (!this.delivery.principalServes.has(AGENT_ENDPOINT))
      throw new Error(`the agentEndpoint presence field belongs to a served "${AGENT_ENDPOINT}" endpoint: call servePrincipal first (SPEC §6)`);
    const was = this.agentEndpointPresence;
    const next = { interrupt: served.interrupt, turn: served.turn, images: served.images, usage: served.usage, setModel: served.setModel ?? false };
    if (was && (Object.keys(next) as (keyof PresenceAgentEndpoint)[]).every((k) => was[k] === next[k])) return;
    this.agentEndpointPresence = next;
    await this.parts.presence.publishPresence();
  }

  /** Show `open: 0` with a fresh `seq` for a new serve of the `agent` endpoint. */
  openPrompts(): void {
    this.promptsPresence = { open: 0, seq: this.nextPromptsSeq() };
  }

  /**
   * Take the next `prompts` `seq` for this process's runtime (SPEC §6): 0 the first time, then one
   * above every `seq` this process used under its runtime id, whichever endpoint object used it. A
   * prompt desk takes every `seq` it shows from here. Throws without a lifecycle UID.
   */
  nextPromptsSeq(): number {
    const runtimeId = processRuntime(this.requireLifecycleUid("nextPromptsSeq")).id;
    const used = promptsSeqs.get(runtimeId);
    const next = used === undefined ? 0 : used + 1;
    promptsSeqs.set(runtimeId, next);
    return next;
  }

  /** The `prompts` field this process's presence carries now, or none. */
  servedPrompts(): PresencePrompts | undefined {
    return this.agentEndpointShown() ? this.promptsPresence : undefined;
  }

  /** The `agentEndpoint` field this process's presence carries now, or none. */
  servedAgentEndpoint(): PresenceAgentEndpoint | undefined {
    return this.agentEndpointShown() ? this.agentEndpointPresence : undefined;
  }

  /** The `agent` endpoint is served and its subscription was accepted on the current connection. */
  private agentEndpointShown(): boolean {
    const intent = this.delivery.principalServes.get(AGENT_ENDPOINT);
    return !!intent && !intent.ended && !!this.conn.nc && intent.readyOn === this.conn.nc;
  }

  /**
   * Call one command of a principal's own endpoint on the principal route (SPEC 13.21), as this
   * endpoint's caller triple with the authority word its row covers. `principal` is the addressed
   * process: owner, actor, lifecycle UID and the `runtime.id` its presence publishes. Presence is
   * advisory, and a wrong value reaches a subject nobody serves or one this caller's row does not
   * cover. It cannot widen authority.
   *
   * The `agent` endpoint's contracts and `describe`'s are built in; any other endpoint needs
   * `contract`. Resolves the reply, whose `ok: false` is the agent's own refusal; throws
   * `unavailable` (`not-executed`) when nothing serves that process, `permission-denied`
   * (`not-executed`) when this credential holds no row for the request, and `deadline-exceeded`
   * (`unknown`) when no reply came. See {@link epPrincipalCall}.
   */
  async callPrincipal(call: {
    endpoint: string;
    principal: EpPrincipal;
    command: string;
    authority: PrincipalAuthority;
    args?: Record<string, unknown>;
    deadlineMs: number;
    contract?: { input: CompiledContract; output: CompiledContract };
    signal?: AbortSignal;
  }): Promise<EndpointReply> {
    const nc = this.conn.nc;
    if (!nc) throw new Error(this.notLiveMsg());
    const contract = call.contract
      ?? (call.command === "describe" ? describeContracts() : call.endpoint === AGENT_ENDPOINT ? AGENT_CONTRACTS[call.command] : undefined);
    if (contract === undefined)
      throw new EpEnvelopeError("bad-request", `no contract is built in for ${call.endpoint}.${call.command}; pass one`, undefined, "not-executed");
    const caller: EpCaller = { owner: this.identity.owner, actor: this.identity.actor, uid: this.requireLifecycleUid("callPrincipal") };
    return epPrincipalCall(nc, this.identity.space, { principal: call.principal, authority: call.authority }, {
      endpoint: call.endpoint, command: call.command, contract, caller, name: this.identity.card.name,
      ...(call.args !== undefined ? { args: call.args } : {}),
    }, { deadlineMs: call.deadlineMs, ...(call.signal ? { signal: call.signal } : {}) });
  }
}
