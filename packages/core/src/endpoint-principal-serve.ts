// The principal serve and prompts of CotalEndpoint, as an internal component: binding and arming each
// principal-route serve, confirming it, re-binding it on a new connection, ending and stopping it, the
// `prompts` presence field and its `seq`, and calling a principal. Moved verbatim from endpoint.ts; the
// endpoint keeps servePrincipal, which a smoke replaces, and the fields, and forwards to these. Not
// re-exported by the index.
import { AGENT_CONTRACTS, AGENT_ENDPOINT } from "./agent-endpoint.js";
import { epPrincipalCall } from "./endpoint-call.js";
import { EpEnvelopeError, type EndpointReply } from "./endpoint-envelope.js";
import type { PrincipalServeIntent } from "./endpoint-options.js";
import { servePrincipalRoute, describeContracts, type EpPrincipalServeHandle } from "./endpoint-serve.js";
import type { EpCaller, EpPrincipal, PrincipalAuthority } from "./endpoint-subjects.js";
import { processRuntime } from "./process-runtime.js";
import type { CompiledContract } from "./schema-profile.js";
import { spacePrefix } from "./subjects.js";
import type { AgentCard, PresencePrompts } from "./types.js";
import type { NatsConnection, PermissionViolationError } from "@nats-io/transport-node";

/** The highest `prompts` presence `seq` this process used under each runtime id (SPEC §6). A reader
 *  orders lists by `seq` within one `runtime.id`, and a runtime id lives as long as the process, so
 *  this does too: across a stopped serve, a stopped endpoint and a new endpoint for the lifecycle. */
const promptsSeqs = new Map<string, number>();

/** What the principal-serve component reads from its endpoint. State is read when it is used, never
 *  copied, a field it reassigns is written back through its setter, and every method is looked up on the
 *  endpoint at call time, so a member a caller replaced on the endpoint is the one that runs. */
export interface EndpointPrincipalServeDeps {
  space: () => string;
  nc: () => NatsConnection | undefined;
  owner: () => string;
  actor: () => string;
  card: () => AgentCard;
  principalServes: () => Map<string, PrincipalServeIntent>;
  principalServers: () => Map<string, PrincipalServeIntent>;
  promptsPresence: () => PresencePrompts | undefined;
  setPromptsPresence: (value: PresencePrompts | undefined) => void;
  publishPresence: () => Promise<void>;
  emitRecoverable: (err: Error) => void;
  requireLifecycleUid: (what: string) => string;
  notLiveMsg: () => string;
}

/** One endpoint's principal serve and prompts. Internal: `CotalEndpoint` keeps the fields and forwards to it. */
export class EndpointPrincipalServe {
  constructor(private readonly deps: EndpointPrincipalServeDeps) {}

  private get space() { return this.deps.space(); }
  private get nc() { return this.deps.nc(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get card() { return this.deps.card(); }
  private get principalServes() { return this.deps.principalServes(); }
  private get principalServers() { return this.deps.principalServers(); }
  private get promptsPresence() { return this.deps.promptsPresence(); }
  private set promptsPresence(value: PresencePrompts | undefined) { this.deps.setPromptsPresence(value); }
  private publishPresence(): Promise<void> { return this.deps.publishPresence(); }
  private emitRecoverable(err: Error): void { return this.deps.emitRecoverable(err); }
  private requireLifecycleUid(what: string): string { return this.deps.requireLifecycleUid(what); }
  private notLiveMsg(): string { return this.deps.notLiveMsg(); }

  /** Subscribe `intent` on `nc`. */
  bindPrincipalHandle(intent: PrincipalServeIntent, nc: NatsConnection): EpPrincipalServeHandle {
    return servePrincipalRoute(nc, this.space, intent.self, intent.serve);
  }

  /** A principal-route refusal a call or a serve reports itself: a request publish, a serve
   *  subscription or a reply read. Only a reply publish is left, which no call or serve awaits. */
  ownedPrincipalRouteRefusal(err: PermissionViolationError): boolean {
    const p = `${spacePrefix(this.space)}.ep.`;
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
    if (intent.ended || intent.binding?.handle !== handle || this.nc !== nc) return;
    intent.readyOn = nc;
    if (!intent.readySettled) {
      intent.readySettled = true;
      intent.resolveReady();
    }
    if (intent.serve.endpoint === AGENT_ENDPOINT) this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
  }

  /** Re-bind every principal serve on a replaced connection (a rebuild), or re-run the check on the
   *  connection the library reconnected and re-subscribed itself. */
  rebindPrincipalServes(reconnected: boolean): void {
    const nc = this.nc;
    if (!nc) return;
    for (const intent of this.principalServes.values()) {
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
      this.promptsPresence = undefined;
      this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
    }
    // `ready` already carried a refusal that came before it settled; a later one is reported here.
    if (wasReady) this.emitRecoverable(new Error(`stopped serving "${intent.serve.endpoint}" on the principal route: ${err.message}`, { cause: err }));
  }

  /** Mark `intent` ended and release what it holds in this endpoint and in this process. */
  private forgetPrincipalServe(intent: PrincipalServeIntent): void {
    intent.ended = true;
    intent.readyOn = undefined;
    if (this.principalServes.get(intent.serve.endpoint) === intent) this.principalServes.delete(intent.serve.endpoint);
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
        this.promptsPresence = undefined;
        if (republish) this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
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
    const intent = this.principalServes.get(AGENT_ENDPOINT);
    if (!intent)
      throw new Error(`the prompts presence field belongs to a served "${AGENT_ENDPOINT}" endpoint: call servePrincipal first (SPEC §6)`);
    const used = promptsSeqs.get(intent.self.runtimeId) ?? 0;
    if (prompts.seq < used)
      throw new RangeError(`prompts.seq ${prompts.seq} is below ${used}, which this process already used under runtime ${intent.self.runtimeId}: seq never goes back under one runtime id (SPEC §6)`);
    promptsSeqs.set(intent.self.runtimeId, prompts.seq);
    this.promptsPresence = { open: prompts.open, seq: prompts.seq };
    await this.publishPresence();
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
    const intent = this.principalServes.get(AGENT_ENDPOINT);
    if (!intent || intent.ended || !this.nc || intent.readyOn !== this.nc) return undefined;
    return this.promptsPresence;
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
    const nc = this.nc;
    if (!nc) throw new Error(this.notLiveMsg());
    const contract = call.contract
      ?? (call.command === "describe" ? describeContracts() : call.endpoint === AGENT_ENDPOINT ? AGENT_CONTRACTS[call.command] : undefined);
    if (contract === undefined)
      throw new EpEnvelopeError("bad-request", `no contract is built in for ${call.endpoint}.${call.command}; pass one`, undefined, "not-executed");
    const caller: EpCaller = { owner: this.owner, actor: this.actor, uid: this.requireLifecycleUid("callPrincipal") };
    return epPrincipalCall(nc, this.space, { principal: call.principal, authority: call.authority }, {
      endpoint: call.endpoint, command: call.command, contract, caller, name: this.card.name,
      ...(call.args !== undefined ? { args: call.args } : {}),
    }, { deadlineMs: call.deadlineMs, ...(call.signal ? { signal: call.signal } : {}) });
  }
}
