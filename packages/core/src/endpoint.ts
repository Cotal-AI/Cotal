import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  connect,
  credsAuthenticator,
  nanos,
  AuthorizationError,
  PermissionViolationError,
  UserAuthenticationExpiredError,
  type NatsConnection,
  type Subscription,
} from "@nats-io/transport-node";
import { idFromCreds } from "./identity.js";
import { assertValidName } from "./resolve.js";
import { createSpaceStreams, chatDurableConfig, dmDurableConfig, taskDurableConfig, MAX_MSGS_PER_SUBJECT } from "./streams.js";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
  type ConsumerInfo,
  type JsMsg,
} from "@nats-io/jetstream";
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";

import type {
  AgentCard,
  ChannelConfig,
  ChannelDefaults,
  ControlReply,
  ControlRequest,
  ControlRequestInit,
  Delivery,
  EndpointRef,
  MessageMeta,
  Part,
  Presence,
  PresenceStatus,
  CotalMessage,
} from "./types.js";
import {
  openChannelRegistry,
  effectiveReplay,
  effectiveReplayWindowMs,
  readChannelConfig,
  readChannelDefaults,
} from "./channels.js";
import {
  anycastSubject,
  CHANNEL_DEFAULTS_KEY,
  chatStream,
  chatDurable,
  chatHistDurable,
  chatSubject,
  collapseFilterSubjects,
  controlServiceSubject,
  CONTROL_SELF_SERVICE,
  dmStream,
  dmDurable,
  isConcreteChannel,
  normalizeMentions,
  parseSubject,
  type ParsedSubject,
  presenceBucket,
  spacePrefix,
  spaceWildcard,
  subjectMatches,
  taskStream,
  taskDurable,
  token,
  unicastSubject,
} from "./subjects.js";

export const DEFAULT_SERVER = "nats://127.0.0.1:4222";

/** Space joined when none is given on the CLI (the `cotal-<space>` cmux tab, etc.). */
export const DEFAULT_SPACE = "main";

export interface EndpointOptions {
  /** The collaboration to join. */
  space: string;
  /** Identity. `id` is generated if omitted. */
  card: Omit<AgentCard, "id"> & { id?: string };
  servers?: string;
  /** Connection token (soft-shared auth). Mutually exclusive with user/pass. */
  token?: string;
  /** Username/password auth (both required together). */
  user?: string;
  pass?: string;
  /** NATS user creds file *content* (JWT + nkey seed). When set, the endpoint
   *  authenticates as that user and adopts the creds' identity as its card.id. */
  creds?: string;
  /** Require a TLS connection to the server. */
  tls?: boolean;
  /** Channels to subscribe to; the first is the default broadcast target. */
  channels?: string[];
  /** Presence heartbeat interval (ms). */
  heartbeatMs?: number;
  /** Presence liveness window (ms); a peer is considered gone after this. */
  ttlMs?: number;
  /** Publish our own presence (default true). */
  registerPresence?: boolean;
  /** Track the roster of peers (default true). */
  watchPresence?: boolean;
  /** Create inbound stream consumers (DM / chat / anycast). Default true; a pure observer sets false. */
  consume?: boolean;
  /** How long an unacked (un-surfaced) message waits before redelivery (ms). */
  ackWaitMs?: number;
  /** Retire this instance's durable consumers after it's been gone this long (ms). */
  inactiveThresholdMs?: number;
}

/** A peer subscribed to a channel — broker truth (a chat-stream consumer) joined with
 *  presence for liveness. `live: false` is a stale ghost: the durable lingers (reconnect
 *  grace) but presence says the peer is gone/offline. */
export interface ChannelMember {
  id: string;
  name: string;
  role?: string;
  live: boolean;
}

/**
 * Events: "message" (CotalMessage), "presence" (PresenceEvent), "roster" (Presence[]), "error" (Error),
 * "connection" ({ connected: boolean }) — true on every successful (re)bind (initial start, manual
 * reconnect, AND background self-heal), false the moment the connection drops (rebuild null window /
 * terminal close). Lets an in-process agent track connectedness off the endpoint's own (re)binds
 * instead of an imperative flag the self-heal path can't reach.
 *
 * Callers MUST attach an "error" listener before `start()`: async faults (incl. NATS
 * permission denials, surfaced via `watchStatus`) are emitted as "error", and Node throws
 * synchronously on an unhandled "error" — a missing listener turns any such fault into a
 * process crash instead of a logged denial.
 */
export class CotalEndpoint extends EventEmitter {
  readonly card: AgentCard;
  readonly space: string;
  readonly channels: string[];

