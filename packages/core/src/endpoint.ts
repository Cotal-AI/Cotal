import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  connect,
  credsAuthenticator,
  nanos,
  AuthorizationError,
  PermissionViolationError,
  UserAuthenticationExpiredError,
  NoRespondersError,
  RequestError,
  type NatsConnection,
  type Subscription,
} from "@nats-io/transport-node";
import { idFromCreds } from "./identity.js";
import { assertValidName } from "./resolve.js";
import { createSpaceStreams, dmDurableConfig, dlvDurableConfig, taskDurableConfig, fanoutDurableConfig, inboxReaderConfig, MAX_MSGS_PER_SUBJECT, MANAGER_LEASE_TTL_MS } from "./streams.js";
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
  AttentionMode,
  ChannelMode,
  CotalMessage,
  DeliveryClass,
  MembershipRecord,
  ChannelMembership,
  MembershipEntry,
  MembershipSnapshot,
  Plane3Entry,
} from "./types.js";
import {
  openMembersRegistry,
  commitMember,
  tombstoneMember,
  activateMember,
  readMember,
  listMembers,
  durableEligible,
  StaleMembershipWrite,
} from "./members.js";
import { openAclRegistry, readAcl, commitAcl as writeAclRecord } from "./acls.js";
import { openDeliveryRegistry, type DeliveryLeaseInfo, type ManagerLeaseInfo } from "./lease.js";
import {
  openChannelRegistry,
  effectiveReplay,
  effectiveReplayWindowMs,
  effectiveDeliveryClass,
  readChannelConfig,
  readChannelDefaults,
} from "./channels.js";
import {
  anycastSubject,
  CHANNEL_DEFAULTS_KEY,
  chatStream,
  chatHistDurable,
  chatSubject,
  controlServiceSubject,
  CONTROL_SELF_SERVICE,
  CONTROL_DELIVERY,
  dmStream,
  dmDurable,
  dlvStream,
  dlvDurable,
  dlvSubject,
  dinboxSubject,
  inboxStream,
  parseDinboxOwner,
  FANOUT_DURABLE,
  INBOX_READER_DURABLE,
  leaseKey,
  managerBucket,
  MANAGER_LEASE_KEY,
  chatWildcard,
  assertValidChannel,
  channelInAllow,
  isConcreteChannel,
  normalizeMentions,
  parseSubject,
  type ParsedSubject,
  presenceBucket,
  membershipBucket,
  MEMBERSHIP_FEED_KEY,
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
  /** Open + watch the channel registry (default true). Independent of {@link watchPresence}: a
   *  presence-only supervisor sets this false to track the roster WITHOUT opening the channel-registry
   *  cache — so its cred needs no channel-registry read grant (residual 2). No effect when `consume` is
   *  true: the join-time replay decision reads the registry, so a consumer always opens it. */
  watchChannels?: boolean;
  /** Create inbound stream consumers (DM / chat / anycast). Default true; a pure observer sets false. */
  consume?: boolean;
  /** Initial per-channel attention overrides to publish in presence from the first heartbeat (the
   *  connector's file-default seed). Mirror only — never read back into delivery. */
  channelModes?: Record<string, ChannelMode>;
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

/** Plane-3 trusted-reader redelivery ceiling: a dinbox entry that keeps failing re-auth-defer
 *  (unknown owner) or DELIVER transfer is `term()`d + surfaced after this many redeliveries, so one
 *  stuck/poison entry can't head-of-line the single shared reader forever. */
const READER_MAX_REDELIVERIES = 10;

/** A value or a promise of it — the Plane-3 `aclFor` reads the durable ACL registry FRESH per entry
 *  (async), so the reader/fan-out call sites await it. */
type MaybePromise<T> = T | Promise<T>;

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
  private readonly doWatchChannels: boolean;
  private readonly doConsume: boolean;
  private readonly ackWaitMs: number;
  private readonly inactiveThresholdMs: number;

  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private kv?: KV;
  private channelKv?: KV;
  /** Plane-3 durable-membership registry KV — lazily opened by the privileged delivery daemon (or a
   *  short-lived provisioner). */
  private membersKv?: KV;
  private aclKv?: KV;
  private deliveryKv?: KV;
  private managerLeaseKv?: KV;
  private membershipKv?: KV;
  /** The live `ctl.delivery` serve subscription (delivery daemon) — re-created on every (re)connect by
   *  {@link armDeliveryControl}; tracked so the stale one is dropped on reconnect. */
  private deliveryServeSub?: import("@nats-io/transport-node").Subscription;
  /** When set, this endpoint hosts the Plane-3 fan-out writer + trusted reader (the server-side delivery
   *  daemon). `aclFor` maps an owner id to its current read ACL (`allowSubscribe`) for the reader's
   *  re-authorization — read FRESH per entry from the durable ACL registry KV, hence async. */
  private plane3?: { aclFor: (owner: string) => MaybePromise<string[] | undefined> };
  /** Live local cache of the channel registry (key = channel token), kept by a KV watch. */
  private readonly channelConfigs = new Map<string, ChannelConfig>();
  private channelDefaults: ChannelDefaults = {};
  /** Per-subscription join watermark: the stream frontier captured when a channel was joined.
   *  The tail ack-drops chat messages with `seq <= watermark` (suppresses pre-join history for
   *  a lagging joiner + dedups the backfill overlap). Keyed by the subscription pattern (may be
   *  wildcard), so the drop matches every concrete channel the pattern subsumes. */
  private readonly joinSeq = new Map<string, number>();
  /** Serializes history reads ({@link collectHistory}): they share the fixed per-instance
   *  `chathist_<id>` consumer, so overlapping reads would delete/recreate it under one another. */
  private histLock: Promise<unknown> = Promise.resolve();
  private readonly subs: Subscription[] = [];
  private readonly streamMsgs: ConsumerMessages[] = [];
  /** Per-channel native core subscriptions (SPEC v0.3) — the manager-free live read path for boot +
   *  runtime channels (there is no per-instance chat durable). Keyed by channel so leave unsubscribes
   *  just one. */
  private readonly chatSubs = new Map<string, Subscription>();
  /** Channels whose core-sub the broker refused (async sub.allow violation) — read by the
   *  broker-confirmed join: a denied subscribe is NOT a successful join (SPEC conformance #13). */
  private readonly chatSubDenied = new Set<string>();
  /** Channels this session has a Plane-3 durable backstop for (per-channel join GENERATION, from
   *  durableJoin, so leave passes it back for the stale-leave guard). A durable channel's core-sub is
   *  NOT coverage-dropped — it stays a live wake-hint, dedup-coalesced with the Plane-3 durable copy by
   *  id-dedup. Drives the durable-state surface + routes leave to `durableLeave`. PERSISTS across
   *  reconnect (like `this.channels`): the membership record + the `dlv_<id>` durable are persistent so
   *  the backstop survives a reconnect on its own; the agent can't re-read the privileged members KV,
   *  so this in-memory mirror is kept, not rebuilt. Cleared only on full stop. */
  private readonly plane3Channels = new Map<string, number>();
  /** Channels whose live sub was REFUSED while they held a Plane-3 durable membership, whose §7
   *  tombstone has not yet confirmed (channel → join generation). {@link closeRefusedMembership} retries
   *  the tombstone until it lands; until then this is a `durable-unclosed` state surfaced via
   *  {@link pendingDurableLeaves} (the connector shows it in `cotal_channels`, never as ordinary
   *  absence). Persists across reconnect; cleared on tombstone success or full stop. */
  private readonly pendingDurableLeave = new Map<string, number>();
  /** Boot durable channels whose self-join hasn't yet established a membership (daemon down/absent at
   *  first connect, or a transient `durable:false`). {@link reconcileBootJoin} retries with capped
   *  backoff until the membership exists or the channel is left — so a first-connect daemon outage
   *  self-heals on recovery instead of leaving the channel silently live-only. Surfaced to the connector
   *  via {@link hasDurableMembership} (a joined durable channel NOT yet a member renders degraded). */
  private readonly pendingBootJoins = new Set<string>();
  /** Chat-join subjects currently being broker-confirmed. An out-of-ACL subscribe among these trips an
   *  EXPECTED async permission violation that joinChannel turns into a clean throw, so watchStatus
   *  suppresses it rather than surfacing a spurious connection error. */
  private readonly confirmingChatSubs = new Set<string>();
  /** True until the first successful connect completes its boot backfill — distinguishes first-connect
   *  (backfill the boot channels' history) from a reconnect (reopen the core-subs, no re-backfill).
   *  Persists across reconnect (NOT connection-scoped). Replaces the legacy chat-durable consumed-cursor
   *  signal now that there is no per-instance chat durable. */
  private firstConnect = true;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly roster = new Map<string, Presence>();
  private status: PresenceStatus = "idle";
  private activity?: string;
  /** Mirror of the connector's authoritative attention state, published in presence (advisory). The
   *  endpoint never reads these back into delivery — they exist only to broadcast. */
  private attentionMode?: AttentionMode;
  private channelModes?: Record<string, ChannelMode>;
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
    this.doWatchChannels = opts.watchChannels ?? true;
    this.doConsume = opts.consume ?? true;
    // Seed the presence mirror so file-default channel modes are visible from the first publish
    // (not only after the first runtime toggle). Mirror only — delivery reads the connector's state.
    this.channelModes = opts.channelModes && Object.keys(opts.channelModes).length ? opts.channelModes : undefined;
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
    // pull/display) or consume (the join-time replay decision reads it fresh). A presence-only
    // supervisor (watchChannels:false, consume:false) skips it entirely — it needs no channel cache,
    // so its scoped cred holds no channel-registry read (residual 2). Auth mode OPENs the bucket
    // pre-created at `cotal up`; open mode lazily creates it.
    const watchChannels = this.doWatch && this.doWatchChannels;
    if (watchChannels || this.doConsume) {
      this.channelKv = await openChannelRegistry(this.nc, this.space, { create: !this.creds });
      if (watchChannels) await this.startChannelWatch();
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

    // Re-arm Plane-3 (delivery-daemon-hosted fan-out + trusted reader + ctl.delivery) on every (re)connect — no-op unless this
    // endpoint hosts it. The first arm comes from startPlane3 (after start()); this re-binds the loops
    // a reconnect's clearConnectionScoped() tore down, so a broker blip doesn't silently kill the backstop.
    await this.armPlane3();

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
    for (const sub of this.chatSubs.values()) {
      try {
        sub.unsubscribe();
      } catch {
        /* already closed with the connection */
      }
    }
    this.chatSubs.clear();
    this.chatSubDenied.clear();
    this.confirmingChatSubs.clear();
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
      // Plane-3 KV handles are bound to the old connection too — drop them so the daemon re-opens them on
      // the fresh nc (else durableJoin/leave/list, the reader's ACL re-auth, and lease renew use a dead
      // handle after a reconnect).
      this.membersKv = undefined;
      this.aclKv = undefined;
      this.deliveryKv = undefined;
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

  /** Serve control requests for a service. Returns the subscription so a caller that re-registers on
   *  reconnect (the delivery daemon) can drop the stale one. `boundReply` is REQUIRED for any service
   *  whose responder holds a wildcard publish grant over the service subtree (the delivery daemon's
   *  `ctl.delivery.*.reply.>`): without it, an authenticated caller could set its reply target to a
   *  PEER's reply lane (`ctl.delivery.<victim>.reply.<n>`) and turn the responder into a confused
   *  deputy — the broker does NOT permission-check the requester's embedded reply subject. With it, a
   *  reply is published only when `m.reply` is under the AUTHENTICATED request subject
   *  (`${m.subject}.reply.…`), binding the reply to the broker-policed sender token. The manager's three
   *  lifecycle tiers ALSO require it as of closure (i): they reply on bounded `ctl.<tier>.<caller>.reply.…`
   *  (the manager cred holds the wildcard `ctl.<tier>.*.reply.>` pub — exactly the confused-deputy
   *  condition above), so do NOT drop `boundReply` on them. */
  serveControl(
    service: string,
    handler: (req: ControlRequest) => Promise<ControlReply> | ControlReply,
    opts: { boundReply?: boolean } = {},
  ): import("@nats-io/transport-node").Subscription {
    if (!this.nc) throw new Error("endpoint not started");
    const sub = this.nc.subscribe(controlServiceSubject(this.space, service, "*"), {
      queue: service,
    });
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        // Sender-bound reply guard (confused-deputy fix): never respond to a reply target outside the
        // authenticated request subject's own `.reply.` subtree. Drop silently (don't inject elsewhere).
        if (opts.boundReply && (!m.reply || !m.reply.startsWith(`${m.subject}.reply.`))) {
          this.emit("error", new Error(`rejected ${service} request on ${m.subject}: reply target "${m.reply ?? "(none)"}" is not under the sender's own reply subtree`));
          continue;
        }
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
    return sub;
  }

  /** Send a control request to a service and await its reply (client side). Like {@link requestDelivery},
   *  the reply rides a BOUNDED subject UNDER the request subject (`ctl.<service>.<id>.reply.<uuid>`), not
   *  the per-id `_INBOX` — closure (i): this frees the manager's permission set from needing a position-1
   *  inbox wildcard, so its publish surface can be an exact self-scoped allow-list (no message forging).
   *  `noMux` lets us name the reply subject while keeping NoResponders detection. The random suffix is
   *  defense-in-depth (a predictable suffix would let a peer target an in-flight named reply sub). The
   *  reply sits under the sender's OWN request subject, so the responder's `boundReply` guard accepts it.
   *
   *  CUTOVER (not backward-compatible): an agent cred minted BEFORE closure (i) lacks the
   *  `ctl.<tier>.<id>.reply.>` sub grant — it can still publish the request but cannot subscribe the
   *  reply, so its control calls (spawn/despawn/purge/definePersona, self-stop) hang. The per-user-auth
   *  atomic cutover re-mints every agent; if this change ships ahead of that, agents must be RESPAWNED. */
  async requestControl(
    service: string,
    req: ControlRequestInit,
    timeoutMs = 5000,
  ): Promise<ControlReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = controlServiceSubject(this.space, service, this.card.id);
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    const body: ControlRequest = { ...req, from: req.from ?? this.ref() };
    const m = await this.nc.request(reqSubject, JSON.stringify(body), { timeout: timeoutMs, noMux: true, reply });
    return m.json<ControlReply>();
  }

  /** Send a durable-membership request to the SERVER-SIDE delivery daemon (`ctl.delivery`) and await its
   *  reply. Unlike {@link requestControl}, the reply rides a subject UNDER `ctl.delivery.<id>.>` (not the
   *  per-id `_INBOX`), so the scoped delivery cred can answer without broad inbox-publish — see
   *  CONTROL_DELIVERY. `noMux` lets us name the reply subject while keeping NoResponders detection (so a
   *  caller can fail-closed vs. degrade to live-only when no daemon is present). */
  private async requestDelivery(op: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<ControlReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = controlServiceSubject(this.space, CONTROL_DELIVERY, this.card.id); // ctl.delivery.<id>
    // Reply rides the sender's OWN subtree so the daemon's serveControl boundReply guard accepts it
    // (`${reqSubject}.reply.…`). The sender-bound guard is the COMPLETE confused-deputy closure. The
    // random suffix is genuine defense-in-depth (NOT cosmetic): `noMux` subscribes this SPECIFIC named
    // reply subject (not a standing `.reply.>` wildcard), so a predictable suffix would let a peer target
    // an in-flight reply subscription — randomUUID brings it to parity with the nuid-protected `_INBOX`
    // model. Keep both; don't regress to a counter. (Confirmed by the review panel's fact-check.)
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    const body: ControlRequest = { op, args, from: this.ref() };
    const m = await this.nc.request(reqSubject, JSON.stringify(body), { timeout: timeoutMs, noMux: true, reply });
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

  /** Publish the agent's global attention mode into presence (advisory observability). Mirror only —
   *  delivery decisions stay in the connector's authoritative state. */
  async setAttention(attention: AttentionMode): Promise<void> {
    this.attentionMode = attention;
    await this.publishPresence();
  }

  /** Publish the agent's per-channel attention overrides into presence (advisory). An empty map drops
   *  the field. Mirror only — never read back into delivery. */
  async setChannelModes(modes: Record<string, ChannelMode>): Promise<void> {
    this.channelModes = Object.keys(modes).length ? modes : undefined;
    await this.publishPresence();
  }

  /** Overlay the host's live model onto the card's display-only `meta.model` and republish presence.
   *  For connectors that learn the actual model only *after* launch (e.g. Claude Code's `SessionStart`
   *  hook payload) rather than from an operator pin. Display-only discovery metadata; a no-op when the
   *  value is empty or already current (no redundant publish). The mutated card is read live by every
   *  later publish, so even a pre-connect call surfaces on the first presence write. */
  async setCardModel(model: string): Promise<void> {
    const m = model.trim();
    if (!m || this.card.meta?.model === m) return;
    this.card.meta = { ...(this.card.meta ?? {}), model: m };
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

  /** Effective delivery class for a channel (per-channel override ?? space default ?? "durable"),
   *  from the live watch cache — drives the non-gating delivery-health surface (only durable-class
   *  channels have a Plane-3 backstop to report on). */
  channelDeliveryClass(channel: string): DeliveryClass {
    return effectiveDeliveryClass(this.channelConfigs.get(channel), this.channelDefaults);
  }

  // ---- dynamic subscription (join / leave mid-session) ---------------------

  /** The channels this endpoint is currently subscribed to (live — reflects join/leave). */
  joinedChannels(): string[] {
    return [...this.channels];
  }

  /**
   * Join a channel mid-session: open a native core subscription (manager-free live read, broker-
   * confirmed against `sub.allow`), capture the stream frontier as the join watermark, backfill its
   * history if replay is on, and — for a `durable`-class channel when a delivery daemon is present —
   * request a Plane-3 durable backstop (via `ctl.delivery`). Idempotent: re-joining is a no-op (no
   * re-backfill). Returns the backfill count + whether the durable backstop is active (+ a `reason`
   * when a durable channel couldn't get one).
   */
  async joinChannel(
    channel: string,
  ): Promise<{ joined: boolean; backfilled: number; durable: boolean; reason?: string }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    if (this.channels.includes(channel))
      return { joined: false, backfilled: 0, durable: this.plane3Channels.has(channel) };
    // Arm the watermark BEFORE going live: the backfill reads ≤ frontier and the core-sub only ever
    // delivers post-subscribe live messages (> frontier), so the two never overlap.
    const armed = await this.armJoin([channel]);
    // Live read (SPEC v0.3): open the native core subscription — MANAGER-FREE, broker-enforced by
    // sub.allow. This is what lets an agent join a channel's live feed on its own. The sub.allow
    // refusal is async — broker-confirm before committing local join state; the subscribe handler
    // ALSO drops a channel on ANY refusal (incl. a late one), so this is not a timing gamble (#13).
    this.subscribeChat(channel);
    try {
      await this.confirmChatSub();
    } catch (e) {
      // The confirm boundary (flush) failed — the connection drained/closed mid-join, so we have NO
      // confirmation the subscribe was accepted. Fail closed: undo the half-open join rather than
      // returning as if it were confirmed (a reconnect re-confirms from this.channels, which we never
      // pushed to). unsubscribeChat clears chatSubs + confirmingChatSubs.
      this.unsubscribeChat(channel);
      this.joinSeq.delete(channel);
      throw new Error(`cannot join "${channel}": live subscription could not be confirmed (${(e as Error).message})`);
    }
    this.confirmingChatSubs.delete(chatSubject(this.space, "*", channel));
    if (this.chatSubDenied.has(channel)) {
      this.unsubscribeChat(channel);
      this.joinSeq.delete(channel);
      throw new Error(`cannot join "${channel}": not within this agent's read ACL (allowSubscribe)`);
    }
    this.channels.push(channel);
    // Durable backstop. The live core-sub above already delivers (manager-free). For a `durable`-class
    // channel, request a Plane-3 per-member backstop from the server-side delivery daemon (durableJoin via ctl.delivery) so a post reaches a
    // busy/offline turn — the core-sub stays as the live wake-hint, dedup-coalesced with the Plane-3
    // copy by id-dedup. No manager (open dev / manager-less) ⇒ joined LIVE only, surfaced via `reason`
    // (never silent). A `live`-class channel takes no backstop (joined live is the contract).
    let durable = false;
    let reason: string | undefined;
    if (effectiveDeliveryClass(this.channelConfigs.get(channel), this.channelDefaults) === "durable") {
      try {
        const r = await this.durableJoinChannel(channel);
        if (r.durable) {
          this.plane3Channels.set(channel, r.generation ?? 0);
          durable = true;
        } else {
          reason = r.reason ?? "durable backstop unavailable";
        }
      } catch (e) {
        // No privileged writer (no delivery daemon) or the write was rejected — joined live, backstop
        // unavailable. NOT a join failure: the live subscription is up and authorized.
        reason = `durable backstop unavailable (${(e as Error).message})`;
      }
    }
    const backfilled = await this.backfillArmed(armed);
    return { joined: true, backfilled, durable, ...(reason !== undefined ? { reason } : {}) };
  }

  /** Leave a channel mid-session — MANAGER-FREE for the live read: close the core subscription. For a
   *  Plane-3 durable channel, the membership is tombstoned FIRST at the leave cursor (SPEC §7: leave is
   *  a hard read boundary for the backstop — a pre-leave entry stays deliverable, `seq > leaveCursor` is
   *  denied). FAIL-CLOSED: if the tombstone can't be confirmed the call throws and the leave is NOT
   *  applied (live sub stays up, local mirror intact) so the caller can retry — never close the live
   *  read while the backstop keeps delivering. */
  async leaveChannel(channel: string): Promise<{ left: boolean }> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    if (!this.channels.includes(channel)) return { left: false };
    // Auth + durable-class ⇒ a Plane-3 membership may exist; tombstone it BEFORE touching local state.
    // The join generation comes from the local mirror, but a BOOT membership whose hydration was missed
    // (daemon down at connect) is NOT in the mirror — so re-resolve it from the delivery service on
    // demand. FAIL-CLOSED: fetchMemberships throws on a responder-present error, so a leave whose
    // tombstone can't be confirmed propagates (live sub stays up, mirror intact) for the caller to retry
    // — reporting `left` while the trusted reader keeps transferring to DLV is the fail-open leak. A
    // genuine no-responder (open / no delivery daemon, no Plane-3) means there is no membership to tombstone.
    if (this.creds && effectiveDeliveryClass(this.channelConfigs.get(channel), this.channelDefaults) === "durable") {
      let generation = this.plane3Channels.get(channel);
      if (generation === undefined)
        generation = (await this.fetchMemberships())?.find((m) => m.channel === channel)?.generation;
      if (generation !== undefined) {
        await this.durableLeaveChannel(channel, generation);
        this.plane3Channels.delete(channel);
      }
    }
    this.unsubscribeChat(channel);
    const i = this.channels.indexOf(channel);
    if (i >= 0) this.channels.splice(i, 1);
    this.joinSeq.delete(channel);
    return { left: true };
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
   * Who is a durable member of a channel — read from the privileged members registry (Plane-3),
   * joined with presence for liveness (a member whose peer is gone but lingering shows `live:false`,
   * not a phantom). Only CURRENT, ACTIVATED members (non-tombstoned, and past activation catch-up — a
   * join still completing or that failed catch-up reported durable:false and stays hidden here until
   * confirmed, so this surface never overstates membership). A wildcard registry channel would count for
   * the concrete channels it subsumes, but durable membership is per-concrete-channel, so records are
   * concrete. `live`-class channels carry no durable record — membership there is the live core-sub,
   * not tracked here. Privileged read (the members KV is manager-write/read; agents hold no grant), so
   * it is served by the manager, not an agent capability.
   */
  async channelMembers(channel: string): Promise<ChannelMember[]>;
  async channelMembers(): Promise<Map<string, ChannelMember[]>>;
  async channelMembers(
    channel?: string,
  ): Promise<ChannelMember[] | Map<string, ChannelMember[]>> {
    const members = (await listMembers(await this.membersRegistry())).filter(
      (r) => r.leaveCursor === undefined && r.activated === true,
    );
    const byId = new Map<string, Presence>();
    for (const p of this.roster.values()) byId.set(p.card.id, p);
    const memberForId = (id: string): ChannelMember => {
      const p = byId.get(id);
      return p
        ? { id: p.card.id, name: p.card.name, role: p.card.role, live: p.status !== "offline" }
        : { id, name: id, live: false };
    };
    const byName = (a: ChannelMember, b: ChannelMember) => a.name.localeCompare(b.name);

    if (channel !== undefined)
      return members
        .filter((r) => subjectMatches(r.channel, channel))
        .map((r) => memberForId(r.owner))
        .sort(byName);

    const map = new Map<string, ChannelMember[]>();
    for (const r of members) {
      const arr = map.get(r.channel);
      const m = memberForId(r.owner);
      if (arr) {
        if (!arr.some((x) => x.id === m.id)) arr.push(m);
      } else {
        map.set(r.channel, [m]);
      }
    }
    for (const arr of map.values()) arr.sort(byName);
    return map;
  }

  /** Lazily open the derived membership feed KV (admin/observer read; the delivery daemon writes it).
   *  Read-only here — the dashboard consumes it; agents hold no grant and never call this. */
  private async membershipRegistry(): Promise<KV> {
    if (!this.nc) throw new Error("endpoint not started");
    this.membershipKv ??= await new Kvm(this.nc).open(membershipBucket(this.space));
    return this.membershipKv;
  }

  /**
   * Snapshot the broker-sourced channel-membership feed (admin/observer read): every agent's
   * `{live, durable}` record plus `asOf` — the feed's freshness heartbeat (epoch ms of the daemon's last
   * successful poll, from the reserved {@link MEMBERSHIP_FEED_KEY}). `live` patterns are kept as-is
   * (wildcards preserved); the consumer expands them against the channel registry. `asOf` is undefined
   * when the feed has never been written (no daemon → the dashboard degrades to traffic-only).
   */
  async readMembership(): Promise<MembershipSnapshot> {
    const kv = await this.membershipRegistry();
    const members: MembershipEntry[] = [];
    let asOf: number | undefined;
    for await (const key of await kv.keys()) {
      const e = await kv.get(key);
      if (!e || e.operation === "DEL" || e.operation === "PURGE") continue;
      if (key === MEMBERSHIP_FEED_KEY) {
        try { asOf = e.json<{ observedAt: number }>().observedAt; } catch { /* heartbeat garbled — leave undefined */ }
        continue;
      }
      try {
        const rec = e.json<ChannelMembership>();
        members.push({ id: key, live: rec.live ?? [], durable: rec.durable ?? [], observedAt: rec.observedAt });
      } catch { /* skip undecodable */ }
    }
    return { asOf, members };
  }

  /** Watch the membership feed for changes (admin/observer): `onChange` fires on every KV entry,
   *  including the initial replay — the caller debounces + re-reads {@link readMembership}. Returns a
   *  stop handle. Best-effort: a feed the cred can't read (or absent) surfaces as an `error` event and
   *  the dashboard keeps its last snapshot. */
  async watchMembership(onChange: () => void): Promise<{ stop(): void }> {
    const kv = await this.membershipRegistry();
    const iter = await kv.watch();
    void (async () => {
      for await (const _ of iter) onChange();
    })().catch((err) => this.emit("error", err as Error));
    return { stop: () => iter.stop() };
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
        if (s.type !== "error") continue;
        // Suppress the EXPECTED permission violation from a manager-free join we're confirming: an
        // out-of-ACL `nc.subscribe` is refused async on its chat subject, which joinChannel catches
        // and turns into a clean throw — it is not a connection error to surface.
        if (s.error instanceof PermissionViolationError && this.confirmingChatSubs.has(s.error.subject))
          continue;
        this.emit("error", describeStatusError(s.error));
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

  // (v3) The old `provisionMembership` — manager/provisioner-written boot membership at spawn — is GONE.
  // Boot durable membership is now the AGENT self-joining its durable boot channels via the daemon's
  // `ctl.delivery` op at connect ({@link armBootDurableMemberships}), reconciled on outage. The
  // primitive it wrapped, {@link durableJoinFor}, is now driven by the daemon's `ctl.delivery` handler.

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
   * Privileged: pre-create an agent's bind-only Plane-3 DELIVER durable (`dlv_<id>`, filtered to
   * `dlv.<id>`), so the agent can BIND its per-member durable handoff without holding CONSUMER.CREATE
   * on the DLV stream. Same bind-only model as {@link provisionDmInbox}: the creator sets the filter,
   * the agent never does. The trusted reader transfers re-authorized copies onto `dlv.<id>`; the agent
   * acks them via native JetStream (SPEC §8). Idempotent. The caller must be permissive on DLV.
   */
  async provisionDlvInbox(targetId: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(dlvStream(this.space), dlvDurableConfig(this.space, targetId));
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

  // ---- Plane-3: durable backstop (SPEC §8) — privileged, hosted by the server-side DELIVERY DAEMON ----
  //
  // Two daemon loops + two privileged membership ops (served to agents on `ctl.delivery`). The FAN-OUT
  // writer (routing, not auth) reads every chat message and copies it into each eligible owner's MIXED
  // inbox (`dinbox.<owner>`); the TRUSTED READER (the auth gate) re-authorizes each entry against the
  // CURRENT ACL + membership interval and TRANSFERS the authorized copy to the owner's per-member
  // DELIVER store (`dlv.<owner>`), which the agent binds + acks via native JetStream. The agent holds no
  // read on the mixed store. (v3: this all moved off the manager — the manager is lifecycle-only; it
  // records the read-ACL at mint via commitAcl.) See `.internal/research/stage4-impl-design.md`.

  /** Lazily open the privileged members registry KV (delivery daemon / open-mode self). */
  private async membersRegistry(): Promise<KV> {
    if (!this.nc) throw new Error("endpoint not started");
    this.membersKv ??= await openMembersRegistry(this.nc, this.space);
    return this.membersKv;
  }

  /** Lazily open the durable read-ACL registry KV. Privileged write (the manager records an agent's
   *  ACL at mint); the delivery daemon reads it fresh per durable entry to re-authorize. */
  private async aclRegistry(): Promise<KV> {
    if (!this.nc) throw new Error("endpoint not started");
    this.aclKv ??= await openAclRegistry(this.nc, this.space);
    return this.aclKv;
  }

  /** Privileged ({@link DurableProvisioner}): record an agent's read ACL in the durable registry at
   *  provision/mint time — the same act as baking it into the JWT, persisted so the server-side
   *  delivery daemon can re-authorize the agent's durable entries and validate its runtime
   *  durable-joins without holding any in-memory ledger. Written ATOMICALLY ({@link writeAclRecord}),
   *  so a present record is always complete (`[]` = known no-read, never a half-write). */
  async commitAcl(targetId: string, allowSubscribe: string[]): Promise<void> {
    await writeAclRecord(await this.aclRegistry(), targetId, allowSubscribe);
  }

  /** The server-side delivery daemon's fresh-per-entry ACL read: an owner's CURRENT read ACL
   *  (`allowSubscribe`) from the durable registry, or `undefined` if no record (an unknown owner — the
   *  reader DEFERS, never drops). A present `[]` (known no-read) returns `[]` (the reader DROPS). */
  async aclForOwner(owner: string): Promise<string[] | undefined> {
    return (await readAcl(await this.aclRegistry(), owner))?.record.allowSubscribe;
  }

  /** Lazily open the delivery lease/readiness KV (pre-created at `cotal up`; bind, never create). */
  private async deliveryRegistry(): Promise<KV> {
    if (!this.nc) throw new Error("endpoint not started");
    this.deliveryKv ??= await openDeliveryRegistry(this.nc, this.space);
    return this.deliveryKv;
  }

  private encodeLease(ready: boolean): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ holder: this.card.id, since: Date.now(), ready } satisfies DeliveryLeaseInfo));
  }

  /** Acquire the single-flight delivery lease for a shard via an ATOMIC CAS create, marked NOT-ready.
   *  THROWS if a live lease exists — a loud refusal-to-bind (the daemon exits), never a retry, so two
   *  daemons can't split a durable's delivery. A crashed holder's lease auto-expires (bucket TTL),
   *  freeing a re-acquire. Acquired BEFORE binding (single-flight gate); {@link markDeliveryLeaseReady}
   *  flips it ready AFTER the loops + `ctl.delivery` are bound. Returns the lease revision. */
  async acquireDeliveryLease(shardIndex: number): Promise<number> {
    return (await this.deliveryRegistry()).create(leaseKey(shardIndex), this.encodeLease(false));
  }

  /** Flip the held lease to READY (CAS `kv.update`) AFTER `startPlane3` has bound the loops + the
   *  `ctl.delivery` responder — so "lease ready" proves the responder is up, not just that the slot was
   *  claimed. Returns the new revision. */
  async markDeliveryLeaseReady(shardIndex: number, revision: number): Promise<number> {
    return (await this.deliveryRegistry()).update(leaseKey(shardIndex), this.encodeLease(true), revision);
  }

  /** Renew the held lease (CAS `kv.update` against `revision`, keeping `ready:true`) to refresh it before
   *  the bucket TTL expires it. Returns the new revision. Throws if the revision moved (lost the lease —
   *  the daemon should exit). */
  async renewDeliveryLease(shardIndex: number, revision: number): Promise<number> {
    return (await this.deliveryRegistry()).update(leaseKey(shardIndex), this.encodeLease(true), revision);
  }

  /** Release the held lease on clean shutdown so a replacement daemon re-acquires immediately (best
   *  effort — a crash just lets the bucket TTL expire it). */
  async releaseDeliveryLease(shardIndex: number): Promise<void> {
    try { await (await this.deliveryRegistry()).delete(leaseKey(shardIndex)); } catch { /* already gone */ }
  }

  /** Read a shard's delivery lease (the daemon-availability signal), or `undefined` if none is live.
   *  READ-ONLY surface — drives Component 6's `cotal_channels` delivery-health field (an agent reads it
   *  under its own cred, which holds lease-bucket read but no write). */
  async readDeliveryLease(shardIndex: number): Promise<DeliveryLeaseInfo | undefined> {
    const e = await (await this.deliveryRegistry()).get(leaseKey(shardIndex));
    if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
    try { return e.json<DeliveryLeaseInfo>(); } catch { return undefined; }
  }

  /** Ensure + bind the manager singleton-lease bucket. Mirrors the presence-bucket pattern (connectAndBind):
   *  AUTH mode OPENs the bucket pre-created at `cotal up` (the scoped `supervisor` cred holds no
   *  STREAM.CREATE — and `open` binds direct=false, so the CAS-conflict `kv.get` inside `acquire` rides
   *  STREAM.MSG.GET, the verb the supervisor grants, never DIRECT.GET). OPEN mode (no creds) create-firsts:
   *  `Kvm.open` binds LAZILY — it does NOT verify the stream exists or throw when it's missing (a fresh
   *  bucket then fails 'stream not found' on the first write), so `create` is the ensure-exists call (it
   *  makes the bucket or, when another endpoint already did, throws and we bind the existing one). Either
   *  way the per-KEY CAS create stays the only single-flight gate, so a lost bucket-create race never reads
   *  as "lease held". */
  private async managerLeaseRegistry(): Promise<KV> {
    if (!this.nc) throw new Error("endpoint not started");
    if (this.managerLeaseKv) return this.managerLeaseKv;
    const kvm = new Kvm(this.nc);
    if (this.creds) {
      this.managerLeaseKv = await kvm.open(managerBucket(this.space));
    } else {
      try {
        this.managerLeaseKv = await kvm.create(managerBucket(this.space), { ttl: MANAGER_LEASE_TTL_MS });
      } catch {
        this.managerLeaseKv = await kvm.open(managerBucket(this.space));
      }
    }
    return this.managerLeaseKv;
  }
  private encodeManagerLease(info: ManagerLeaseInfo): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(info));
  }
  /** Acquire the singleton manager lease via ATOMIC CAS create. THROWS if a live lease exists (a loud
   *  refusal-to-start, never a retry) so two managers never split control. A crashed holder's lease
   *  auto-expires (bucket TTL). Returns the lease revision (for renew). */
  async acquireManagerLease(info: Omit<ManagerLeaseInfo, "since">): Promise<number> {
    return (await this.managerLeaseRegistry()).create(MANAGER_LEASE_KEY, this.encodeManagerLease({ ...info, since: Date.now() }));
  }
  /** Renew the held lease (CAS update against `revision`) before the bucket TTL expires it. Throws if the
   *  revision moved (lost the lease). Returns the new revision. */
  async renewManagerLease(info: Omit<ManagerLeaseInfo, "since">, revision: number): Promise<number> {
    return (await this.managerLeaseRegistry()).update(MANAGER_LEASE_KEY, this.encodeManagerLease({ ...info, since: Date.now() }), revision);
  }
  /** Release the held lease on clean shutdown so a replacement manager acquires immediately. CAS-guarded
   *  by `revision`: if we already LOST the lease (renew gap / another manager took over) the stored
   *  revision has moved, the conditional delete no-ops, and we never delete the replacement's live lease. */
  async releaseManagerLease(revision?: number): Promise<void> {
    try {
      const kv = await this.managerLeaseRegistry();
      if (revision === undefined) await kv.delete(MANAGER_LEASE_KEY);
      else await kv.delete(MANAGER_LEASE_KEY, { previousSeq: revision });
    } catch { /* not ours / already gone */ }
  }
  /** Read the live manager lease, or undefined if none (bucket absent / key deleted/expired). Open-only —
   *  never creates the bucket, so a probe that finds no manager leaves none behind. */
  async readManagerLease(): Promise<ManagerLeaseInfo | undefined> {
    if (!this.nc) return undefined;
    try {
      const kv = await new Kvm(this.nc).open(managerBucket(this.space));
      const e = await kv.get(MANAGER_LEASE_KEY);
      if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
      return e.json<ManagerLeaseInfo>();
    } catch {
      return undefined;
    }
  }

  /** Privileged: one owner's NON-TOMBSTONED durable memberships as `{channel, generation, activated}` —
   *  the server-side delivery daemon serves this to a connecting agent (the `listMemberships` op on
   *  `ctl.delivery`). The agent seeds its leave mirror from the ACTIVATED ones (the confirmed backstops),
   *  but the non-activated ones are returned too so `leaveChannel` can discover + close a record that
   *  still routes under the pure-interval predicate (a crash-stuck pending activation) — without reading
   *  the privileged KV itself. */
  async ownerMemberships(owner: string): Promise<{ channel: string; generation: number; activated: boolean }[]> {
    const recs = await listMembers(await this.membersRegistry(), { owner });
    return recs
      .filter((r) => r.leaveCursor === undefined)
      .map((r) => ({ channel: r.channel, generation: r.generation, activated: r.activated === true }));
  }

  /** Effective delivery class read AUTHORITATIVELY from the registry KV (not the watch cache) — so a
   *  `live`→`durable` flip is seen by fan-out without a cache-propagation gap (red-team MED-3). */
  private async deliveryClassFresh(channel: string): Promise<DeliveryClass> {
    if (!this.channelKv) return effectiveDeliveryClass(undefined, undefined);
    const [cfg, defaults] = await Promise.all([
      isConcreteChannel(channel) ? readChannelConfig(this.channelKv, channel) : Promise.resolve(undefined),
      readChannelDefaults(this.channelKv),
    ]);
    return effectiveDeliveryClass(cfg, defaults);
  }

  /** Collision-safe `@mention` → owner-id resolution: a name that resolves to exactly one present
   *  peer wins; 0 or >1 matches drop (never fan a directed durable copy to an unrelated same-named
   *  bystander — red-team LOW; SPEC §4 unique instance id). */
  private resolveOwnerByName(name: string): string | undefined {
    const matches = [...this.roster.values()].filter((p) => p.card.name.toLowerCase() === name.toLowerCase());
    return matches.length === 1 ? matches[0].card.id : undefined;
  }

  /** Publish one fan-out entry into an owner's mixed inbox, idempotent via `Nats-Msg-Id`
   *  (`<msgId>:<owner>:<generation>`) so a catch-up copy and a racing fan-out copy collapse. */
  private async publishDinbox(owner: string, entry: Plane3Entry): Promise<void> {
    if (!this.js) return;
    await this.js.publish(dinboxSubject(this.space, owner), JSON.stringify(entry), {
      msgID: `${entry.msg.id}:${owner}:${entry.generation}`,
    });
  }

  /** The fan-out consumer's delivered stream-seq — the activation-fence upper bound (red-team
   *  BLOCKER-1: the shared fan-out cursor advances independently of the stream frontier). */
  private async fanoutDeliveredSeq(): Promise<number> {
    const info = await this.consumerInfo(chatStream(this.space), FANOUT_DURABLE);
    return info?.delivered?.stream_seq ?? 0;
  }

  /**
   * Privileged durable-JOIN write (v3: the delivery daemon calls this from its `ctl.delivery` handler
   * after validating channel ⊆ the caller's read ACL): capture `joinCursor`, commit a `durable-active`
   * record (CAS + generation bump), then ACTIVATION CATCH-UP idempotently copies `(joinCursor, fence]`
   * into the owner inbox where `fence = max(frontier, fanoutDelivered)` — fan-out owns `seq > fence`.
   * Idempotent against a timeout-retry (an already-activated membership no-ops). Returns `{durable:false}`
   * (honest degrade) only if the catch-up window was evicted.
   *
   * Runs on the daemon (which hosts the fan-out/reader loops + the members KV), so catch-up + the
   * activation fence read are in-process — no cross-process cursor read.
   */
  async durableJoinFor(
    owner: string,
    channel: string,
  ): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    if (!this.js) throw new Error("endpoint not started");
    await this.manager(); // ensure jsm — a non-consuming provisioner inits it lazily; catch-up + fence need it
    const kv = await this.membersRegistry();
    const existing = await readMember(kv, channel, owner);
    const open = existing?.record.state === "durable-active" && existing.record.leaveCursor === undefined;
    if (open && existing!.record.activated)
      return { durable: true, generation: existing!.record.generation }; // fully activated — idempotent
    // Either a NEW join (no record / a tombstone to supersede) → fresh joinCursor + bumped generation,
    // OR a retry of an INCOMPLETE activation (durable-active but not yet activated, from an earlier
    // eviction/crash) → re-run catch-up over the SAME join window, no bump. The record is committed
    // `activated:false` first and routes IN-INTERVAL immediately (fan-out + reader deliver via the
    // pure-interval durableEligible) so no live message published during catch-up is lost. `activated`
    // gates only the REPORT — durableJoin returns true / channelMembers lists the owner only after the
    // catch-up confirms. A join that never completes catch-up still routes live (harmless: the agent is
    // live-subscribed and DLV is id-deduped) but honestly reports durable:false and stays hidden.
    const joinCursor = open ? existing!.record.joinCursor : await this.chatFrontier();
    const generation = open ? existing!.record.generation : (existing?.record.generation ?? 0) + 1;
    const base: MembershipRecord = {
      channel, owner, state: "durable-active", joinCursor, generation,
      activated: false, writerIdentity: this.card.id, updatedAt: Date.now(),
    };
    if (!open) await commitMember(kv, base);
    const fence = Math.max(await this.chatFrontier(), await this.fanoutDeliveredSeq());
    const cu = await this.catchupCopy(owner, channel, joinCursor, fence, generation);
    if (cu.evicted) {
      // Catch-up window irreparably evicted (the oldest in-window message aged out) — this join can never
      // be a complete backstop. TOMBSTONE the just-committed record at `fence` so it does NOT route:
      // pure-interval durableEligible would otherwise keep delivering to a record the agent was told is
      // durable:false AND can't discover to leave (critic BLOCKER-1). Pass `generation` as the expected
      // generation (ux stale-write guard) so this cleanup can't tombstone a concurrent NEWER rejoin — if
      // one won, StaleMembershipWrite is the correct no-op (the rejoin is the live record). Then degrade
      // honestly — a retry is a fresh join (no longer `open`, so a current joinCursor is captured).
      try {
        await tombstoneMember(kv, channel, owner, fence, this.card.id, generation);
      } catch (e) {
        if (!(e instanceof StaleMembershipWrite)) throw e;
      }
      return { durable: false, reason: "activation catch-up window partially evicted by retention", generation };
    }
    // Flip → reported durable, ATOMICALLY: refuse if a concurrent SAME-generation leave (tombstone) or a
    // rejoin superseded this pending join while catch-up ran. A blind same-gen commit would clobber the
    // tombstone (clear leaveCursor) and resurrect the membership, reopening §7 (review-general-2 BLOCKER).
    const activated = await activateMember(kv, channel, owner, generation, joinCursor);
    if (!activated)
      return { durable: false, reason: "activation superseded by a concurrent leave or rejoin", generation };
    return { durable: true, generation };
  }

  /** Privileged durable-LEAVE write: tombstone the membership at `leaveCursor = frontier` so the
   *  backstop denies `seq > leaveCursor` while a pre-leave entry stays deliverable (SPEC §7 interval). */
  async durableLeaveFor(owner: string, channel: string, expectedGeneration?: number): Promise<void> {
    if (!this.plane3) return; // not a Plane-3 host — no membership to tombstone
    const kv = await this.membersRegistry();
    // expectedGeneration (captured by the agent at durableJoin) refuses a stale leave from tombstoning
    // a newer rejoin (StaleMembershipWrite) — a durable-disable primitive otherwise.
    await tombstoneMember(kv, channel, owner, await this.chatFrontier(), this.card.id, expectedGeneration);
  }

  /** Idempotently copy the eligible chat messages in `(fromSeqExcl, toSeqIncl]` for `channel` into the
   *  owner inbox, via a DEDICATED per-(owner,join) ephemeral consumer (NOT the agent-scoped
   *  `chathist_<id>`/`histLock` — red-team HIGH-8). `evicted` ⇒ the oldest eligible seq aged out under
   *  `discard=Old` (the start seq could not be served), a durable shortfall the caller surfaces. */
  private async catchupCopy(
    owner: string, channel: string, fromSeqExcl: number, toSeqIncl: number, generation: number,
  ): Promise<{ copied: number; evicted: boolean }> {
    if (!this.js || !this.jsm || toSeqIncl <= fromSeqExcl) return { copied: 0, evicted: false };
    const subject = chatSubject(this.space, "*", channel);
    // Eviction = a message in `(joinCursor, …]` on THIS channel's subject aged out under discard=Old.
    // Judged PER-SUBJECT (reuse channelDropped: oldest-retained-for-subject vs the watermark, only at
    // the per-subject cap), NOT against the stream-global joinCursor+1 — other channels' traffic
    // inflates the global seq, so a naive "first delivered seq > joinCursor+1" false-positives on any
    // busy multi-channel space (impl-review HIGH-2). A true eviction → durableJoin reports durable:false.
    const evicted = await this.channelDropped(subject, fromSeqExcl);
    const name = `cu_${token(owner)}_${generation}`;
    try { await this.jsm.consumers.delete(chatStream(this.space), name); } catch { /* none */ }
    await this.jsm.consumers.add(chatStream(this.space), {
      name, filter_subject: subject, ack_policy: AckPolicy.None, mem_storage: true,
      inactive_threshold: nanos(30_000), deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: fromSeqExcl + 1,
    });
    let copied = 0;
    try {
      const consumer = await this.js.consumers.get(chatStream(this.space), name);
      let pending = (await consumer.info()).num_pending;
      while (pending > 0) {
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          if (m.seq > toSeqIncl) return { copied, evicted };
          let msg: CotalMessage;
          try { msg = m.json<CotalMessage>(); } catch { continue; }
          const parsed = parseSubject(m.subject);
          if (!parsed || msg.from?.id !== parsed.sender || msg.from.id === owner) continue;
          await this.publishDinbox(owner, { msg, channel, seq: m.seq, reason: "durable-channel", generation });
          copied++;
        }
        if (got < want) break;
        pending -= got;
      }
    } finally {
      try { await this.jsm.consumers.delete(chatStream(this.space), name); } catch { /* gone */ }
    }
    return { copied, evicted };
  }

  /** Start the Plane-3 fan-out writer + trusted reader on THIS (privileged, server-side delivery-daemon)
   *  endpoint, AND serve the `ctl.delivery` control service (runtime durable join/leave/list). `aclFor`
   *  maps an owner id to its current read ACL for the reader's re-authorization — read FRESH per entry
   *  from the durable ACL registry (async). Call once after connect; idempotent durable creation lets it
   *  resume on a daemon restart. Both the JS loops AND the `ctl.delivery` subscription are (re)bound by
   *  {@link armPlane3} on EVERY (re)connect — a reconnect drains the old connection, so re-binding both
   *  is required, not optional (the responder would otherwise be lost on a broker blip). */
  async startPlane3(aclFor: (owner: string) => MaybePromise<string[] | undefined>): Promise<void> {
    if (!this.js) throw new Error("endpoint not started");
    this.plane3 = { aclFor };
    await this.armPlane3();
  }

  /** Serve one runtime durable-membership control request (the server-side delivery daemon). The caller
   *  id is the authenticated subject sender ({@link serveControl} fail-closes on a mismatch). Validation
   *  is against the durable ACL registry — the SAME KV the reader re-auths against (single source of
   *  truth, no in-memory ledger to drift). */
  private async handleDeliveryControl(req: ControlRequest): Promise<ControlReply> {
    const caller = req.from.id;
    const args = req.args ?? {};
    if (req.op === "durableJoin") return this.deliveryJoin(caller, args);
    if (req.op === "durableLeave") return this.deliveryLeave(caller, args);
    if (req.op === "listMemberships")
      return { ok: true, data: { memberships: await this.ownerMemberships(caller) } };
    return { ok: false, error: `op "${req.op}" not supported on the delivery control service` };
  }

  /** Validate the channel ARG shape only — non-blank, valid, concrete (NO ACL check, that is op-specific).
   *  Returns the channel on success or a ControlReply error to short-circuit. */
  private checkDurableChannelArg(args: Record<string, unknown>, op: string): string | ControlReply {
    const channel = typeof args.channel === "string" ? args.channel.trim() : "";
    if (!channel) return { ok: false, error: `${op}: channel must be a non-blank string` };
    try { assertValidChannel(channel); } catch (e) { return { ok: false, error: (e as Error).message }; }
    if (!isConcreteChannel(channel))
      return { ok: false, error: `${op}: "${channel}" must be a concrete channel (durable membership is per-concrete-channel, not wildcard)` };
    return channel;
  }

  /** JOIN requires the channel be within the caller's CURRENT read ACL (you can't durable-subscribe a
   *  channel you may not read). */
  private async deliveryJoin(caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const channel = this.checkDurableChannelArg(args, "durableJoin");
    if (typeof channel !== "string") return channel; // a ControlReply error
    const acl = await readAcl(await this.aclRegistry(), caller);
    if (acl === undefined)
      return { ok: false, error: `durableJoin: no read ACL on record for ${caller} (not provisioned for durable delivery)` };
    if (!channelInAllow(acl.record.allowSubscribe, channel))
      return { ok: false, error: `channel "${channel}" is not within your read ACL [${acl.record.allowSubscribe.join(", ")}]` };
    try { return { ok: true, data: await this.durableJoinFor(caller, channel) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  /** LEAVE must NOT require current-ACL coverage. Leave fires precisely when the ACL was narrowed/revoked
   *  (a refused live sub → {@link closeRefusedMembership}); gating the tombstone on the current ACL would
   *  loop forever and leave the SPEC §7 boundary open (the membership could resume if the ACL is later
   *  restored). The guards are: authenticated caller (serveControl), concrete channel, a finite generation
   *  (the join epoch — without it a stale/replayed leave could tombstone a newer rejoin), and an EXISTING
   *  own membership; `durableLeaveFor` → `tombstoneMember` then enforces the generation match. */
  private async deliveryLeave(caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const channel = this.checkDurableChannelArg(args, "durableLeave");
    if (typeof channel !== "string") return channel; // a ControlReply error
    if (typeof args.generation !== "number" || !Number.isFinite(args.generation))
      return { ok: false, error: "durableLeave: a finite generation is required (fail-closed stale-leave guard)" };
    const existing = await readMember(await this.membersRegistry(), channel, caller);
    if (!existing) return { ok: true, data: { channel, alreadyLeft: true } }; // nothing to tombstone — idempotent
    try { await this.durableLeaveFor(caller, channel, args.generation); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
    return { ok: true, data: { channel } };
  }

  /** (Re)bind the Plane-3 fan-out writer + trusted reader. Idempotent — the durables resume from their
   *  cursor. Called by {@link startPlane3} once AND by {@link connectAndBind} on every (re)connect, so
   *  the delivery daemon's reconnect RE-ARMS the backstop + the ctl.delivery responder. Without this, a broker blip would silently kill
   *  the loops while `durableJoinFor` kept reporting `durable:true` (the impl-review's BLOCKER-1). No-op
   *  unless this endpoint hosts Plane-3 (`this.plane3` set). */
  private async armPlane3(): Promise<void> {
    if (!this.plane3 || !this.js) return;
    await this.manager(); // the manager runs consume:false, so this.jsm is lazy — ensure it
    this.armDeliveryControl();
    await this.runFanout();
    await this.runReader();
  }

  /** (Re)register the `ctl.delivery` control responder on the CURRENT connection. A reconnect drains the
   *  old connection (the old sub is dead and `clearConnectionScoped` leaves caller-owned subs alone), so
   *  this MUST run on every arm — otherwise durable join/leave/list silently lose their responder after a
   *  broker blip. The stale sub is dropped (unsubscribed + removed from `this.subs`) before re-creating.
   *  `boundReply` is essential here: the daemon holds a wildcard reply-publish grant, so the serve path
   *  must reject any reply target outside the authenticated sender's own subtree (confused-deputy fix). */
  private armDeliveryControl(): void {
    if (this.deliveryServeSub) {
      try { this.deliveryServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(this.deliveryServeSub);
      if (i >= 0) this.subs.splice(i, 1);
    }
    this.deliveryServeSub = this.serveControl(CONTROL_DELIVERY, (req) => this.handleDeliveryControl(req), { boundReply: true });
  }

  /** Fan-out loop: bind the privileged `fanout` durable on CHAT and route each message (routing only —
   *  the trusted reader is the auth gate). */
  private async runFanout(): Promise<void> {
    if (!this.js || !this.jsm) return;
    try { await this.jsm.consumers.add(chatStream(this.space), fanoutDurableConfig(this.space, { ackWaitMs: this.ackWaitMs })); } catch { /* exists */ }
    const consumer = await this.js.consumers.get(chatStream(this.space), FANOUT_DURABLE);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        try { await this.fanOutMessage(m); }
        catch (e) { if (!this.stopped) this.emit("error", e as Error); try { m.nak(); } catch { /* draining */ } }
      }
    })().catch((e) => { if (!this.stopped) this.emit("error", e as Error); });
  }

  /** Route ONE chat message to eligible owners' mixed inboxes. `durable` channel → its `durable-active`
   *  members within interval; `live` channel → `@mention` targets authorized to read it (ACL only).
   *  Members KV is scanned FRESH per message (no cache — red-team BLOCKER-1 catch-up correctness). */
  private async fanOutMessage(m: JsMsg): Promise<void> {
    const parsed = parseSubject(m.subject);
    if (!parsed || parsed.kind !== "chat") { m.ack(); return; }
    const channel = parsed.rest;
    let msg: CotalMessage;
    try { msg = m.json<CotalMessage>(); } catch { m.ack(); return; }
    if (!msg.from || msg.from.id !== parsed.sender) { m.ack(); return; } // authenticity
    const seq = m.seq;
    if ((await this.deliveryClassFresh(channel)) === "durable") {
      for (const rec of await listMembers(await this.membersRegistry(), { channel })) {
        if (rec.owner === msg.from.id) continue;      // never backstop the sender's own post
        if (!durableEligible(rec, seq)) continue;     // routing fast-filter (reader re-checks)
        await this.publishDinbox(rec.owner, { msg, channel, seq, reason: "durable-channel", generation: rec.generation });
      }
    } else {
      for (const name of msg.mentions ?? []) {
        const owner = this.resolveOwnerByName(name);
        if (!owner || owner === msg.from.id) continue;
        const acl = await this.plane3?.aclFor(owner);
        if (!acl || !channelInAllow(acl, channel)) continue; // @mention can't bypass the read ACL
        await this.publishDinbox(owner, { msg, channel, seq, reason: "live-mention", generation: 0 });
      }
    }
    m.ack();
  }

  /** Trusted-reader loop: bind the single privileged `reader` durable over `dinbox.>` and re-authorize
   *  + transfer each entry. */
  private async runReader(): Promise<void> {
    if (!this.js || !this.jsm) return;
    try { await this.jsm.consumers.add(inboxStream(this.space), inboxReaderConfig(this.space, { ackWaitMs: this.ackWaitMs })); } catch { /* exists */ }
    const consumer = await this.js.consumers.get(inboxStream(this.space), INBOX_READER_DURABLE);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        try { await this.readerHandle(m); }
        catch (e) { if (!this.stopped) this.emit("error", e as Error); try { m.nak(); } catch { /* draining */ } }
      }
    })().catch((e) => { if (!this.stopped) this.emit("error", e as Error); });
  }

  /** Re-authorize ONE mixed-inbox entry and transfer it to the owner's DELIVER store. Deny (drop) on a
   *  revoked/narrowed ACL or out-of-interval seq; on transfer success, ack the mixed entry (durability
   *  has moved to DLV — an §8 equivalent per-member at-least-once mechanism). The agent acks DLV. */
  private async readerHandle(m: JsMsg): Promise<void> {
    const owner = parseDinboxOwner(m.subject);
    if (!owner) { m.ack(); return; } // unparseable subject — not a real entry
    let entry: Plane3Entry;
    try { entry = m.json<Plane3Entry>(); } catch { m.ack(); return; } // undecodable — drop
    const redeliveries = m.info?.deliveryCount ?? 1; // JsMsg delivery attempts (1 on first delivery)
    const acl = await this.plane3?.aclFor(owner);
    if (acl === undefined) {
      // UNKNOWN owner — the manager has not (re)hydrated this owner's ACL yet (e.g. right after a
      // manager PROCESS restart). This is NOT a revocation: DEFER (redeliver), never drop — an ack here
      // would lose at-least-once on restart (impl-review BLOCKER-2). A delayed nak + a redelivery
      // ceiling stops one perma-unknown owner from head-of-lining the shared reader.
      // (Follow-up: the manager does not yet rehydrate its managed set across a process restart — until
      // it does, a long-unknown owner's entries term after the ceiling; tracked, not a silent ack-drop.)
      if (redeliveries >= READER_MAX_REDELIVERIES) {
        m.term();
        this.emit("error", new Error(`plane-3 reader: gave up on entry for unknown owner ${owner} after ${redeliveries} redeliveries`));
        return;
      }
      m.nak(2000);
      return;
    }
    // KNOWN owner whose CURRENT ACL no longer covers the channel — a revocation/narrowing. Drop: the
    // entry is no longer authorized (SPEC §7 current-ACL gate before surfacing).
    if (!channelInAllow(acl, entry.channel)) { m.ack(); return; }
    if (entry.reason === "durable-channel") {
      const rec = await readMember(await this.membersRegistry(), entry.channel, owner);
      // INTERVAL re-auth (not a current-member boolean): a pre-leave entry (seq ≤ leaveCursor) stays
      // deliverable; seq > leaveCursor (or after a rejoin's newer joinCursor) is the hard cut.
      if (!rec || !durableEligible(rec.record, entry.seq)) { m.ack(); return; }
    }
    try {
      await this.js!.publish(dlvSubject(this.space, owner), JSON.stringify(entry.msg), {
        msgID: `${entry.msg.id}:${owner}:${entry.generation}`,
      });
    } catch {
      // Transfer failed — keep the entry pending (redeliver), bounded by the same ceiling so a poison
      // entry can't head-of-line the shared reader forever.
      if (redeliveries >= READER_MAX_REDELIVERIES) {
        m.term();
        this.emit("error", new Error(`plane-3 reader: gave up transferring ${entry.msg.id} for ${owner} after ${redeliveries} redeliveries`));
        return;
      }
      m.nak(2000);
      return;
    }
    m.ack();
  }

  /** Agent-side: bind + pump our pre-created Plane-3 DELIVER durable (`dlv_<id>`). Every message here is
   *  delivery-daemon-written (DLV is delivery-write-only, broker-enforced) and is a CHANNEL message by contract
   *  (the backstop never carries DMs), so `kind=channel` is path-derived (SPEC §4) and the body is
   *  trusted (no spoof-guard). `durable:true` — real JetStream ack, coalesced with the core-sub live
   *  copy by `MeshAgent.ingest`. No-op when the durable isn't present (open mode / not provisioned). */
  private async pumpDlv(): Promise<void> {
    if (!this.js) return;
    let consumer;
    try { consumer = await this.js.consumers.get(dlvStream(this.space), dlvDurable(this.card.id)); }
    catch { return; } // no DLV durable — Plane-3 not active for us
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    void (async () => {
      for await (const m of msgs) {
        let msg: CotalMessage;
        try { msg = m.json<CotalMessage>(); } catch (e) { this.emit("error", e as Error); try { m.term(); } catch { /* draining */ } continue; }
        if (msg.from?.id === this.card.id) { m.ack(); continue; } // own echo (defensive)
        const delivery: Delivery = { ack: () => m.ack(), nak: () => m.nak(), durable: true };
        this.emit("message", msg, delivery, { historical: false, kind: "channel" } satisfies MessageMeta);
      }
    })().catch((e) => { if (!this.stopped) this.emit("error", e as Error); });
  }

  /** Agent-side: request a Plane-3 durable backstop for a channel via the server-side delivery daemon (ctl.delivery). Throws
   *  when no privileged writer is present (open / no delivery daemon). 30s timeout — activation catch-up may
   *  run before the reply (the window is small, but a busy channel can take more than the 5s default). */
  async durableJoinChannel(channel: string): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    const reply = await this.requestDelivery("durableJoin", { channel }, 30_000);
    if (!reply.ok) throw new Error(reply.error ?? "durable join rejected");
    return (reply.data as { durable: boolean; reason?: string; generation?: number }) ?? { durable: false };
  }

  /** Agent-side: release a Plane-3 durable backstop (tombstone membership at the leave cursor). Passes
   *  the join generation so a stale leave can't tombstone a newer rejoin (the delivery daemon validates it). */
  async durableLeaveChannel(channel: string, generation?: number): Promise<void> {
    const reply = await this.requestDelivery("durableLeave", { channel, generation });
    if (!reply.ok) throw new Error(reply.error ?? "durable leave rejected");
  }

  /** Fail-closed async cleanup for a channel forced out by a LATE sub.allow refusal (the broker revoked
   *  the live read). The sync sub callback can't await, so this RETRIES the Plane-3 tombstone with capped
   *  backoff UNTIL IT SUCCEEDS (or the endpoint stops) — the §7 boundary always closes once the manager
   *  is reachable, never a silent give-up. While pending, the channel is tracked in
   *  {@link pendingDurableLeave} and surfaced via {@link pendingDurableLeaves} (the connector shows it in
   *  `cotal_channels` as `durable-unclosed`, never ordinary absence). The generation is kept the whole
   *  time. Authoritative closure of a revoked membership is also handled by revocation (rotate creds + tear down). */
  private async closeRefusedMembership(channel: string, generation: number): Promise<void> {
    this.pendingDurableLeave.set(channel, generation);
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) return;
      try {
        await this.durableLeaveChannel(channel, generation);
        this.plane3Channels.delete(channel);
        this.pendingDurableLeave.delete(channel);
        return;
      } catch (e) {
        if (attempt === 0)
          this.emit(
            "error",
            new Error(`channel "${channel}": Plane-3 durable membership (generation ${generation}) not yet tombstoned after a refused live sub — retrying; §7 boundary may be open until it succeeds (${(e as Error).message})`),
          );
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      }
    }
  }

  /** Channels with a Plane-3 durable membership whose §7 tombstone is still pending after a refused live
   *  sub (see {@link closeRefusedMembership}) — surfaced by the connector as a `durable-unclosed` state so
   *  it is never presented as ordinary "not subscribed". */
  pendingDurableLeaves(): string[] {
    return [...this.pendingDurableLeave.keys()];
  }

  /** A control request that found NO responder — open / manager-less (no privileged control plane),
   *  distinct from a responder that errored. nats.js surfaces it as NoRespondersError, or a RequestError
   *  whose `isNoResponders()` is true. */
  private isNoResponders(e: unknown): boolean {
    return e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders());
  }

  /** Agent-side: this session's CURRENT durable memberships (channel + join generation) from the
   *  manager — the agent holds no read on the privileged members KV. `undefined` ⇒ NO control responder
   *  (open / no delivery daemon, so there is no Plane-3 and no memberships). THROWS on a responder-present RPC
   *  failure, so a caller can FAIL-CLOSED rather than mistaking a transient error for "no membership". */
  private async fetchMemberships(): Promise<{ channel: string; generation: number; activated: boolean }[] | undefined> {
    let reply: ControlReply;
    try {
      reply = await this.requestDelivery("listMemberships", {}, 5_000);
    } catch (e) {
      if (this.isNoResponders(e)) return undefined; // no delivery daemon — open / daemon-less, no Plane-3
      throw e; // responder present but errored — surface it (leaveChannel fails closed)
    }
    if (!reply.ok) throw new Error(reply.error ?? "listMemberships failed");
    return (reply.data as { memberships?: { channel: string; generation: number; activated: boolean }[] } | undefined)?.memberships ?? [];
  }

  /** Agent-side, first connect (auth): SELF-JOIN this session's durable boot channels via the
   *  server-side delivery daemon — replacing the old manager-written boot membership. Each concrete
   *  `durable`-class boot channel gets a `durableJoin` whose returned generation seeds the leave mirror
   *  + durable-state surface; an already-active membership (a relaunch) is idempotent (no re-catch-up).
   *  If the daemon is down/absent at first connect (or reports a transient `durable:false`), the channel
   *  is handed to {@link reconcileBootJoin} for capped-backoff retry — so the backstop is RESTORED once
   *  the daemon recovers, not left silently live-only. Until a membership exists the channel renders
   *  degraded in `cotal_channels` ({@link hasDurableMembership}). */
  private async armBootDurableMemberships(): Promise<void> {
    for (const channel of this.channels) {
      if (!isConcreteChannel(channel) || this.plane3Channels.has(channel)) continue;
      let cls: DeliveryClass;
      try { cls = await this.deliveryClassFresh(channel); } catch { continue; }
      if (cls !== "durable") continue;
      try {
        const r = await this.durableJoinChannel(channel);
        if (r.durable) this.plane3Channels.set(channel, r.generation ?? 0);
        else void this.reconcileBootJoin(channel); // present but not yet durable — reconcile to recovery
      } catch (e) {
        if (!this.isNoResponders(e)) this.emit("error", e as Error); // no daemon ⇒ retry until it recovers
        void this.reconcileBootJoin(channel);
      }
    }
  }

  /** Retry a boot durable self-join with capped backoff until a membership EXISTS (success → seed
   *  `plane3Channels`) or the channel is left / the endpoint stops. Mirrors {@link closeRefusedMembership}:
   *  a one-shot first-connect attempt that swallowed a daemon outage would leave the boot channel live-only
   *  forever after the daemon recovers (and the lease-based health could then read "active" with no owner
   *  membership). This loop is the reconcile that closes that gap. Idempotent — a channel already pending
   *  is not double-driven; survives reconnect (it re-issues `durableJoinChannel` on the current connection). */
  private async reconcileBootJoin(channel: string): Promise<void> {
    if (this.pendingBootJoins.has(channel)) return; // already reconciling
    this.pendingBootJoins.add(channel);
    for (let attempt = 0; ; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      if (this.stopped || !this.channels.includes(channel) || this.plane3Channels.has(channel)) {
        this.pendingBootJoins.delete(channel);
        return; // stopped, left, or another path established it
      }
      try {
        const r = await this.durableJoinChannel(channel);
        if (r.durable) {
          this.plane3Channels.set(channel, r.generation ?? 0);
          this.pendingBootJoins.delete(channel);
          return;
        }
        // present but durable:false (e.g. catch-up window evicted) — keep retrying; the channel stays
        // honestly degraded meanwhile, never silently "active".
      } catch (e) {
        if (attempt === 0 && !this.isNoResponders(e))
          this.emit("error", new Error(`channel "${channel}": boot durable self-join not yet established — retrying until the delivery daemon is reachable (${(e as Error).message})`));
      }
    }
  }

  /** True if this session holds an established Plane-3 durable membership for `channel` (in `plane3Channels`).
   *  Drives the membership-aware delivery-health surface: a joined durable channel that is NOT yet a member
   *  (boot self-join pending / daemon down) must render degraded, never "active" off a live lease alone. */
  hasDurableMembership(channel: string): boolean {
    return this.plane3Channels.has(channel);
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

    // Plane-3 (SPEC §8): bind + pump our per-member DELIVER durable (`dlv_<id>`) — the re-authorized
    // durable-backstop channel copies the trusted reader transfers to us. No-op when it isn't present
    // (open mode / un-provisioned). Auth-only feature; the pump self-guards on the durable's existence.
    await this.pumpDlv();

    // Multicast: open a native CORE subscription for each channel (live, manager-free, broker-enforced
    // by sub.allow) — boot + runtime joins use the SAME path; there is no per-instance chat durable.
    // The durable backstop (a busy/offline turn) is Plane-3 (auth: membership established by the agent's
    // self-join, the delivery daemon's fan-out writer + trusted reader deliver via the `dlv_<id>` pump
    // above; open dev mode is live-only — the durable plane needs the daemon's trusted reader, the
    // security boundary). Per-
    // channel history is the explicit replay-gated backfill, on FIRST connect only; a reconnect reopens
    // the subs without re-backfilling (the durable backstop redelivers any missed window via dlv).
    if (this.channels.length) {
      // Arm the per-channel join watermarks BEFORE opening the subs: the backfill reads <= frontier and
      // the core-sub delivers > frontier, so they never overlap (first connect). On reconnect we reopen
      // without arming/backfilling.
      const armed = this.firstConnect ? await this.armJoin(this.channels) : undefined;
      for (const ch of this.channels) this.subscribeChat(ch);
      await this.confirmChatSub();
      for (const ch of this.channels) this.confirmingChatSubs.delete(chatSubject(this.space, "*", ch));
      if (armed) await this.backfillArmed(armed);
    }
    // First connect, auth mode: self-join BOOT durable channels via the server-side delivery daemon
    // (it owns membership now — there is no manager-written boot membership). Seeds plane3Channels so a
    // later leave can tombstone the §7 boundary; idempotent on relaunch. Open mode has no Plane-3.
    if (this.firstConnect && this.creds && this.channels.length) await this.armBootDurableMemberships();
    this.firstConnect = false;

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
          // No pre-commit dedup here: the durable is the at-least-once path, so it must NEVER ack a copy
          // just because an id was "seen" — that would drop an unhandled message (the security/critic
          // HIGH). Steady state is single-path (coverage-partition: the core-sub drops durable-covered
          // channels). The only overlap is the brief live-first transition window, and a duplicate there
          // is coalesced downstream by the receiver's commit-aware id-dedup (MeshAgent.ingest keeps ONE
          // entry and takes THIS durable ack handle) — so the durable copy is acked only once handled.
        }
        const delivery: Delivery = { ack: () => m.ack(), nak: () => m.nak(), durable: true };
        this.emit("message", msg, delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Open a native core subscription to a channel's live feed (the manager-free live read path,
   *  broker-enforced by `sub.allow`). At-most-once — no replay, no ack; it is the live delivery for
   *  every channel (boot + runtime). For a `durable` channel it is also the low-latency wake-hint
   *  alongside the Plane-3 durable copy, coalesced by the receiver's id-dedup. Drops our own echo +
   *  spoofed senders. */
  private subscribeChat(channel: string): void {
    if (!this.nc || this.chatSubs.has(channel)) return;
    this.chatSubDenied.delete(channel);
    const subject = chatSubject(this.space, "*", channel);
    this.confirmingChatSubs.add(subject);
    const sub = this.nc.subscribe(subject, {
      callback: (err, m) => {
        if (err) {
          // async sub.allow refusal (or sub error): the live feed for this channel is dead — never a
          // leak (the broker refused it). Drop the channel from local joined state even if it was
          // already treated as joined — a LATE refusal beyond the confirm window: conformance #13
          // "drop on late refusal". (During the join's own confirm the channel isn't pushed yet, so
          // this fires nothing then; joinChannel reads `chatSubDenied` and throws cleanly.)
          this.chatSubDenied.add(channel);
          this.chatSubs.delete(channel);
          // NOTE: do NOT remove `subject` from confirmingChatSubs here — that set gates watchStatus's
          // suppression of this expected violation, and is cleared by joinChannel after confirm (or by
          // unsubscribeChat). Removing it in the callback races the watcher and leaks a spurious error.
          const i = this.channels.indexOf(channel);
          if (i >= 0) {
            this.channels.splice(i, 1);
            this.joinSeq.delete(channel);
            // A late sub.allow refusal forces this agent out of the channel (the broker revoked its live
            // read). If it held a Plane-3 durable membership, the §7 boundary must close too. This sub
            // callback can't await, so a fail-closed async helper RETRIES the tombstone (backoff) UNTIL it
            // succeeds, clearing the mirror only then; while pending it is surfaced via cotal_channels —
            // never a silent drop, never lost retry state.
            const gen = this.plane3Channels.get(channel);
            if (gen !== undefined) void this.closeRefusedMembership(channel, gen);
            this.emit(
              "error",
              new Error(`left channel "${channel}": its live subscription was refused by the broker`),
            );
          }
          return;
        }
        const parsed = parseSubject(m.subject);
        if (!parsed || parsed.kind !== "chat") return;
        let msg: CotalMessage;
        try {
          msg = m.json<CotalMessage>();
        } catch (e) {
          this.emit("error", e as Error);
          return;
        }
        if (!msg.from || msg.from.id !== parsed.sender) return; // spoof/malformed — drop (at-most-once)
        if (msg.from.id === this.card.id) return; // our own echo
        const delivery: Delivery = { ack: () => {}, nak: () => {}, durable: false }; // live = at-most-once, not acked
        this.emit("message", msg, delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      },
    });
    this.chatSubs.set(channel, sub);
  }

  /** Close a channel's core subscription (manager-free leave). */
  private unsubscribeChat(channel: string): void {
    this.confirmingChatSubs.delete(chatSubject(this.space, "*", channel));
    const sub = this.chatSubs.get(channel);
    if (sub) {
      try {
        sub.unsubscribe();
      } catch {
        /* closing with the connection */
      }
      this.chatSubs.delete(channel);
    }
    this.chatSubDenied.delete(channel);
  }

  /** Confirm a just-opened core subscription was accepted by the broker. A `sub.allow` violation is
   *  async in NATS, so flush (round-trips the SUB) then settle briefly to let the refusal land — a
   *  denied subscribe must not read as a successful join (SPEC conformance #13). */
  private async confirmChatSub(): Promise<void> {
    if (!this.nc) throw new Error("connection not established");
    // flush() is the deterministic boundary: the broker's -ERR for an out-of-ACL SUB arrives BEFORE the
    // PONG, so once flush resolves the subscribe callback has already recorded any denial. A flush
    // FAILURE means the connection drained/closed mid-join — we have no confirmation, so let it throw
    // (joinChannel fails closed) instead of swallowing it and continuing as if confirmed.
    await this.nc.flush();
    await new Promise((r) => setTimeout(r, 50));
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
   *  BEFORE opening the core subscription so the live tail can never carry a just-joined message
   *  un-watermarked — which would double-emit it (live + backfill).
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
    // Serialize on the per-instance lock: the fixed `chathist_<id>` name means two concurrent reads
    // (recall + join-backfill + drop-marker can race in-process) would delete/recreate the consumer
    // under each other and cross-feed results. The chain makes the "serial callers" assumption true.
    const run = this.histLock.then(() => this.collectHistoryInner(subject, start, opts));
    this.histLock = run.catch(() => {}); // keep the chain alive on error
    return run;
  }

  private async collectHistoryInner(
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
          // Belt-and-suspenders over the lock: only keep messages on the requested channel subject
          // (the consumer's filter already bounds this; guards against any stale-consumer edge).
          if (!subjectMatches(subject, m.subject)) continue;
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
    const noop: Delivery = { ack: () => {}, nak: () => {}, durable: false };
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
    if (!this.doRegister || !this.kv) return; // observers watch but never publish their own record
    const p: Presence = {
      card: this.card,
      status: this.status,
      activity: this.activity,
      attention: this.attentionMode,
      channelModes: this.channelModes,
      ts: Date.now(),
    };
    // Wire contract (SPEC §6): an OFFLINE record must not carry the advisory attention fields. Scrub at
    // the publisher — this covers stop(), setStatus("offline"), and any future offline publish site, so
    // the raw KV record is compliant, not only the observer-side roster materialization.
    const record = this.status === "offline" ? this.toOffline(p) : p;
    await this.kv.put(this.card.id, JSON.stringify(record));
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
    // Defense-in-depth (per-user-auth closure (i), residual 3): the KV key IS the publisher's identity —
    // publishPresence() writes its record under card.id — so a record whose embedded card.id disagrees
    // with its bucket key is forged or corrupt. Drop it rather than surface a spoofed roster identity.
    // The write-side scoping ($KV.<presenceBucket>.<own-id>) is the primary guard; this rejects a
    // mis-keyed record even if a broad writer slips one in under another agent's key.
    if (raw.card?.id !== id) return;
    const prev = this.roster.get(id);
    const stale = Date.now() - raw.ts > this.ttlMs;
    // Any offline materialization (a stale snapshot OR a graceful-leave record) drops the advisory
    // attention fields — an offline peer must not carry a stale `[focus]`/`locally muted` hint.
    const p: Presence =
      stale || raw.status === "offline" ? this.toOffline(raw) : raw;

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
      prev.activity === p.activity &&
      prev.attention === p.attention &&
      sameChannelModes(prev.channelModes, p.channelModes)
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

  /** Materialize an OFFLINE presence record: drop the advisory attention fields. An offline peer must
   *  not show a stale `[focus]` or "locally muted #x" hint — SPEC: attention removed on offline sweep,
   *  channel modes reset on restart. card/activity/ts are kept. */
  private toOffline(p: Presence): Presence {
    return { ...p, status: "offline", attention: undefined, channelModes: undefined };
  }

  /** Mark a known peer offline (on KV delete/purge), keeping it in the roster. */
  private markOffline(id: string): void {
    const prev = this.roster.get(id);
    if (!prev || prev.status === "offline") return;
    const offline = this.toOffline(prev);
    this.roster.set(id, offline);
    this.emit("presence", { type: "offline", presence: offline });
    this.emit("roster", this.getRoster());
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.roster) {
      if (p.status !== "offline" && now - p.ts > this.ttlMs) {
        const offline = this.toOffline(p);
        this.roster.set(id, offline);
        this.emit("presence", { type: "offline", presence: offline });
        changed = true;
      }
    }
    if (changed) this.emit("roster", this.getRoster());
  }
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


/** Shallow-equal two per-channel-mode maps (presence dedup): a change must re-emit, so an attention
 *  toggle isn't swallowed as a quiet heartbeat. Absent and empty compare equal. */
function sameChannelModes(
  a?: Record<string, ChannelMode>,
  b?: Record<string, ChannelMode>,
): boolean {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a![k] === b?.[k]);
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

/** Parse a NATS server URL (`nats://host:port`, `host:port`, a bare host, or a comma list — the
 *  first entry wins) into a host+port for {@link tcpInfoProbe}. Defaults the port to 4222. */
function hostPort(server: string): { host: string; port: number } {
  const first = (server.split(",")[0] ?? "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme
  const u = new URL(`http://${first}`); // http:// so .hostname/.port resolve (incl. bracketed IPv6)
  return { host: u.hostname, port: u.port ? Number(u.port) : 4222 };
}

/** Silent credless liveness probe. Opens a plain TCP connection and confirms a NATS server is there
 *  by reading its UNPROMPTED `INFO {…}` greeting — which the server sends on accept, BEFORE the
 *  client's CONNECT/auth (per the NATS client protocol) — then closes immediately without
 *  authenticating. Since it never sends CONNECT, an auth broker has nothing to reject, so this emits
 *  NO broker-side auth-error/auth-timeout log line (unlike a credless `connect()`, which an auth
 *  broker rejects and logs). It is a *plaintext NATS* liveness check only:
 *    • a TLS-first (`handshake_first`, NATS ≥ 2.10.4) listener sends its TLS handshake before INFO,
 *      so the read won't match → returns false (a documented false-negative for that broker config);
 *    • a non-NATS / silent listener never sends a valid `INFO {` → also false (we require the real
 *      greeting, never "any open port is reachable").
 *  Closes well within the server's ~1s authorization timeout, so it cannot trip a timeout log. */
function tcpInfoProbe(server: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined;
    let done = false;
    const finish = (live: boolean) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(live);
    };
    let host: string, port: number;
    try { ({ host, port } = hostPort(server)); } catch { return resolve(false); }
    socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl === -1) { if (buf.length > 4096) finish(false); return; } // no real INFO line is 4KB+
      const line = buf.slice(0, nl);
      const brace = line.indexOf("{"); // greeting is `INFO {json}` (the server appends a trailing space)
      if (!/^INFO\b/.test(line) || brace === -1) return finish(false); // not NATS (incl. a TLS-first handshake)
      try { JSON.parse(line.slice(brace)); finish(true); } // require a real INFO greeting, not arbitrary bytes
      catch { finish(false); }
    });
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false)); // refused / reset / DNS failure
    socket.on("close", () => finish(false)); // closed before a full INFO line arrived
  });
}