  private readonly servers: string;
  private readonly token?: string;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly creds?: string;
  private readonly tls: boolean;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly doRegister: boolean;
  private readonly doWatch: boolean;
  private readonly doConsume: boolean;
  private readonly ackWaitMs: number;
  private readonly inactiveThresholdMs: number;

  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private kv?: KV;
  private channelKv?: KV;
  /** Live local cache of the channel registry (key = channel token), kept by a KV watch. */
  private readonly channelConfigs = new Map<string, ChannelConfig>();
  private channelDefaults: ChannelDefaults = {};
  /** Per-subscription join watermark: the stream frontier captured when a channel was joined.
   *  The tail ack-drops chat messages with `seq <= watermark` (suppresses pre-join history for
   *  a lagging joiner + dedups the backfill overlap). Keyed by the subscription pattern (may be
   *  wildcard), so the drop matches every concrete channel the pattern subsumes. */
  private readonly joinSeq = new Map<string, number>();
  private readonly subs: Subscription[] = [];
  private readonly streamMsgs: ConsumerMessages[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly roster = new Map<string, Presence>();
  private status: PresenceStatus = "idle";
  private activity?: string;
  private stopped = false;
  /** In-flight rebuild (drain+rebind) — serializes manual reconnect, the supervisor's
   *  closed(), and reestablishLoop so only ONE rebuild runs at a time (a second trigger
   *  coalesces onto the shared promise, never starts a parallel connectAndBind). */
  private rebuildPromise?: Promise<void>;
  /** True only during the null window of a rebuild (this.nc unset) — user-facing ops then
   *  throw a "reconnecting" message instead of the misleading "endpoint not started". */
  private reconnecting = false;
  /** One reestablishLoop at a time; concurrent triggers coalesce via rebuild(). */
  private reestablishing = false;
  /** Interruptible backoff for reestablishLoop — reconnect()/stop() resolves this to retry
   *  now instead of awaiting the full retryMs. */
  private backoffResolve?: () => void;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private readonly retryMs = 3000;


  constructor(opts: EndpointOptions) {
    super();
    this.space = opts.space;
    // A display name is the client-side handle a peer is addressed by; reject the reserved `/`
    // (the future owner/name separator) and surrounding whitespace at the one identity choke
    // point every join/spawn path flows through.
    assertValidName(opts.card.name);
    // Identity precedence: an explicit card.id, else the creds' identity, else a random
    // uuid. When both an id and creds are given they MUST name the same nkey — otherwise
    // the subject sender token wouldn't match the authenticated user and every publish
    // would be denied (a silent-failure class).
    const credId = opts.creds ? idFromCreds(opts.creds) : undefined;
    if (opts.card.id && credId && opts.card.id !== credId)
      throw new Error(`card.id ${opts.card.id} != creds identity ${credId} — they must be the same nkey`);
    const id = opts.card.id ?? credId ?? randomUUID();
    this.card = { ...opts.card, id };
    this.servers = opts.servers ?? DEFAULT_SERVER;
    this.token = opts.token;
    this.user = opts.user;
    this.pass = opts.pass;
    this.creds = opts.creds;
    this.tls = opts.tls ?? false;
    this.channels = opts.channels ?? ["general"];
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 6000;
    this.doRegister = opts.registerPresence ?? true;
    this.doWatch = opts.watchPresence ?? true;
    this.doConsume = opts.consume ?? true;
    this.ackWaitMs = opts.ackWaitMs ?? 60_000;
    this.inactiveThresholdMs = opts.inactiveThresholdMs ?? 600_000;
  }

  ref(): EndpointRef {
    return { id: this.card.id, name: this.card.name, role: this.card.role };
  }

  async start(): Promise<void> {
    await this.connectAndBind();
    // nats.js auto-reconnects transient drops; when it exhausts its attempts and the
    // connection closes for good, rebuild from scratch so an in-process agent (e.g. the
    // OpenCode plugin) recovers without a host respawn. Armed only after a successful first
    // connect — a first-connect failure throws to the caller's connect-retry loop instead.
    this.superviseConnection();
  }

  /** Open the connection and bind everything that hangs off it: status watch, presence
   *  watch + heartbeat, channel registry, and the durable consumers. Re-runnable — a
   *  reconnect calls it again after {@link clearConnectionScoped}; every binding is
   *  idempotent (durables bind by name, JetStream dedups by msgID, KV opens are idempotent). */
  private async connectAndBind(): Promise<void> {
    this.clearConnectionScoped();
    this.nc = await connect({
      servers: this.servers,
      name: `cotal:${this.card.name}`,
      // Per-identity inbox namespace (the "Private Inbox" pattern). nats.js routes ALL
      // generated inboxes — request replies, JetStream pull delivery, kv.watch ordered-
      // consumer delivery — through this prefix. Paired with sub.allow=[_INBOX_<id>.>]
      // (auth mode) it stops a peer from subscribing the wildcard inbox to sniff others'
      // DM deliveries. Set unconditionally so the prefix can never drift from the ACL.
      inboxPrefix: `_INBOX_${this.card.id}`,
      ...authOpts({ token: this.token, user: this.user, pass: this.pass, creds: this.creds, tls: this.tls }),
    });
    this.watchStatus();
    this.js = jetstream(this.nc);

    if (this.doWatch || this.doRegister) {
      const kvm = new Kvm(this.nc);
      // The presence bucket is a JetStream stream. Open mode lazily creates it; auth mode
      // OPENs it (it's pre-created at `cotal up`; KV stream-create is denied to agents).
      this.kv = this.creds
        ? await kvm.open(presenceBucket(this.space))
        : await kvm.create(presenceBucket(this.space), { ttl: this.ttlMs });
    }

    if (this.doWatch) {
      await this.startPresenceWatch();
      this.sweepTimer = setInterval(
        () => this.sweep(),
        Math.max(500, Math.floor(this.ttlMs / 3)),
      );
    }

    // Open the channel registry bucket when we either watch it (live cache for the connector's
    // pull/display) or consume (the join-time replay decision reads it fresh). Auth mode OPENs
    // the bucket pre-created at `cotal up`; open mode lazily creates it.
    if (this.doWatch || this.doConsume) {
      this.channelKv = await openChannelRegistry(this.nc, this.space, { create: !this.creds });
      if (this.doWatch) await this.startChannelWatch();
    }

    if (this.doRegister) {
      await this.publishPresence();
      this.heartbeatTimer = setInterval(() => {
        this.publishPresence().catch((e) => this.emit("error", e as Error));
      }, this.heartbeatMs);
    }

    if (this.doConsume) {
      this.jsm = await jetstreamManager(this.nc);
      // Open mode: lazily create the streams on the first endpoint. Auth mode: they are
      // pre-created at `cotal up` and STREAM.CREATE is denied to agents, so skip.
      if (!this.creds) await this.ensureStreams();
      await this.startConsumers();
    }

    // Bound and live — covers initial start, manual reconnect, AND background self-heal (every
    // path lands here). The single signal an in-process agent's connected flag tracks.
    this.emit("connection", { connected: true });
  }

  /** Tear down everything {@link connectAndBind} (re)creates, so a rebind can't leak a
   *  second heartbeat, double-pump a consumer, or keep stale roster ghosts. Caller-owned
   *  subs (tap/serve) are left alone — they aren't rebuilt here. */
  private clearConnectionScoped(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const msgs of this.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed with the connection */
      }
    }
    this.streamMsgs.length = 0;
    this.roster.clear();
    this.joinSeq.clear();
    this.channelConfigs.clear();
    this.channelDefaults = {};
  }

  /** If stop() ran during a rebuild's `await connectAndBind`, the just-bound connection +
   *  heartbeat + supervisor would be left live on a stopped endpoint. Tear that fresh
   *  connection back down and report it. Reads `this.nc` in its own scope (a bare `this.nc`
   *  in doRebuild narrows to `never` via TS inlining connectAndBind's assignment). Returns
   *  true iff it tore something down (caller bails out of the rebuild). */
  private async tearDownIfStopped(): Promise<boolean> {
    if (!this.stopped) return false;
    const nc = this.nc;
    this.clearConnectionScoped();
    try {
      await nc?.drain();
    } catch {
      /* already closing */
    }
    this.nc = undefined;
    return true;
  }

  /** Watch for a terminal close (nats.js has exhausted its own reconnect) and rebuild.
   *  Our own stop()/drain also resolves closed(), so the `stopped` guard keeps a clean
   *  shutdown from re-establishing. The identity guard (`this.nc !== nc`) no-ops a STALE
   *  supervisor — one whose connection reconnect()/rebuild already replaced — so only a
   *  close of the CURRENT connection triggers a rebuild. The rebuild itself is serialized
   *  with the manual path via {@link rebuild}. */
  private superviseConnection(): void {
    const nc = this.nc;
    if (!nc) return;
    void nc.closed().then((err) => {
      if (this.stopped) return;
      if (this.nc !== nc) return; // epoch-stale — a rebuild already swapped this connection
      this.emit("connection", { connected: false }); // dropped — report it before the rebuild kicks in
      this.emit(
        "error",
        new Error(`mesh connection closed${err ? `: ${(err as Error).message}` : ""} — re-establishing`),
      );
      void this.reestablishLoop();
    });
  }

  /** Single serialized rebuild: drain the old connection and rebind via {@link connectAndBind},
   *  guarded so concurrent triggers (manual {@link reconnect}, the supervisor's closed(), the
   *  retry loop) coalesce onto ONE in-flight rebuild instead of racing two connectAndBinds and
   *  leaking a connection. Returns the shared promise; a second caller gets the in-flight one. */
  private rebuild(): Promise<void> {
    if (this.rebuildPromise) return this.rebuildPromise;
    const p = this.doRebuild().finally(() => {
      if (this.rebuildPromise === p) this.rebuildPromise = undefined;
    });
    this.rebuildPromise = p;
    return p;
  }

  /** The transition: stop the connection-scoped timers FIRST (so nothing live touches
   *  this.nc during the null window), drop the connection refs, drain the old nc, then
   *  rebind + re-arm the supervisor on the fresh connection. clearConnectionScoped is
   *  idempotent, so connectAndBind's own call here is a noop. */
  private async doRebuild(): Promise<void> {
    const oldNc = this.nc;
    this.reconnecting = true;
    try {
      this.clearConnectionScoped();
      this.nc = undefined;
      this.js = undefined;
      this.jsm = undefined;
      this.kv = undefined;
      this.channelKv = undefined;
      this.emit("connection", { connected: false }); // null window opened — not live until the rebind below
      try {
        await oldNc?.drain();
      } catch {
        /* already closing */
      }
      await this.connectAndBind();
      // stop() may have run during the await — don't leave a live connection + heartbeat +
      // supervisor on a stopped endpoint. (Reads this.nc in its own scope — a bare `this.nc`
      // here in doRebuild narrows to `never` via TS inlining connectAndBind's assignment.)
      if (await this.tearDownIfStopped()) return;
      this.superviseConnection(); // re-arm on the fresh nc
    } finally {
      this.reconnecting = false;
    }
  }

  /** Rebuild with backoff until it sticks or we're stopped. Interruptible: a manual
   *  {@link reconnect} kicks the backoff so the next attempt runs immediately instead of
   *  awaiting the full retryMs. One loop at a time ({@link reestablishing}); concurrent
   *  triggers coalesce via {@link rebuild}. */
  private async reestablishLoop(): Promise<void> {
    if (this.reestablishing) return;
    this.reestablishing = true;
    try {
      while (!this.stopped) {
        try {
          await this.rebuild();
          return; // success — re-armed; the supervisor re-triggers on the next terminal close
        } catch (e) {
          if (!this.stopped) this.emit("error", e as Error);
          await new Promise<void>((resolve) => {
            this.backoffResolve = resolve;
            this.backoffTimer = setTimeout(resolve, this.retryMs);
          });
        }
      }
    } finally {
      this.reestablishing = false;
    }
  }

  /** Cut an in-flight reestablish backoff short so the next attempt runs immediately, and
   *  clear its timer so it can't fire later on a stopped/restarted loop. */
  private kickBackoff(): void {
    this.backoffResolve?.();
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /** Manual reconnect: tear down the current connection and rebuild, WITHOUT the permanent
   *  stop (stopped/stopping stay false). Serialized with the self-heal supervisor via
   *  {@link rebuild}, and interruptible — if a backoff is in flight, kick it so the attempt
   *  is now, not in retryMs. Throws if stopped. On failure, leaves {@link reestablishLoop}
   *  running in the background so the endpoint never stays dead, and rethrows so the caller
   *  can report it. */
  async reconnect(): Promise<void> {
    if (this.stopped) throw new Error("endpoint stopped — cannot reconnect");
    this.kickBackoff();
    try {
      await this.rebuild();
    } catch (e) {
      void this.reestablishLoop(); // background retry until success or stop
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Wake a reestablishLoop sitting in backoff so it sees `stopped` and exits instead of
    // sleeping out retryMs; also clears the timer so it can't fire later.
    this.kickBackoff();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const msgs of this.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed */
      }
    }
    try {
      if (this.doRegister) {
        this.status = "offline";
        await this.publishPresence();
      }
    } catch {
      /* best-effort graceful leave */
    }
    try {
      await this.nc?.drain();
    } catch {
      /* ignore */
    }
  }

  // ---- messaging -----------------------------------------------------------

  /** Multicast: broadcast to everyone on a channel. */
  async multicast(
    text: string,
    opts?: { channel?: string; parts?: Part[]; replyTo?: string; contextId?: string; mentions?: string[] },
  ): Promise<CotalMessage> {
    // Publish must target a concrete sub-channel — you can't broadcast to a
    // wildcard. Default to the first concrete channel we're on (channels[0] may
    // itself be a wildcard subscription like `team.>`).
    const channel = opts?.channel ?? this.channels.find(isConcreteChannel) ?? "general";
    if (!isConcreteChannel(channel))
      throw new Error(`cannot publish to wildcard channel "${channel}" — pick a concrete sub-channel`);
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      channel,
      // Priority/wake hint, not routing — validation (against the roster) is the connector's
      // job; core just canonicalizes and omits the field when empty.
      mentions: normalizeMentions(opts?.mentions),
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    await this.publishMsg(chatSubject(this.space, this.card.id, channel), msg);
    return msg;
  }

  /** Unicast: direct message to one specific instance. */
  async unicast(
    instanceId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<CotalMessage> {
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to: instanceId,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    await this.publishMsg(unicastSubject(this.space, instanceId, this.card.id), msg);
    return msg;
  }

  /** Anycast: deliver to ANY one instance of a service (role) — queue-group load balancing. */
  async anycast(
    service: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<CotalMessage> {
    const msg: CotalMessage = {
      id: randomUUID(),
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      toService: service,
      parts: opts?.parts ?? [{ kind: "text", text }],
      replyTo: opts?.replyTo,
      contextId: opts?.contextId,
    };
    await this.publishMsg(anycastSubject(this.space, service, this.card.id), msg);
    return msg;
  }

  /** Subscribe to a read-only observer feed. Defaults to the whole space; an observer under
   *  auth must pass `chatWildcard(space)` since its `sub.allow` only covers chat (DM/anycast
   *  stay confidential), otherwise the space-wildcard subscribe is denied and the feed dies. */
  tap(
    handler: (subject: string, msg: CotalMessage | undefined) => void,
    opts?: { subject?: string },
  ): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(opts?.subject ?? spaceWildcard(this.space));
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let decoded: CotalMessage | undefined;
        try {
          decoded = m.json<CotalMessage>();
        } catch {
          decoded = undefined;
        }
        handler(m.subject, decoded);
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  // ---- control plane (request/reply) --------------------------------------

  /** Serve control requests for a service (manager side). */
  serveControl(
    service: string,
    handler: (req: ControlRequest) => Promise<ControlReply> | ControlReply,
  ): void {
    if (!this.nc) throw new Error("endpoint not started");
    const sub = this.nc.subscribe(controlServiceSubject(this.space, service, "*"), {
      queue: service,
    });
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let reply: ControlReply;
        try {
          const req = m.json<ControlRequest>();
          // Authenticity guard (fail closed): control is the most privileged surface
          // (start/stop). The sender is encoded in the subject (ctl.<svc>.<sender>), which
          // the server policed who could publish; the payload `from` is advisory and must
          // match. Reject before the handler acts on a request claiming a forged sender.
          const parsed = parseSubject(m.subject);
          if (!parsed || req.from?.id !== parsed.sender) {
            this.emit(
              "error",
              new Error(
                `rejected control request on ${m.subject}: from ${req.from?.id ?? "(none)"} ` +
                  `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
              ),
            );
            reply = { ok: false, error: "sender mismatch — request rejected" };
          } else {
            reply = await handler(req);
          }
        } catch (e) {
          reply = { ok: false, error: (e as Error).message };
        }
        try {
          m.respond(JSON.stringify(reply));
        } catch {
          /* no reply inbox */
        }
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  /** Send a control request to a service and await its reply (client side). */
  async requestControl(
    service: string,
    req: ControlRequestInit,
    timeoutMs = 5000,
  ): Promise<ControlReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const body: ControlRequest = { ...req, from: req.from ?? this.ref() };
    const m = await this.nc.request(
      controlServiceSubject(this.space, service, this.card.id),
      JSON.stringify(body),
      { timeout: timeoutMs },
    );
    return m.json<ControlReply>();
  }

  // ---- presence ------------------------------------------------------------

  getRoster(): Presence[] {
    return [...this.roster.values()].sort((a, b) =>
      a.card.name.localeCompare(b.card.name),
    );
  }

  async setActivity(activity: string): Promise<void> {
    this.activity = activity;
    await this.publishPresence();
  }

  async setStatus(status: PresenceStatus): Promise<void> {
    this.status = status;
    await this.publishPresence();
  }

  // ---- channel discovery ---------------------------------------------------

  /** This channel's registry config from the live local cache (undefined if unset). */
  getChannelConfig(channel: string): ChannelConfig | undefined {
    return this.channelConfigs.get(channel);
  }

  /** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
   *  true. Reads the live cache, so it reflects runtime registry edits. */
  channelReplay(channel: string): boolean {
    return effectiveReplay(this.channelConfigs.get(channel), this.channelDefaults);
  }

  // ---- dynamic subscription (join / leave mid-session) ---------------------

  /** The channels this endpoint is currently subscribed to (live — reflects join/leave). */
  joinedChannels(): string[] {
    return [...this.channels];
  }

  /**
   * Join a channel mid-session: add it to our chat durable's `filter_subjects` (same durable,
   * same ack-floor, no teardown — `update` rides the self-scoped create grant), capture the
   * stream frontier as this channel's join watermark, and backfill its history if replay is on.
   * Idempotent: re-joining a channel already in our filter is a no-op (no re-backfill). Returns
   * the number of historical messages backfilled (emitted as `historical` "message" events).
   */
  async joinChannel(channel: string): Promise<{ joined: boolean; backfilled: number }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    if (this.channels.includes(channel)) return { joined: false, backfilled: 0 };
    // Arm the watermark BEFORE the filter flip (single-delivery: a tail message on the new
    // channel is then either ≤ frontier → backfill-only or > frontier → tail-only, never both),
    // and filter BEFORE backfill (gap-safe: backfill-first leaves a window in neither stream).
    const armed = await this.armJoin([channel]);
    try {
      await this.setChatFilter([...this.channels, channel]);
    } catch (e) {
      this.joinSeq.delete(channel); // the flip was rejected (e.g. outside allowSubscribe) — undo the arm
      throw e;
    }
    this.channels.push(channel);
    const backfilled = await this.backfillArmed(armed);
    return { joined: true, backfilled };
  }

  /** Leave a channel mid-session: drop it from the durable's `filter_subjects`. Refuses to leave
   *  the *last* channel (an empty filter would match every chat subject — the opposite of
   *  leaving). Returns whether anything changed. */
  async leaveChannel(channel: string): Promise<{ left: boolean }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    const i = this.channels.indexOf(channel);
    if (i < 0) return { left: false };
    if (this.channels.length === 1)
      throw new Error(`cannot leave "${channel}" — it is your only channel (an empty filter would subscribe to all)`);
    const remaining = this.channels.filter((c) => c !== channel);
    await this.setChatFilter(remaining);
    this.channels.splice(i, 1);
    this.joinSeq.delete(channel);
    return { left: true };
  }

  /** Move the chat live-tail durable to a new channel set. OPEN mode self-serves the
   *  `consumers.update` (the agent owns its durable). AUTH mode is bind-only — the agent has no
   *  UPDATE grant — so it sends a mediated control request to the manager, which validates the set
   *  ⊆ its `allowSubscribe` before moving the filter. Throws clearly when no privileged responder is
   *  present: a manager-less standalone auth session is fixed to its boot subscribe set — a
   *  documented limitation, not a silent degrade. */
  private async setChatFilter(channels: string[]): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    if (!this.creds) {
      await this.jsm.consumers.update(chatStream(this.space), chatDurable(this.card.id), {
        filter_subjects: collapseFilterSubjects(channels.map((ch) => chatSubject(this.space, "*", ch))),
      });
      return;
    }
    let reply: ControlReply;
    try {
      reply = await this.requestControl(CONTROL_SELF_SERVICE, { op: "setChannels", args: { channels } });
    } catch (e) {
      const msg = (e as Error).message;
      if (/no responders/i.test(msg))
        throw new Error(
          "cannot change channels at runtime: no privileged provisioner (manager) is serving the mesh — " +
            "this session is fixed to its boot subscribe set",
        );
      throw e;
    }
    if (!reply.ok) throw new Error(reply.error ?? "channel change rejected");
  }

  /** One coherent channel model for dashboards: every channel that has messages OR a registry
   *  entry (configured-but-empty), each tagged with its {@link ChannelConfig}. Works even on
   *  observer endpoints (no consumers needed). */
  async listChannels(): Promise<{ channel: string; messages: number; config?: ChannelConfig }[]> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const mgr = await jetstreamManager(this.nc);
    // Subjects carry the sender (chat.<sender>.<channel>), so collapse across senders: sum
    // each channel's counts regardless of who published.
    const counts = new Map<string, number>();
    try {
      const info = await mgr.streams.info(chatStream(this.space), { subjects_filter: ">" });
      if (info.state.subjects) {
        for (const [subject, count] of Object.entries(info.state.subjects)) {
          const p = parseSubject(subject);
          if (p?.kind === "chat") counts.set(p.rest, (counts.get(p.rest) ?? 0) + count);
        }
      }
    } catch {
      /* stream missing — fall through to registry-only channels */
    }
    const channels = new Set<string>([...counts.keys(), ...this.channelConfigs.keys()]);
    return [...channels]
      .map((channel) => ({
        channel,
        messages: counts.get(channel) ?? 0,
        config: this.channelConfigs.get(channel),
      }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  /**
   * Who is subscribed to a channel — **broker truth, not self-report**. In Cotal a peer
   * joins a channel by creating a chat-stream durable consumer (`chat_<id>`,
   * `filter_subjects` = its channels), so `consumers.list(CHAT)` already records the real
   * membership; we join it with presence so a lingering durable for a gone peer shows as a
   * stale ghost (`live: false`) rather than a phantom listener.
   *
   * `channelMembers("review")` → that channel's members; `channelMembers()` → every channel
   * mapped to its members. A member on a wildcard (`team.>`) counts for every concrete
   * channel it subsumes (`team.backend`) — membership is the *effective subscription*.
   *
   * Privileged read: `consumers.list` needs `$JS.API.CONSUMER.LIST.<chat stream>`, which only
   * the allow-all manager profile holds today (agents, observer, and admin are all denied), so
   * this is not an agent-facing capability — serving it from a dashboard profile is a one-line
   * ACL grant away.
   */
  async channelMembers(channel: string): Promise<ChannelMember[]>;
  async channelMembers(): Promise<Map<string, ChannelMember[]>>;
  async channelMembers(
    channel?: string,
  ): Promise<ChannelMember[] | Map<string, ChannelMember[]>> {
    const mgr = await this.manager();
    // Group channel patterns by each consumer's durable id-token (chat_<id> → token(id)).
    // One peer has one chat consumer, so this is a straight per-peer collection; join/leave
    // just mutates that consumer's filter_subjects, which the next call re-reads live.
    const byTok = new Map<string, Set<string>>();
    for await (const ci of mgr.consumers.list(chatStream(this.space))) {
      const tok = chatDurableToken(ci.config.durable_name ?? ci.name);
      if (tok === null) continue;
      // The server may report a single filter as `filter_subject` or `filter_subjects` — both
      // are the same datum; read whichever is present. Filters are already collapsed (the
      // effective subscription), so parse the channel straight out of each.
      const filters =
        ci.config.filter_subjects ?? (ci.config.filter_subject ? [ci.config.filter_subject] : []);
      const set = byTok.get(tok) ?? new Set<string>();
      for (const f of filters) {
        const p = parseSubject(f);
        if (p?.kind === "chat") set.add(p.rest);
      }
      byTok.set(tok, set);
    }

    // Join with presence for liveness. token() is lossy, so match forward: index the roster
    // by token(id). A durable with no roster match is a ghost/foreign id — keep its token,
    // never drop it.
    const byToken = new Map<string, Presence>();
    for (const p of this.roster.values()) byToken.set(token(p.card.id), p);
    const memberFor = (tok: string): ChannelMember => {
      const p = byToken.get(tok);
      return p
        ? { id: p.card.id, name: p.card.name, role: p.card.role, live: p.status !== "offline" }
        : { id: tok, name: tok, live: false };
    };
    const byName = (a: ChannelMember, b: ChannelMember) => a.name.localeCompare(b.name);

    if (channel !== undefined) {
      const out: ChannelMember[] = [];
      for (const [tok, patterns] of byTok)
        if ([...patterns].some((pat) => subjectMatches(pat, channel))) out.push(memberFor(tok));
      return out.sort(byName);
    }

    const map = new Map<string, ChannelMember[]>();
    for (const [tok, patterns] of byTok) {
      const m = memberFor(tok);
      for (const pat of patterns) {
        const arr = map.get(pat);
        if (arr) arr.push(m);
        else map.set(pat, [m]);
      }
    }
    for (const arr of map.values()) arr.sort(byName);
    return map;
  }

  /** Fetch recent messages from a channel's JetStream backlog. */
  async channelHistory(
    channel: string,
    opts?: { limit?: number },
  ): Promise<CotalMessage[]> {
    // history from any sender
    return this.streamHistory(
      chatStream(this.space),
      chatSubject(this.space, "*", channel),
      opts?.limit ?? 100,
    );
  }

  /** Fetch recent DMs (any sender→any recipient) from the space's DM backlog. God-view only:
   *  a normal agent/observer's ACL denies CONSUMER.CREATE on DM_<space>, so this throws-and-
   *  skips for them — only an `admin`-profile cred can read it. */
  async dmHistory(opts?: { limit?: number }): Promise<CotalMessage[]> {
    // every inst.<target>.<sender> DM
    return this.streamHistory(
      dmStream(this.space),
      unicastSubject(this.space, "*", "*"),
      opts?.limit ?? 100,
    );
  }

  /** Drain up to `limit` recent messages matching `subject` from a stream's backlog via a
   *  throwaway consumer. Fetches exactly the pending count (from consumer info) so it returns
   *  the moment the backlog is delivered — a plain `fetch({max_messages: limit})` would instead
   *  block for the pull's full expiry (~30s) whenever the backlog is smaller than `limit`. */
  private async streamHistory(
    stream: string,
    subject: string,
    limit: number,
  ): Promise<CotalMessage[]> {
    if (!this.nc) throw new Error("endpoint not started");
    const js = jetstream(this.nc);
    const msgs: CotalMessage[] = [];
    try {
      const consumer = await js.consumers.get(stream, { filter_subjects: [subject] });
      const pending = Math.min(limit, (await consumer.info()).num_pending);
      if (pending === 0) return msgs;
      const iter = await consumer.fetch({ max_messages: pending });
      for await (const m of iter) {
        try {
          msgs.push(m.json<CotalMessage>());
        } catch {
          /* skip undecodable */
        }
      }
    } catch {
      /* stream missing or consumer create denied (non-admin) */
    }
    return msgs;
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Surface the connection's async status errors on our `error` event. NATS reports
   * publish permission violations *only* here (subscription/request ones too), never on
   * the failing call — so without this an over-tight ACL silently drops the agent's
   * traffic and it just looks "absent". We annotate permission denials explicitly so a
   * denial is never mistaken for absence (which already has a benign cause: MCP reconnect).
   */
  private watchStatus(): void {
    if (!this.nc) return;
    void (async () => {
      for await (const s of this.nc!.status()) {
        if (s.type === "error") this.emit("error", describeStatusError(s.error));
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** The error message for a guard that finds the endpoint unbound: "reconnecting" during a
   *  rebuild's null window OR an inter-retry backoff (so a concurrent op reports the real
   *  reason, not "not started" — `reestablishing` spans the whole retry loop incl. backoff),
   *  else "endpoint not started" (genuine pre-start). */
  private notLiveMsg(): string {
    return this.reconnecting || this.reestablishing
      ? "reconnecting — try again shortly"
      : "endpoint not started";
  }

  private async publishMsg(subject: string, msg: CotalMessage): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    // msgID = message id → free server-side dedup across JetStream redelivery.
    await this.js.publish(subject, JSON.stringify(msg), { msgID: msg.id });
  }

  /** Create the three backing streams for this space (idempotent). Open-mode lazy create;
   *  the same definitions are used by `cotal up` at privileged setup. */
  private async ensureStreams(): Promise<void> {
    if (!this.jsm) throw new Error("endpoint not started");
    await createSpaceStreams(this.jsm, this.space);
  }

  /**
   * Privileged: pre-create an agent's bind-only chat live-tail durable (auth mode), filtered to its
   * `subscribe` set, so the agent can BIND it without holding CONSUMER.CREATE/UPDATE on CHAT — its
   * live read can't be self-widened past `allowSubscribe`. The creator sets the filter; the agent
   * never does (mirrors {@link provisionDmInbox}). Idempotent. The caller must be permissive on CHAT.
   */
  async provisionChatDurable(targetId: string, subscribe: string[]): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(chatStream(this.space), chatDurableConfig(this.space, targetId, subscribe));
  }

  /**
   * Privileged: move an agent's bind-only chat durable to a new channel set — the write half of the
   * mediated join/leave. The manager calls this AFTER validating the set ⊆ the agent's
   * `allowSubscribe`; the agent itself has no UPDATE grant, so this trusted path is the only way its
   * live filter moves. The filter is rebuilt from channel names here (not from agent-supplied
   * subjects) so a caller can't smuggle a hand-built filter.
   */
  async setChatFilterFor(targetId: string, channels: string[]): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.update(chatStream(this.space), chatDurable(targetId), {
      filter_subjects: collapseFilterSubjects(channels.map((ch) => chatSubject(this.space, "*", ch))),
    });
  }

  /**
   * Privileged: pre-create an agent's DM inbox durable (auth mode), so the agent can BIND
   * it without holding CONSUMER.CREATE on DM_<space>. The creator sets the filter to
   * inst.<targetId>.* — the agent never gets to choose it, which is what stops a peer from
   * creating a durable filtered to someone else's inbox. Idempotent (byte-identical config),
   * safe to call again on manager restart. The caller must be permissive on DM_<space>.
   */
  async provisionDmInbox(targetId: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(dmStream(this.space), dmDurableConfig(this.space, targetId));
  }

  /**
   * Privileged: pre-create a role's shared TASK work-queue durable (auth mode), so agents
   * of that role can BIND it without holding CONSUMER.CREATE on TASK_<space>. The creator
   * sets the filter to svc.<role>.* — agents never choose it, which stops cross-role drain.
   * Idempotent per role. The caller must be permissive on TASK_<space>.
   */
  async provisionTaskQueue(role: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(taskStream(this.space), taskDurableConfig(this.space, role));
  }

  /** Lazily obtain a JetStream manager — so a non-consuming endpoint (e.g. the supervisor,
   *  consume:false) can still pre-create others' durables. */
  private async manager(): Promise<JetStreamManager> {
    if (!this.nc) throw new Error("endpoint not started");
    this.jsm ??= await jetstreamManager(this.nc);
    return this.jsm;
  }

  /** Bind this endpoint's durable consumers: DM inbox, chat, and (if a role) the task queue. */
  private async startConsumers(): Promise<void> {
    if (!this.jsm) throw new Error("endpoint not started");
    const id = this.card.id;

    // Unicast: this instance's private DM inbox. Open mode self-creates; auth mode BINDS a
    // durable the provisioner pre-created (agents are denied CONSUMER.CREATE on DM_<space>,
    // since the create-time filter_subject is the attack surface — see provisionDmInbox).
    if (!this.creds) {
      await this.jsm.consumers.add(
        dmStream(this.space),
        dmDurableConfig(this.space, id, {
          ackWaitMs: this.ackWaitMs,
          inactiveThresholdMs: this.inactiveThresholdMs,
        }),
      );
    }
    await this.pump(dmStream(this.space), dmDurable(id));

    // Multicast: a DeliverPolicy.New *tail* of our channels. History is NOT a durable replay —
    // it's an explicit, per-channel backfill on join (replay-policy gated, below), the only
    // shape that can honor per-channel policy given deliver_policy is consumer-wide.
    if (this.channels.length) {
      const durable = chatDurable(id);
      const want = collapseFilterSubjects(this.channels.map((ch) => chatSubject(this.space, "*", ch)));
      // Auth mode: the chat live-tail durable is pre-created BIND-ONLY by the provisioner (the agent
      // is denied CONSUMER.CREATE/UPDATE on CHAT — its filter is the read boundary). Open mode: the
      // agent owns it and self-creates. Either way it is a DeliverPolicy.New tail; per-channel
      // history is the explicit backfill below (the only shape that honors per-channel replay
      // policy given deliver_policy is consumer-wide).
      const info = await this.consumerInfo(chatStream(this.space), durable);
      if (!info) {
        if (this.creds)
          throw new Error(
            `chat durable ${durable} not pre-created — a launcher must call provisionChatDurable ` +
              `(auth mode binds the durable, it never self-creates)`,
          );
        await this.jsm.consumers.add(
          chatStream(this.space),
          chatDurableConfig(this.space, id, this.channels, {
            ackWaitMs: this.ackWaitMs,
            inactiveThresholdMs: this.inactiveThresholdMs,
          }),
        );
      }
      // First bind to this durable (open self-create, or an auth pre-create never consumed) ⇒
      // backfill the full subscribe set. A later reconnect (the consumed cursor has advanced)
      // backfills only channels the config GAINED — un-acked live messages auto-redeliver, so a full
      // re-backfill would double up. With pre-create, `info` always exists under auth, so the
      // consumed cursor — not the durable's existence — is what tells first-bind from reconnect.
      //
      // Caveat (best-effort, by design): `consumer_seq > 0` proves the durable has delivered at
      // least once, NOT that the initial backfill completed. A crash between the first delivery and
      // backfillArmed() makes the next bind take the reconnect path and skip the full pre-bind
      // backfill. This is unchanged from the prior self-create path (which keyed on durable
      // existence and had the same gap — and was actually weaker: a crash before any delivery left
      // the durable existing, so it never re-backfilled; consumer_seq still 0 here re-backfills).
      // Reliable FORWARD delivery is the durable's job (un-acked redelivery); pre-bind history is
      // opportunistic. A backfill-completion marker would make it reliable — a deferred follow-up.
      const consumed = (info?.delivered?.consumer_seq ?? 0) > 0;
      if (!consumed) {
        // Arm the tail-drop watermarks BEFORE pump starts, so the tail can never deliver a
        // just-bound channel's message un-watermarked (which would double-emit: live + backfill).
        const armed = await this.armJoin(this.channels);
        await this.pump(chatStream(this.space), durable);
        await this.backfillArmed(armed);
      } else {
        // Reconnect: resume the tail, then backfill any channels the config GAINED since.
        await this.pump(chatStream(this.space), durable);
        const haveFilters =
          info!.config.filter_subjects ?? (info!.config.filter_subject ? [info!.config.filter_subject] : []);
        const gained = this.channels.filter(
          (c) => !haveFilters.some((f) => subjectMatches(f, chatSubject(this.space, "*", c))),
        );
        const armed = gained.length ? await this.armJoin(gained) : undefined;
        // Reconcile the durable's filter to the CURRENT config — OPEN MODE ONLY. Auth mode is
        // bind-only (no UPDATE grant): the durable's filter is authoritative, moved solely by the
        // mediated join/leave control op, so the agent never self-reconciles it.
        if (!this.creds && !sameSet(haveFilters, want))
          await this.jsm.consumers.update(chatStream(this.space), durable, { filter_subjects: want });
        if (armed) await this.backfillArmed(armed);
      }
    }

    // Anycast: a shared work-queue consumer for our role — one instance grabs each task.
    // Open mode self-creates; auth mode BINDS the provisioner-pre-created svc_<role>
    // durable (agents are denied CONSUMER.CREATE on TASK_<space>, since the create-time
    // filter is the cross-role-drain attack surface — see provisionTaskQueue).
    if (this.card.role) {
      if (!this.creds) {
        await this.jsm.consumers.add(
          taskStream(this.space),
          taskDurableConfig(this.space, this.card.role, { ackWaitMs: this.ackWaitMs }),
        );
      }
      await this.pump(taskStream(this.space), taskDurable(this.card.role));
    }
  }

  /** Drive one consumer: decode, drop our own echo, and hand each message to listeners with ack control. */
  private async pump(stream: string, durable: string): Promise<void> {
    if (!this.js) throw new Error("endpoint not started");
    const consumer = await this.js.consumers.get(stream, durable);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        let msg: CotalMessage;
        try {
          msg = m.json<CotalMessage>();
        } catch (e) {
          m.term(); // undecodable — never redeliver
          this.emit("error", e as Error);
          continue;
        }
        // Authenticity guard (fail closed): the sender is encoded in the subject, which the
        // server policed who could publish. The payload `from` is advisory — it must match,
        // and a missing `from` or an unparseable subject on a delivery is itself an anomaly.
        // Reject (term — a spoof is permanently invalid, never redeliver) BEFORE any handler.
        const parsed = parseSubject(m.subject);
        if (!parsed || !msg.from || msg.from.id !== parsed.sender) {
          m.term();
          this.emit(
            "error",
            new Error(
              `dropped message on ${m.subject}: payload from ${msg.from?.id ?? "(none)"} ` +
                `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
            ),
          );
          continue;
        }
        if (msg.from.id === this.card.id) {
          m.ack(); // our own echo — advance past it
          continue;
        }
        // No-replay + dedup (chat only): drop a message at/below this channel's join watermark
        // — pre-join history the New tail still carries for a *lagging* joiner (cursor behind the
        // frontier), and the overlap a replay backfill already delivered. Must ack, or JetStream
        // redelivers it forever. The drop is here, before the message becomes model context.
        if (parsed.kind === "chat") {
          const wm = this.dropWatermark(parsed.rest);
          if (wm !== undefined && m.seq <= wm) {
            m.ack();
            continue;
          }
        }
        const delivery: Delivery = { ack: () => m.ack(), nak: () => m.nak() };
        this.emit("message", msg, delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** The highest join watermark among the joined subscriptions that cover `concreteChannel`
   *  (a wildcard sub like `team.>` covers `team.backend`), or undefined if none — the tail
   *  drops a chat message with `seq <= ` this. */
  private dropWatermark(concreteChannel: string): number | undefined {
    let wm: number | undefined;
    for (const [pattern, seq] of this.joinSeq)
      if (subjectMatches(pattern, concreteChannel) && (wm === undefined || seq > wm)) wm = seq;
    return wm;
  }

  /** The durable's info (rebind) or null (fresh — 404). Gates create/backfill to the join event
   *  and exposes the current `filter_subjects` for restart reconciliation. */
  private async consumerInfo(stream: string, durable: string): Promise<ConsumerInfo | null> {
    if (!this.jsm) throw new Error("endpoint not started");
    try {
      return await this.jsm.consumers.info(stream, durable);
    } catch {
      return null; // 404 — fresh durable
    }
  }

  /** Current frontier (last sequence) of the chat stream — a channel's join watermark, and the
   *  focus-watermark a connector captures on entering `focus` (recall reads ambient after it). */
  async chatFrontier(): Promise<number> {
    if (!this.jsm) throw new Error("endpoint not started");
    return (await this.jsm.streams.info(chatStream(this.space))).state.last_seq;
  }

  /** Phase 1 of a join — arm each channel's tail-drop watermark at the current frontier. MUST run
   *  BEFORE the filter flip (consumers.update, or pump on a fresh create) so the tail can never
   *  carry a just-joined message un-watermarked — which would double-emit it (live + backfill).
   *  Returns the per-channel frontiers for {@link backfillArmed}. */
  private async armJoin(channels: string[]): Promise<Map<string, number>> {
    const frontiers = new Map<string, number>();
    for (const ch of channels) {
      const frontier = await this.chatFrontier();
      this.joinSeq.set(ch, frontier);
      frontiers.set(ch, frontier);
    }
    return frontiers;
  }

  /** Phase 2 of a join — backfill each armed channel's history up to its frontier (replay-gated),
   *  AFTER the filter flip. Returns the total backfilled. */
  private async backfillArmed(frontiers: Map<string, number>): Promise<number> {
    let total = 0;
    for (const [ch, frontier] of frontiers) {
      const policy = await this.joinPolicyFresh(ch);
      if (policy.replay) total += await this.backfillChannel(ch, frontier, policy.windowMs);
    }
    return total;
  }

  /** Replay policy + backfill window read straight from the registry bucket (vs the watch cache)
   *  — the authoritative read for a join decision (a join is infrequent, and at startup the async
   *  cache may not have caught up). Falls to the built-in default only with no registry open. */
  private async joinPolicyFresh(channel: string): Promise<{ replay: boolean; windowMs?: number }> {
    if (!this.channelKv) return { replay: effectiveReplay(undefined, undefined) };
    // A wildcard subscription (`review.>`) has no single registry entry — and `>`/`*` are illegal
    // KV keys, so a per-channel get would throw. Read only the space defaults for it; concrete
    // channels still get their per-channel override.
    const [cfg, defaults] = await Promise.all([
      isConcreteChannel(channel) ? readChannelConfig(this.channelKv, channel) : Promise.resolve(undefined),
      readChannelDefaults(this.channelKv),
    ]);
    return { replay: effectiveReplay(cfg, defaults), windowMs: effectiveReplayWindowMs(cfg, defaults) };
  }

  /**
   * Read retained chat history on ONE channel subject through a name-scoped, single-filter
   * EPHEMERAL pull consumer — the broker-contained replacement for the removed Direct Get. The
   * create rides `$JS.API.CONSUMER.CREATE.<CHAT>.<chathist_id>.<subject>`, whose trailing filter
   * token nats-server pins to the request body (JSConsumerCreateFilterSubjectMismatchErr, code
   * 10131) — so an agent can only ever replay a channel its `allowSubscribe` grants. Single filter
   * only (plural isn't ACL-constrainable); `AckPolicy.None` + `mem_storage` so it leaves no durable
   * state, and it is deleted right after. Returns raw messages in stream order from `start`,
   * stopping once past `untilSeq` (exclusive of it) or after `limit`. The per-instance name means
   * calls must be serial — every reader here awaits to completion, so they are.
   */
  private async collectHistory(
    subject: string,
    start: { seq: number } | { time: Date },
    opts: { untilSeq?: number; limit?: number } = {},
  ): Promise<JsMsg[]> {
    if (!this.jsm || !this.js) throw new Error("endpoint not started");
    const stream = chatStream(this.space);
    const name = chatHistDurable(this.card.id);
    const out: JsMsg[] = [];
    // Clear any consumer leaked by a crashed prior read before re-creating it with THIS read's
    // single filter (the read ACL is enforced at create — see the doc above).
    try { await this.jsm.consumers.delete(stream, name); } catch { /* none — fine */ }
    await this.jsm.consumers.add(stream, {
      name,
      filter_subject: subject,
      ack_policy: AckPolicy.None,
      mem_storage: true,
      inactive_threshold: nanos(30_000),
      ...("time" in start
        ? { deliver_policy: DeliverPolicy.StartTime, opt_start_time: start.time.toISOString() }
        : { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: start.seq }),
    });
    try {
      const consumer = await this.js.consumers.get(stream, name);
      let pending = (await consumer.info()).num_pending;
      while (pending > 0) {
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          if (opts.untilSeq !== undefined && m.seq > opts.untilSeq) return out; // crossed the frontier
          out.push(m);
          if (opts.limit !== undefined && out.length >= opts.limit) return out;
        }
        if (got < want) break; // drained early
        pending -= got;
      }
    } finally {
      try { await this.jsm.consumers.delete(stream, name); } catch { /* already gone */ }
    }
    return out;
  }

  /** Read a channel's retained history up to `upToSeq` (the join frontier) and emit each message
   *  as a `historical` "message" event. `sinceMs` bounds how far back via a native consumer
   *  `start_time` (now − window); unset ⇒ the full retained window. New messages (`seq > upToSeq`)
   *  are skipped — the live tail owns them. Reads through the contained {@link collectHistory}. */
  private async backfillChannel(channel: string, upToSeq: number, sinceMs?: number): Promise<number> {
    const subject = chatSubject(this.space, "*", channel);
    const start = sinceMs === undefined ? { seq: 1 } : { time: new Date(Date.now() - sinceMs) };
    let msgs: JsMsg[];
    try {
      msgs = await this.collectHistory(subject, start, { untilSeq: upToSeq });
    } catch (e) {
      this.emit("error", e as Error);
      return 0;
    }
    const noop: Delivery = { ack: () => {}, nak: () => {} };
    let n = 0;
    for (const sm of msgs) {
      let msg: CotalMessage;
      try {
        msg = sm.json<CotalMessage>();
      } catch {
        continue; // skip undecodable
      }
      // Same authenticity guard as the tail; skip our own echoes in history.
      const parsed = parseSubject(sm.subject);
      if (!parsed || msg.from?.id !== parsed.sender || msg.from.id === this.card.id) continue;
      // Backfill only ever reads the chat stream, so the authenticated class is always "channel".
      this.emit("message", msg, noop, { historical: true, kind: "channel" } satisfies MessageMeta);
      n++;
    }
    return n;
  }

  /**
   * Replay-gated pull of a channel's retained ambient from `sinceSeq` (exclusive) forward — the
   * focus-recall read behind `cotal_inbox`. Returns the messages (NOT emitted — this is a pull,
   * not a push into context) plus `dropped: true` when the channel's earliest *retained* message
   * is already newer than the watermark, i.e. some ambient aged out of the per-subject window and
   * the caller must say so rather than silently short the window.
   *
   * Honors the **same** per-channel replay gate as join-backfill ({@link joinPolicyFresh}): a
   * `replay=off` channel returns nothing, so `focus` can't become a history bypass for a channel
   * that denies replay to everyone else (the read ACL bounds *which* channels recall can touch; this
   * app gate bounds *whether* a permitted channel replays).
   */
  async recallChannel(
    channel: string,
    sinceSeq: number,
  ): Promise<{ messages: CotalMessage[]; dropped: boolean }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    if (!isConcreteChannel(channel)) return { messages: [], dropped: false };
    const policy = await this.joinPolicyFresh(channel);
    if (!policy.replay) return { messages: [], dropped: false };
    const subject = chatSubject(this.space, "*", channel);
    let raw: JsMsg[];
    try {
      raw = await this.collectHistory(subject, { seq: sinceSeq + 1 });
    } catch (e) {
      this.emit("error", e as Error);
      raw = [];
    }
    const collected: CotalMessage[] = [];
    for (const sm of raw) {
      let msg: CotalMessage;
      try {
        msg = sm.json<CotalMessage>();
      } catch {
        continue; // skip undecodable
      }
      // Same authenticity guard as the tail/backfill; skip our own echoes.
      const parsed = parseSubject(sm.subject);
      if (!parsed || msg.from?.id !== parsed.sender || msg.from.id === this.card.id) continue;
      collected.push(msg);
    }
    const dropped = await this.channelDropped(subject, sinceSeq);
    return { messages: collected, dropped };
  }

  /** Did focus recall on `subject` miss ambient that aged out past the watermark? Ambient is only
   *  ever discarded once a sender-subject reaches {@link MAX_MSGS_PER_SUBJECT} (`DiscardPolicy.Old`);
   *  below the cap nothing was evicted, so the window is complete — return false without crying
   *  wolf. At the cap, the surviving oldest seq decides: if it already postdates the watermark, the
   *  eviction reached into the "since you focused" window. (Avoids the false positive of comparing a
   *  per-subject oldest against the stream-global frontier, which fires on any other channel's
   *  traffic.) */
  private async channelDropped(subject: string, sinceSeq: number): Promise<boolean> {
    if (!this.jsm) return false;
    let maxPerSubject = 0;
    try {
      const info = await this.jsm.streams.info(chatStream(this.space), { subjects_filter: subject });
      for (const count of Object.values(info.state.subjects ?? {}))
        maxPerSubject = Math.max(maxPerSubject, count);
    } catch (e) {
      if ((e as { code?: number }).code !== 404) this.emit("error", e as Error);
      return false; // stream/subject missing — nothing retained, nothing dropped
    }
    if (maxPerSubject < MAX_MSGS_PER_SUBJECT) return false; // never hit the cap ⇒ never evicted
    const oldest = await this.channelOldestSeq(subject);
    return oldest !== undefined && oldest > sinceSeq + 1;
  }

  /** Sequence of the earliest message still retained on a channel subject (any sender), or
   *  undefined if nothing is retained. One message through the contained {@link collectHistory} —
   *  used for the recall drop marker. */
  private async channelOldestSeq(subject: string): Promise<number | undefined> {
    if (!this.jsm) return undefined;
    try {
      const [first] = await this.collectHistory(subject, { seq: 1 }, { limit: 1 });
      return first?.seq;
    } catch (e) {
      this.emit("error", e as Error);
      return undefined;
    }
  }

  private async publishPresence(): Promise<void> {
    if (!this.kv) return;
    const p: Presence = {
      card: this.card,
      status: this.status,
      activity: this.activity,
      ts: Date.now(),
    };
    await this.kv.put(this.card.id, JSON.stringify(p));
  }

  private async startPresenceWatch(): Promise<void> {
    if (!this.kv) return;
    const iter = await this.kv.watch();
    void (async () => {
      for await (const e of iter) this.handleKvEntry(e);
    })().catch((e) => this.emit("error", e as Error));
  }

  /** Watch the channel registry: replay existing keys, then stream updates, into the local
   *  cache. Best-effort — a registry the endpoint can't read leaves the cache empty (effective
   *  policy then falls back to the default), never a fault. */
  private async startChannelWatch(): Promise<void> {
    if (!this.channelKv) return;
    const iter = await this.channelKv.watch();
    void (async () => {
      for await (const e of iter) this.handleChannelEntry(e);
    })().catch((e) => this.emit("error", e as Error));
  }

  private handleChannelEntry(e: KvEntry): void {
    const gone = e.operation === "DEL" || e.operation === "PURGE";
    if (e.key === CHANNEL_DEFAULTS_KEY) {
      if (gone) this.channelDefaults = {};
      else
        try {
          this.channelDefaults = e.json<ChannelDefaults>();
        } catch {
          /* keep last good */
        }
      return;
    }
    if (gone) {
      this.channelConfigs.delete(e.key);
      return;
    }
    try {
      this.channelConfigs.set(e.key, e.json<ChannelConfig>());
    } catch {
      /* keep last good */
    }
  }

  private handleKvEntry(e: KvEntry): void {
    if (e.operation === "DEL" || e.operation === "PURGE") {
      this.markOffline(e.key);
      return;
    }
    let p: Presence;
    try {
      p = e.json<Presence>();
    } catch {
      return;
    }
    this.applyPresence(e.key, p);
  }

  private applyPresence(id: string, raw: Presence): void {
    const prev = this.roster.get(id);
    const stale = Date.now() - raw.ts > this.ttlMs;
    const p: Presence =
      stale && raw.status !== "offline" ? { ...raw, status: "offline" } : raw;

    // First time we hear about an already-offline peer (stale snapshot): record quietly.
    if (!prev && p.status === "offline") {
      this.roster.set(id, p);
      this.emit("roster", this.getRoster());
      return;
    }

    // Heartbeat refresh with no real change: bump liveness quietly and don't
    // emit — otherwise the periodic keep-alive looks like a stream of "updates".
    if (
      prev &&
      prev.status !== "offline" &&
      p.status !== "offline" &&
      prev.status === p.status &&
      prev.activity === p.activity
    ) {
      this.roster.set(id, p);
      return;
    }

    this.roster.set(id, p);
    const type: "join" | "update" | "offline" =
      p.status === "offline"
        ? "offline"
        : !prev || prev.status === "offline"
          ? "join"
          : "update";
    this.emit("presence", { type, presence: p });
    this.emit("roster", this.getRoster());
  }

  /** Mark a known peer offline (on KV delete/purge), keeping it in the roster. */
  private markOffline(id: string): void {
    const prev = this.roster.get(id);
    if (!prev || prev.status === "offline") return;
    const offline: Presence = { ...prev, status: "offline" };
    this.roster.set(id, offline);
    this.emit("presence", { type: "offline", presence: offline });
    this.emit("roster", this.getRoster());
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [, p] of this.roster) {
      if (p.status !== "offline" && now - p.ts > this.ttlMs) {
        p.status = "offline";
        this.emit("presence", { type: "offline", presence: p });
        changed = true;
      }
    }
    if (changed) this.emit("roster", this.getRoster());
  }
}

/** The id token of a chat-stream durable, or null if it isn't one — the inverse of
 *  `chatDurable` (`chat_<token(id)>`). token() is lossy, so this returns the token, not the
 *  original id; callers match it forward against `token(card.id)`. */
function chatDurableToken(durable: string): string | null {
  const prefix = "chat_";
  return durable.startsWith(prefix) ? durable.slice(prefix.length) : null;
}

/** Map an authenticated parsed-subject kind to the message class surfaced to "message" listeners.
 *  Throws on `ctl` (control-plane is request/reply, never a "message") — per repo convention, no
 *  silent default: an unexpected delivering kind is a bug, not something to swallow. */
function kindFromParsed(kind: ParsedSubject["kind"]): MessageMeta["kind"] {
  switch (kind) {
    case "chat":
      return "channel";
    case "inst":
      return "dm";
    case "svc":
      return "anycast";
    default:
      throw new Error(`cannot derive a message kind from subject kind "${kind}"`);
  }
}

/** Set equality over two subject lists (order/duplicate-insensitive). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Auth subset of connect() options, shared by the endpoint and isReachable. */
interface AuthOpts {
  token?: string;
  user?: string;
  pass?: string;
  creds?: string;
  tls?: boolean;
}

function authOpts(a: AuthOpts) {
  const tls = a.tls ? {} : undefined;
  // creds (JWT/nkey) are mutually exclusive with token/user/pass — reject rather than
  // silently pick one, so a misconfigured caller fails loud.
  if (a.creds) {
    if (a.token || a.user || a.pass)
      throw new Error("creds are mutually exclusive with token/user/pass auth");
    return { authenticator: credsAuthenticator(new TextEncoder().encode(a.creds)), tls };
  }
  return { token: a.token, user: a.user, pass: a.pass, tls };
}

/** Turn a raw async-status error into one whose message says *why* — a permission
 *  violation looks like absence unless it's named as a denial. */
function describeStatusError(err: Error): Error {
  if (err instanceof PermissionViolationError) {
    return new Error(
      `NATS permission denied: cannot ${err.operation} "${err.subject}" — check this ` +
        `endpoint's ACLs (a denied peer looks "absent" rather than blocked)`,
      { cause: err },
    );
  }
  return err;
}

/** True when a failure is a NATS *permission denial* — the subject is forbidden to this
 *  endpoint's creds — rather than a missing responder or a timeout. The two need opposite
 *  fixes (grant the capability vs. start/await the service), so callers (e.g. a control
 *  request that can't reach the manager) must tell them apart instead of defaulting to
 *  "service down". Unwraps a wrapped `cause` and falls back to the server's error text, since
 *  a denied publish can surface either as the typed error or inside a request rejection. */
export function isPermissionDenied(e: unknown): boolean {
  if (e instanceof PermissionViolationError) return true;
  if ((e as { cause?: unknown } | null)?.cause instanceof PermissionViolationError) return true;
  return /permissions?\s+violation/i.test(String((e as { message?: unknown } | null)?.message ?? ""));
}

/** Whether a NATS server is *running* at `servers`. True on a successful connect AND on an
 *  auth rejection — an auth error means a server is there, just refusing these creds (so the
 *  caller should surface the real auth failure, not a misleading "server down", and `up`
 *  must not try to start a duplicate on the bound port). Only a genuine connection failure
 *  (refused / timeout / no server) returns false. */
export async function isReachable(
  servers: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const nc = await connect({
      servers,
      timeout: opts.timeoutMs ?? 1000,
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return true;
  } catch (e) {
    return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
  }
}