/** Whether a NATS server is *running* at `servers`. With NO creds this is a SILENT plaintext
 *  liveness check ({@link tcpInfoProbe}): it reads the server's pre-auth `INFO` greeting and closes
 *  WITHOUT authenticating, so a live broker (open OR auth — INFO precedes auth) returns true while
 *  emitting no broker auth-error log. It may return false for a TLS-first listener — the credless
 *  probe is plaintext-only. With creds/token/tls supplied it is instead the AUTHORITATIVE identity
 *  check: a real authenticated connect, true on success AND on an auth rejection (a server that
 *  refuses these creds is still up — so the caller surfaces the real auth failure, and `up` won't
 *  start a duplicate on the bound port). Only a genuine connection failure (refused/timeout) is false. */
export async function isReachable(
  servers: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!opts.creds && !opts.token && !opts.user && !opts.pass && !opts.tls)
    return tcpInfoProbe(servers, opts.timeoutMs ?? 1000);
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

/** What a connect attempt told us about the server — the distinction {@link isReachable} flattens.
 *  `auth-required` means a server answered but rejected these creds (so it IS up); `unreachable`
 *  means nothing answered (refused / timeout / a stale registry entry). */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: "auth-required" }
  | { ok: false; reason: "unreachable" };

/** Like {@link isReachable}, but distinguishes "up but won't take these creds" from "nothing there".
 *  `spawn` needs the difference: auth-required → name the trust dir + next step; unreachable → the
 *  mesh is down (prune the stale entry, tell the user to `cotal up`). Pass `creds` to confirm a
 *  specific identity is accepted (`ok`); omit them to probe mere liveness (an auth broker answers
 *  `auth-required`, which still proves it's up). */
export async function probeConnect(
  server: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  try {
    const nc = await connect({
      servers: server,
      timeout: opts.timeoutMs ?? 1000,
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return { ok: true };
  } catch (e) {
    if (e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError)
      return { ok: false, reason: "auth-required" };
    return { ok: false, reason: "unreachable" };
  }
}
