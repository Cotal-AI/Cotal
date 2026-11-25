// The connection bind and teardown of CotalEndpoint, as an internal component: open a connection and bind
// everything that hangs off it, clear the connection-scoped state, close a failed bind, tear down a bind
// that lost a race with stop, stop the endpoint, and report its native connections. Moved verbatim from
// endpoint.ts. It owns its timers, the taps, the record of its own watch consumers and the subscription
// denials it reported, and it opens and clears the endpoint's ConnectionState; the endpoint keeps
// connectAndBind, the supervisor and the retry loop and forwards to these. Not re-exported by the index.
import type { DeliveryState } from "./endpoint-delivery-state.js";
import type { LifecycleState } from "./endpoint-lifecycle-state.js";
import type { CredentialState } from "./endpoint-credential-state.js";
import type { ChannelRegistryState } from "./endpoint-channel-registry-state.js";
import type { ConnectionState } from "./endpoint-connection-state.js";
import type { EndpointIdentity } from "./endpoint-identity.js";
import { requireBrokerFloor } from "./broker-floor.js";
import { openChannelRegistry } from "./channels.js";
import { drainAndClose } from "./connection-cleanup.js";
import { withDeadline } from "./deadline.js";
import type { EndpointDeliveryLease } from "./endpoint-delivery-lease.js";
import type { EndpointDeliveryPlane } from "./endpoint-delivery-plane.js";
import { bearerRenewalDeadlineMs, RepeatedRefusal, dialerFor, authOpts, describeStatusError } from "./endpoint-dial.js";
import type { DmOnlyOptions, PrincipalServeIntent, TransportState } from "./endpoint-options.js";
import type { EndpointPresence } from "./endpoint-presence.js";
import type { MembershipFeedWatch } from "./endpoint-subscriptions.js";
import { credsRenewalDelayMs, credsClaims } from "./identity.js";
import { type IssuedSubjectPermission, importNativeSubjectPermissions, readAcceptedRow } from "./issued-authority.js";
import { isStreamNotFound } from "./jetstream-missing.js";
import type { LivenessPlane } from "./liveness.js";
import { type NativeConnectionBinding, nativeConnectionBinding } from "./native-connection.js";
import { nextHeartbeat } from "./presence-heartbeat.js";
import { PRESENCE_STORAGE } from "./streams.js";
import { presenceBucket, dmStream, dmDurable, parseSubject } from "./subjects.js";
import { isFromSubjectSender, authenticatedMessage, isReadableMessagePart } from "./endpoint-messages.js";
import { hasStoredOrigin } from "./endpoint-provenance.js";
import type { CotalMessage } from "./types.js";
import { type ConsumerInfo, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { type KV, Kvm } from "@nats-io/kv";
import { type NatsConnection, PermissionViolationError } from "@nats-io/transport-node";

/** A Direct Get cannot distinguish a missing bucket from an unanswered read. Ask for the
 *  bucket's status and accept only a broker-confirmed absence. */
async function bucketExists(kv: KV): Promise<boolean> {
  try {
    await kv.status();
    return true;
  } catch (error) {
    if (isStreamNotFound(error)) return false;
    throw error;
  }
}

/** What the connection component reads from its endpoint. State is read when it is used, never copied, a
 *  field it reassigns is written back through its setter, and every method is looked up on the endpoint
 *  at call time, so a member a caller replaced on the endpoint is the one that runs. */
export interface EndpointConnectionDeps {
  authed: () => boolean;
  readsChannelsOnDemand: () => boolean;
  deliveryLease: () => EndpointDeliveryLease;
  presence: () => EndpointPresence;
  deliveryPlane: () => EndpointDeliveryPlane;
  refreshBearer: (initial?: boolean) => Promise<void>;
  refreshCreds: (initial?: boolean) => Promise<void>;
  cancelCredsRefresh: () => void;
  bearerForWire: () => string;
  presentCreds: () => string;
  presentBearer: () => string;
  armAuthExpiryReconnectFence: (nc: NatsConnection) => void;
  watchStatus: () => void;
  bindDmOnly: (mode: DmOnlyOptions) => Promise<void>;
  requireLifecycleUid: (what: string) => string;
  readPresenceOnce: () => Promise<void>;
  startPresenceWatch: () => Promise<ConsumerInfo | undefined>;
  sweep: () => void;
  readChannelsOnce: () => Promise<void>;
  startChannelWatch: () => Promise<void>;
  readChannels: () => Promise<void>;
  bindDeliveryLeaseWatch: () => Promise<void>;
  ensureStreams: () => Promise<void>;
  startConsumers: () => Promise<void>;
  publishPresence: () => Promise<void>;
  emitRecoverable: (err: Error) => void;
  rearmMembershipWatches: () => Promise<void>;
  armPlane3: () => Promise<void>;
  bindLiveness: (plane: LivenessPlane) => void;
  rebindPrincipalServes: (reconnected: boolean) => void;
  retireKvWatch: (iter: Awaited<ReturnType<KV["watch"]>>) => void;
  stopDeliveryLeaseWatch: () => void;
  disarmMembershipWatch: (watch: MembershipFeedWatch) => Promise<void>;
  disableLibraryReconnect: (nc: NatsConnection) => void;
  dropAnycastRequests: () => void;
  closeWithoutLibraryReconnect: (nc: NatsConnection | undefined) => Promise<void>;
  stopPrincipalServe: (intent: PrincipalServeIntent, republish?: boolean) => Promise<void>;
  kickBackoff: () => void;
  deleteRetainedMembershipConsumer: (watch: MembershipFeedWatch) => Promise<void>;
  settleDeliveryLeaseWatches: () => Promise<void>;
  settleKvWatches: () => Promise<void>;
  clearPresenceWriteFailure: () => void;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's connection bind and teardown. Internal: it owns its timers, taps and watch-consumer
 *  records and writes the shared {@link ConnectionState}, and `CotalEndpoint` keeps the other shared
 *  fields, connectAndBind, the supervisor and the retry loop, and forwards to it. */
export class EndpointConnection {
  /** Whether the expired-bearer refusal has been surfaced for this outage. */
  private bearerRefusalSurfaced = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** The observer feeds {@link tap} was asked for. This is INTENT, re-subscribed by {@link bindTap}
   *  on every (re)connect: a rebuild after an outage the library could not ride out closes the old
   *  connection and every subscription on it, so a tap bound once went silent while the endpoint
   *  reported itself connected again. */
  private readonly taps: { readonly handler: (subject: string, msg: CotalMessage | undefined) => void; readonly subject: string }[] = [];
  /** `$JS.API.CONSUMER.DELETE.<stream>.<prefix>_` for each of this connection's own KV watches and
   *  running membership scans (see {@link recordOwnWatchConsumer}). */
  private readonly ownWatchDeletePrefixes = new Set<string>();
  /** Service iterators and connection status can receive the same subscription denial. */
  private readonly reportedSubRefusals = new WeakSet<PermissionViolationError>();

  constructor(private readonly identity: Readonly<EndpointIdentity>, private readonly conn: ConnectionState, private readonly lifecycle: LifecycleState, private readonly cred: CredentialState, private readonly channelRegistry: ChannelRegistryState, private readonly delivery: Readonly<DeliveryState>, private readonly deps: EndpointConnectionDeps) {}

  private get authed() { return this.deps.authed(); }
  private get readsChannelsOnDemand() { return this.deps.readsChannelsOnDemand(); }
  private get deliveryLease() { return this.deps.deliveryLease(); }
  private get presence() { return this.deps.presence(); }
  private get deliveryPlane() { return this.deps.deliveryPlane(); }
  private refreshBearer(initial?: boolean): Promise<void> { return this.deps.refreshBearer(initial); }
  private refreshCreds(initial?: boolean): Promise<void> { return this.deps.refreshCreds(initial); }
  private cancelCredsRefresh(): void { this.deps.cancelCredsRefresh(); }
  private bearerForWire(): string { return this.deps.bearerForWire(); }
  private presentCreds(): string { return this.deps.presentCreds(); }
  private presentBearer(): string { return this.deps.presentBearer(); }
  private armAuthExpiryReconnectFence(nc: NatsConnection): void { return this.deps.armAuthExpiryReconnectFence(nc); }
  private watchStatus(): void { return this.deps.watchStatus(); }
  private bindDmOnly(mode: DmOnlyOptions): Promise<void> { return this.deps.bindDmOnly(mode); }
  private requireLifecycleUid(what: string): string { return this.deps.requireLifecycleUid(what); }
  private readPresenceOnce(): Promise<void> { return this.deps.readPresenceOnce(); }
  private startPresenceWatch(): Promise<ConsumerInfo | undefined> { return this.deps.startPresenceWatch(); }
  private sweep(): void { return this.deps.sweep(); }
  private readChannelsOnce(): Promise<void> { return this.deps.readChannelsOnce(); }
  private startChannelWatch(): Promise<void> { return this.deps.startChannelWatch(); }
  private readChannels(): Promise<void> { return this.deps.readChannels(); }
  private bindDeliveryLeaseWatch(): Promise<void> { return this.deps.bindDeliveryLeaseWatch(); }
  private ensureStreams(): Promise<void> { return this.deps.ensureStreams(); }
  private startConsumers(): Promise<void> { return this.deps.startConsumers(); }
  private publishPresence(): Promise<void> { return this.deps.publishPresence(); }
  private emitRecoverable(err: Error): void { return this.deps.emitRecoverable(err); }
  private rearmMembershipWatches(): Promise<void> { return this.deps.rearmMembershipWatches(); }
  private armPlane3(): Promise<void> { return this.deps.armPlane3(); }
  private bindLiveness(plane: LivenessPlane): void { return this.deps.bindLiveness(plane); }
  private rebindPrincipalServes(reconnected: boolean): void { return this.deps.rebindPrincipalServes(reconnected); }
  private retireKvWatch(iter: Awaited<ReturnType<KV["watch"]>>): void { return this.deps.retireKvWatch(iter); }
  private stopDeliveryLeaseWatch(): void { return this.deps.stopDeliveryLeaseWatch(); }
  private disarmMembershipWatch(watch: MembershipFeedWatch): Promise<void> { return this.deps.disarmMembershipWatch(watch); }
  private disableLibraryReconnect(nc: NatsConnection): void { return this.deps.disableLibraryReconnect(nc); }
  private dropAnycastRequests(): void { return this.deps.dropAnycastRequests(); }
  private closeWithoutLibraryReconnect(nc: NatsConnection | undefined): Promise<void> { return this.deps.closeWithoutLibraryReconnect(nc); }
  private stopPrincipalServe(intent: PrincipalServeIntent, republish?: boolean): Promise<void> { return this.deps.stopPrincipalServe(intent, republish); }
  private kickBackoff(): void { return this.deps.kickBackoff(); }
  private deleteRetainedMembershipConsumer(watch: MembershipFeedWatch): Promise<void> { return this.deps.deleteRetainedMembershipConsumer(watch); }
  private settleDeliveryLeaseWatches(): Promise<void> { return this.deps.settleDeliveryLeaseWatches(); }
  private settleKvWatches(): Promise<void> { return this.deps.settleKvWatches(); }
  private clearPresenceWriteFailure(): void { return this.deps.clearPresenceWriteFailure(); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  async bindConnection(): Promise<void> {
    this.clearConnectionScoped();
    // Bearer-source endpoints fetch before the FIRST connect, and renew first on a rebuild whose
    // cached token is past its renewal window (a rebuild after a long outage would otherwise
    // present a dead bearer). While renewals are failing, their retry timer owns the source: a
    // fetch here too would add one call to the exchange per rebuild attempt.
    if (this.identity.bearerSource) {
      if (!this.cred.currentBearer) await this.refreshBearer(true);
      else if (this.cred.bearerRenewalFailures === 0 && Date.now() >= bearerRenewalDeadlineMs(this.cred.currentBearer, this.cred.bearerAdoptedAtMs)) await this.refreshBearer();
    }
    // Creds-source endpoints likewise fetch before the FIRST connect, and re-fetch on a rebuild
    // whose cached cred is expired or inside its renewal window.
    if (this.identity.credsSource) {
      const stale = !this.cred.currentCreds || credsRenewalDelayMs(this.cred.currentCreds) <= 0;
      if (stale) await this.refreshCreds(!this.cred.currentCreds);
    }
    // Never dial with material we can already prove is dead. The refresh above is best-effort (a
    // failed renewal emits and retries rather than throwing, so a dead auth service does not
    // instantly drop a still-live mesh), which used to leave the connect below presenting an
    // EXPIRED bearer: a guaranteed denial that still costs a full auth-callout round trip, repeated
    // by the reestablish loop at a flat rate for as long as the process lives. Refuse here instead.
    // The loop's capped backoff paces the retries and re-enters this method, and a renewal that
    // starts working ends its wait; an endpoint with no bearer source cannot renew at all, and says
    // so. The refusal is surfaced once per outage: the loop retries a repeat without a notice.
    if (this.identity.userMode) {
      try {
        this.bearerForWire();
        this.bearerRefusalSurfaced = false;
      } catch (e) {
        if (!this.bearerRefusalSurfaced) {
          this.bearerRefusalSurfaced = true;
          throw e;
        }
        throw new RepeatedRefusal((e as Error).message);
      }
    }
    // The CREDS refusal is NOT repeated here. It lives on the supply itself ({@link credsForWire}),
    // which the authenticator below re-reads per attempt, so it covers this dial AND the reconnects
    // nats.js runs on its own. Raising it early here too would only duplicate it on the one path
    // that was already covered, and a fourth dial site added later would silently miss the copy.
    // The refusal still surfaces on this path: the authenticator throws during the CONNECT, the
    // library closes that attempt, and the reestablish loop's capped backoff re-enters here — where
    // the source re-fetch above is what recovers a renewable endpoint.
    let watchDeletePermission: IssuedSubjectPermission | undefined;
    this.conn.nc = await dialerFor(this.identity.servers)({
      servers: this.identity.servers,
      // Keep native failures without eagerly capturing a request-origin stack on every operation.
      noAsyncTraces: true,
      // In USER MODE the connection `name` carries the client-chosen inbox nonce (= connId) the callout
      // scopes `_INBOX_<connId>.>` on (see EndpointOptions.bearer); otherwise it's the display handle.
      name: this.identity.userMode ? this.identity.connId : `cotal:${this.identity.card.name}`,
      // Per-CONNECTION inbox namespace (the "Private Inbox" pattern), keyed on the connection nkey
      // (NOT the owner+actor principal): the reply inbox is per-connection plumbing, and under the auth
      // callout the principal is unknown to the client pre-connect (owner is derived server-side) while
      // the connection id always is. nats.js routes ALL generated inboxes — request replies, JetStream
      // pull delivery, kv.watch ordered-consumer delivery — through this prefix. Paired with
      // sub.allow=[_INBOX_<connId>.>] it stops a peer from subscribing the wildcard inbox to sniff
      // others' DM deliveries. Set unconditionally so the prefix can never drift from the ACL.
      inboxPrefix: `_INBOX_${this.identity.connId}`,
      ...(this.identity.transportPingIntervalMs === undefined ? {} : { pingInterval: this.identity.transportPingIntervalMs }),
      ...(this.identity.transportMaxPingOut === undefined ? {} : { maxPingOut: this.identity.transportMaxPingOut }),
      ...(this.identity.transportConnectTimeoutMs === undefined ? {} : { timeout: this.identity.transportConnectTimeoutMs }),
      // The bearer rides the CHECKED getter: nats.js re-evaluates the token authenticator per
      // (re)connect attempt, so internal reconnects present whatever refreshBearer last fetched,
      // and refuse a token that has expired since, as the creds getter does.
      // Creds ALWAYS ride the CHECKED getter, renewed or static, so every attempt — including the
      // reconnects nats.js performs on its own (the one the broker forces at JWT `exp`, and a dial
      // loop from an earlier drop that crosses `exp` mid-retry) — re-reads a credential that has
      // just been proven unexpired rather than whatever the cache happens to hold.
      // The gate is `!== undefined`, NOT truthiness. An EMPTY creds string is a caller that meant to
      // authenticate and supplied nothing; on a truthiness gate it fell through to `creds: undefined`
      // and dialed ANONYMOUSLY, so the broker answered `Authorization Violation` and the real fault
      // (an empty credential) was never named. Routing it into the checked getter fails it loud
      // instead. Anonymous access stays reachable the only way it should be: by passing no creds.
      ...authOpts({ token: this.identity.token, user: this.identity.user, pass: this.identity.pass, creds: this.cred.currentCreds !== undefined || this.identity.credsSource ? () => this.presentCreds() : undefined, bearer: this.identity.userMode ? () => this.presentBearer() : undefined, sentinelCreds: this.identity.sentinelCreds, tls: this.identity.tls,
        onCreds: (creds) => {
          watchDeletePermission = undefined;
          try {
            const nats = credsClaims(creds).nats;
            if (nats?.pub !== undefined)
              watchDeletePermission = importNativeSubjectPermissions({ pub: nats.pub }).publish;
          } catch {
            // Unknown/malformed claims cannot prove a denial. Keep the existing broker check.
          }
        },
      }),
    });
    // SPEC §13.12: the control surface requires nats-server >= 2.12; this runs on every
    // fresh connection, including the reconnects the library performs on its own here.
    this.conn.watchDeletePermissions.set(this.conn.nc, () => watchDeletePermission);
    this.conn.ownedConnections.add(this.conn.nc);
    const owned = this.conn.nc;
    void owned.closed().then(() => this.conn.ownedConnections.delete(owned));
    this.identity.onConnection?.(this.conn.nc);
    requireBrokerFloor(this.conn.nc);
    this.armAuthExpiryReconnectFence(this.conn.nc);
    this.watchStatus();
    this.conn.js = jetstream(this.conn.nc);

    // DM-only (EndpointOptions.dmOnly): the own DM durable is the whole binding. Nothing below runs:
    // no accepted-row read, presence, channel registry, JetStream manager, lease, membership,
    // Plane-3 or liveness responder, so the credential needs no row for any of them.
    if (this.identity.dmOnly) {
      await this.identity.beforeBind?.();
      if (this.lifecycle.stopped) return;
      await this.bindDmOnly(this.identity.dmOnly);
      if (this.lifecycle.stopped) return;
      this.emit("connection", { connected: true });
      return;
    }

    // Discovery of the issued generation (SPEC 13.15): the ISSUER wrote the accepted reference
    // under the token this launch was handed; the broker admits the read only under this
    // connection's own per-key grant. What comes back must name this incarnation, and a fresh
    // connection re-reads it: the generation is bound to the credential the transport presented,
    // never to a file that may have been replaced under it.
    if (this.identity.acceptedToken !== undefined) {
      const ref = await readAcceptedRow(this.conn.nc, this.identity.space, this.identity.acceptedToken);
      const uid = this.requireLifecycleUid("an issued endpoint");
      if (ref.owner !== this.identity.owner || ref.actor !== this.identity.actor || ref.uid !== uid)
        throw new Error(`the accepted row names ${ref.owner}.${ref.actor} (uid ${ref.uid}), not this endpoint ${this.identity.owner}.${this.identity.actor} (uid ${uid}); refusing to ride a foreign issuance (SPEC 13.15)`);
      this.conn.issuedGeneration = ref.generation;
    }

    await this.identity.beforeBind?.();
    if (this.lifecycle.stopped) return;

    // A one-shot observer must not initialize an open space just to read it.
    const createBuckets = !this.authed && !this.identity.readOnce;
    if (this.identity.doWatch || this.identity.doRegister) {
      const kvm = new Kvm(this.conn.nc);
      this.conn.kv = createBuckets
        ? await kvm.create(presenceBucket(this.identity.space), { ttl: this.identity.ttlMs, storage: PRESENCE_STORAGE })
        : await kvm.open(presenceBucket(this.identity.space));
      if (!this.authed && this.identity.readOnce && !(await bucketExists(this.conn.kv))) this.conn.kv = undefined;
    }

    if (this.identity.doWatch && this.identity.readOnce) await this.readPresenceOnce();
    else if (this.identity.doWatch) {
      await this.startPresenceWatch();
      this.sweepTimer = setInterval(
        () => this.sweep(),
        Math.max(500, Math.floor(this.identity.ttlMs / 3)),
      );
    }

    // Open the channel registry bucket when we either watch it (live cache for the connector's
    // pull/display) or consume (the join-time replay decision reads it fresh). A presence-only
    // supervisor (watchChannels:false, consume:false) skips it entirely — it needs no channel cache,
    // so its scoped cred holds no channel-registry read (residual 2). Auth mode OPENs the bucket
    // pre-created at `cotal up`; an open live endpoint can lazily create it.
    const watchChannels = this.identity.doWatch && this.identity.doWatchChannels;
    if (watchChannels || this.identity.doConsume) {
      this.conn.channelKv = await openChannelRegistry(this.conn.nc, this.identity.space, { create: createBuckets });
      if (!this.authed && this.identity.readOnce && !(await bucketExists(this.conn.channelKv))) this.conn.channelKv = undefined;
      if (watchChannels) await (this.identity.readOnce ? this.readChannelsOnce() : this.startChannelWatch());
      // A seat reads the registry on demand, as it reads the roster; this first read fills the cache
      // its boot briefing renders from.
      else if (this.readsChannelsOnDemand) await this.readChannels();
    }

    // Rebind the daemon's lease-loss watch onto the fresh connection (#1596). The intent survived
    // clearConnectionScoped; a bind that completes after a stop or another rebuild finds the epoch
    // moved and retires itself. The replay re-delivers the row's current state, so a change that
    // landed in the null window still reaches the trigger.
    if (this.deliveryLease.hasWatchIntent) await this.bindDeliveryLeaseWatch();

    // FAIL BEFORE PRESENCE (SPEC 13.1): an AUTHED endpoint that will register on the roster or
    // bind lifecycle-keyed consumers must hold its launcher-supplied lifecycle uid BEFORE anything
    // makes it visible - a missing uid must never leave a roster ghost that could not bind (false
    // readiness). Non-registering, non-consuming infra endpoints (a provisioner window, the
    // delivery daemon, one-shot CLI probes) bind no lifecycle-keyed names and stay outside the
    // rule; open/token mode self-minted at construction, so this only ever throws for a
    // mis-launched AUTH endpoint.
    if (this.authed && (this.identity.doConsume || this.identity.doRegister))
      this.requireLifecycleUid(this.identity.doConsume ? "an authed consuming endpoint" : "an authed presence-registering endpoint");

    // Consumers bind BEFORE presence publishes: the durable bind is the broker's proof that this
    // incarnation's lifecycle-keyed names match its minted grants, so a wrong-uid launch dies
    // with NO presence ghost instead of advertising an agent that can never receive.
    if (this.identity.doConsume) {
      this.conn.jsm = await jetstreamManager(this.conn.nc);
      // Open mode: lazily create the streams on the first endpoint. Auth mode: they are
      // pre-created at `cotal up` and STREAM.CREATE is denied to agents, so skip.
      if (!this.authed) await this.ensureStreams();
      await this.startConsumers();
    }

    // The register-only broker proof: a consuming agent proved its lifecycle by binding a
    // durable above, but an authed AGENT that only REGISTERS presence (consume:false) has bound
    // nothing yet, so a wrong-but-valid uid would grammar-pass requireLifecycleUid and then
    // advertise a ghost that can receive nothing. Prove the incarnation at the broker FIRST — an
    // exact info on this agent's own pre-provisioned dm_<owner>-<actor>-<uid> durable (the
    // manager/self-provision minted it under the SAME uid). A wrong uid names a durable that
    // does not exist, so the info throws and presence never publishes. Only for `kind: "agent"`
    // (a peer on the roster); pure `kind: "endpoint"` infra (manager, delivery, feedback intake)
    // holds no dm_ durable and stays exempt.
    if (this.identity.doRegister && !this.identity.doConsume && this.authed && this.identity.card.kind === "agent") {
      const jsm = this.conn.jsm ?? (this.conn.jsm = await jetstreamManager(this.conn.nc));
      const uid = this.requireLifecycleUid("an authed presence-registering agent");
      try {
        await jsm.consumers.info(dmStream(this.identity.space), dmDurable(this.identity.owner, this.identity.actor, uid));
      } catch (e) {
        throw new Error(
          `lifecycle proof failed for ${this.identity.card.id} (uid ${uid}): its dm_ durable is not present at the broker, so this incarnation's uid does not match its provisioned resources - refusing to publish presence (SPEC 13.1 fail-before-presence): ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }

    if (this.identity.doRegister) {
      // #1356: this await is bounded already — a refused presence write returns no response at all,
      // so it surfaces as the JetStream request TIMEOUT (~5s), once, with no retry here. What it did
      // NOT do was say what failed: the bare `timeout` names no bucket, no space and no subsystem,
      // and a launcher that catches it has nothing to act on. The lifecycle-proof failure a few lines
      // above throws a fully explanatory message; this one is held to the same standard. Still fails
      // rather than degrading — SPEC 13.1 fail-before-presence means a registering agent that cannot
      // publish presence must not come up as though it had.
      try {
        await this.publishPresence();
      } catch (e) {
        const detail = (e as Error)?.message ?? String(e);
        throw new Error(
          `presence registration failed for ${this.identity.card.id}: the space's presence KV bucket "${presenceBucket(this.identity.space)}" did not accept this endpoint's first write (${detail}). The bucket can be OPENED and WATCHED while refusing every write, so a healthy-looking connection does not rule this out; a broker whose store has latched refuses until it is restarted, and no client can clear it (#1356).`,
        );
      }
      // Beat at this endpoint's own phase. A repeating timer re-arms from the instant its callback
      // ran, and every timer run in one timers pass re-arms to the same instant, so the heartbeats of
      // many endpoints in one process that once coincided stay coincident and the loop takes the whole
      // batch in one tick (5088 endpoints in one process: 1 to 2 s stalls, with the put deadlines
      // expiring inside them). Re-arming from the scheduled beat keeps each endpoint's phase.
      const phase = Date.now();
      let beat = 0;
      const arm = () => {
        const next = nextHeartbeat(phase, this.identity.heartbeatMs, beat, Date.now());
        beat = next.beat;
        const handle = setTimeout(() => {
          this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
          if (this.heartbeatTimer === handle) arm();
        }, next.delayMs);
        this.heartbeatTimer = handle;
      };
      arm();
    }

    // Caller-owned membership watches are INTENT rather than one-connection iterators. Re-open them
    // before reporting the endpoint connected, so a successful reconnect does not leave the graph stale.
    await this.rearmMembershipWatches();

    // Re-arm Plane-3 (delivery-daemon-hosted fan-out + trusted reader + ctl.delivery) on every (re)connect — no-op unless this
    // endpoint hosts it. The first arm comes from startPlane3 (after start()); this re-binds the loops
    // a reconnect's clearConnectionScoped() tore down, so a broker blip doesn't silently kill the backstop.
    await this.armPlane3();

    // Re-bind the liveness responders on this connection, for armPlane3's reason: the rebuild closed
    // the old connection and the responders with it.
    for (const plane of this.delivery.livenessResponders.keys()) this.bindLiveness(plane);
    // The principal serves subscribe again on the new connection and run their check again.
    this.rebindPrincipalServes(false);
    for (const tap of this.taps) this.bindTap(tap);

    // Bound and live — covers initial start, manual reconnect, AND background self-heal (every
    // path lands here). The single signal an in-process agent's connected flag tracks.
    //
    // The stopped guard: stop() can land in any await above. Both callers tear the fresh
    // connection back down (tearDownIfStopped), but an event has no undo, so a late
    // `connection: true` would be the last edge a listener ever sees on a stopped endpoint and
    // nothing follows it to correct the record. It belongs here rather than in a consumer because
    // every listener reads the same edge; MeshAgent carries its own `stopping` guard and so was
    // never the one exposed, which is the point.
    //
    // Measured for the start() caller by the broker suite's mid-bind cell. doRebuild is
    // also measured, by a separate cell that holds the rebuild's connectAndBind at
    // armPlane3 after a successful first bind and lands stop() in that window (#1028).
    // Shared-line reasoning is no longer the rebuild proof.
    if (this.lifecycle.stopped) return;
    this.emit("connection", { connected: true });
    if (this.conn.nc) {
      for (const follower of this.delivery.activeGoalFollowers) {
        follower.reconnected(this.conn.nc);
      }
    }
  }

  /** Keep `tap` as intent and subscribe it on the current connection. */
  addTap(tap: (typeof this.taps)[number]): void {
    this.taps.push(tap);
    this.bindTap(tap);
  }

  /** Subscribe one {@link tap} on the current connection; with none, the next bind subscribes it. */
  private bindTap(tap: (typeof this.taps)[number]): void {
    if (!this.conn.nc) return;
    const sub = this.conn.nc.subscribe(tap.subject);
    this.delivery.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        if (hasStoredOrigin(m.headers)) continue;
        let decoded: CotalMessage | undefined;
        try {
          decoded = m.json<CotalMessage>();
        } catch {
          decoded = undefined;
        }
        const parsed = parseSubject(m.subject);
        if (decoded !== undefined && (parsed?.kind === "chat" || parsed?.kind === "evp" || parsed?.kind === "inst" || parsed?.kind === "svc")) {
          if (!isFromSubjectSender(decoded, parsed)) continue;
          // A message whose parts cannot be read is dropped, as history drops it (#7060).
          if (parsed.kind !== "evp" && (!Array.isArray(decoded.parts) || !decoded.parts.every(isReadableMessagePart))) continue;
          decoded = authenticatedMessage(decoded, parsed);
        }
        // A handler that throws is reported and the feed goes on. Leaving this loop would stop every
        // later frame while the process keeps running (#7060).
        try {
          tap.handler(m.subject, decoded);
        } catch (e) {
          this.emit("error", e as Error);
        }
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  /** Record the consumer behind one of this connection's own KV watches or membership scans, and
   *  return the delete-subject prefix it recorded. nats.js names it `<prefix>_<serial>` and,
   *  rebuilding it after a stall or a sequence gap, deletes the predecessor itself with no hook before
   *  the send, so a profile without the delete row (#691) has that delete refused. A stalled link can
   *  time that delete out before its refusal arrives, and nats.js then hands the refusal to no request,
   *  so {@link trackRequestDenials} cannot own it and the consumer's name has to. A watch's prefix
   *  stays recorded for the connection because a retired watch's last rebuild can be refused after
   *  the watch has stopped; {@link readMembership} retires its scan's after its own last delete,
   *  which goes out once nats.js has stopped the consumer and so is answered after every predecessor
   *  delete. */
  recordOwnWatchConsumer({ stream_name, name }: ConsumerInfo): string {
    const prefix = `$JS.API.CONSUMER.DELETE.${stream_name}.${name.slice(0, name.lastIndexOf("_") + 1)}`;
    this.ownWatchDeletePrefixes.add(prefix);
    return prefix;
  }

  /** Whether `subject` deletes `<prefix>_<serial>` of a consumer {@link recordOwnWatchConsumer} recorded. */
  isOwnWatchDelete(subject: string): boolean {
    const cut = subject.lastIndexOf("_") + 1;
    return /^\d+$/.test(subject.slice(cut)) && this.ownWatchDeletePrefixes.has(subject.slice(0, cut));
  }

  /** Report a subscription denial once by error identity, whichever reporting path receives it first. */
  reportSubscriptionDenial(error: unknown): boolean {
    if (!(error instanceof PermissionViolationError) || error.operation !== "subscription") return false;
    if (!this.reportedSubRefusals.has(error)) {
      this.reportedSubRefusals.add(error);
      this.emit("error", describeStatusError(error));
    }
    return true;
  }
  /** Tear down everything {@link connectAndBind} (re)creates, so a rebind can't leak a
   *  second heartbeat, double-pump a consumer, or keep stale roster ghosts. Caller-owned
   *  subs (tap/serve) are left alone — they aren't rebuilt here. */
  clearConnectionScoped(): void {
    if (this.cred.authExpiryReconnectTimer) {
      clearTimeout(this.cred.authExpiryReconnectTimer);
      this.cred.authExpiryReconnectTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const msgs of this.delivery.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed with the connection */
      }
    }
    this.delivery.streamMsgs.length = 0;
    this.lifecycle.presenceEpoch++;
    this.presence.cancelRebind();
    this.presence.retireWatch();
    if (this.conn.channelWatchIter) this.retireKvWatch(this.conn.channelWatchIter);
    this.conn.channelWatchIter = undefined;
    this.stopDeliveryLeaseWatch();
    for (const sub of this.delivery.chatSubs.values()) {
      try {
        sub.unsubscribe();
      } catch {
        /* already closed with the connection */
      }
    }
    this.delivery.chatSubs.clear();
    this.delivery.chatSubDenied.clear();
    this.ownWatchDeletePrefixes.clear();
    this.presence.resetConnection();
    this.channelRegistry.channelConfigs.clear();
    this.channelRegistry.channelDefaults = {};
    // A read in flight on the old connection must not land in the new connection's cache.
    this.channelRegistry.channelRead = undefined;
    this.channelRegistry.channelReadGeneration++;
    this.channelRegistry.channelReadApplied = this.channelRegistry.channelReadGeneration;
    for (const watch of this.conn.membershipFeedWatches)
      watch.arm = watch.arm.catch(() => {}).then(() => this.disarmMembershipWatch(watch)).catch((err) => { this.emit("error", err as Error); });
  }

  /** A transport can connect before a later JetStream/KV/subscription bind fails. The caller will
   * retry the whole start, so release that partial epoch first instead of overwriting `nc` and
   * leaving one established socket behind per retry. `close()` is deliberate: a failed bind has no
   * graceful delivery contract to drain, and cleanup itself must not extend the retry failure.
   *
   * A throwing `close()` is not hypothetical: nats.js `NatsConnectionImpl.close()` awaits the
   * protocol close, which itself flushes outbound + tears down subscription state; any of those
   * that reject leaves the underlying TCP transport ESTABLISHED even though every client handle
   * on this endpoint has been cleared. The next `start()` on the same object then dials a fresh
   * connection while the old socket stays live on the broker (`/varz.connections` climbs once per
   * failed attempt). The recovery path is layered, from most graceful to most surgical, matching
   * nats-core's public surface (nats.d.ts: `close`, `drain`, `isClosed`; protocol.d.ts owns the
   * `transport` handle whose `close(err?)` is the socket teardown; transport.d.ts exposes a
   * synchronous `disconnect()` for the case where even close rejects). We only touch a private
   * (`nc.protocol.transport`) when the public API has already refused, and the ORIGINAL bind
   * error is re-raised at every layer. The close error is diagnostic noise. The bind error is
   * what the caller must see.
   *
   * The delivery-serve subs and `this.subs` array are handles created by a successful
   * `armDeliveryControl` on a PREVIOUS epoch; a bind failure on the retry never rewrites them
   * because arming is a late step. Left in place they point at a dead protocol and survive into
   * the next retry. The reviewer flagged this as an untested handle class. Zero them here so a
   * retry starts with the same empty state as a first attempt. */
  async closeFailedBind(): Promise<void> {
    const failedNc = this.conn.nc;
    if (failedNc) this.disableLibraryReconnect(failedNc);
    this.clearConnectionScoped();
    this.conn.nc = undefined;
    this.conn.js = undefined;
    this.conn.jsm = undefined;
    this.conn.kv = undefined;
    this.conn.channelKv = undefined;
    this.conn.membersKv = undefined;
    this.conn.aclKv = undefined;
    this.conn.membershipFeedKv = undefined;
    this.deliveryLease.resetConnection();
    this.conn.managerLeaseKv = undefined;
    this.conn.daemonRenewalLeaseRevision = undefined;
    // Handles that armDeliveryControl created on a previous connection: null them so a rebind
    // does not carry a dead protocol's subs forward. Best-effort unsubscribe first (the sub is
    // dead with its connection either way; unsubscribing an already-dead sub is a noop).
    if (this.deliveryPlane.deliveryServeSub) {
      try { this.deliveryPlane.deliveryServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      this.deliveryPlane.deliveryServeSub = undefined;
    }
    if (this.deliveryPlane.deliveryAdminServeSub) {
      try { this.deliveryPlane.deliveryAdminServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      this.deliveryPlane.deliveryAdminServeSub = undefined;
    }
    this.dropAnycastRequests();
    for (const sub of this.delivery.subs) {
      try { sub.unsubscribe(); } catch { /* dead with the old connection */ }
    }
    this.delivery.subs.length = 0;
    if (!failedNc) return;
    // The old status iterator is stale after nc is cleared, so its close cannot report this edge.
    // As in doRebuild, teardown itself must announce the no-nc window before closing the socket.
    this.emit("transport", { connected: false } satisfies TransportState);
    this.emit("connection", { connected: false });
    // Layered teardown, comments kept OUT of the code span below on purpose: the mutation fixture
    // bin/smoke/mutations/failed-bind-cleanup.json anchors on that span verbatim and the fixture
    // census (bin/smoke/mutation-fixtures.smoke.ts) reddens an anchor that crosses a comment line.
    //   Fast path: the public close resolved, the broker drops the connection on its own.
    //   Layer 1: nats.js exposes drain() as the sanctioned "close on error" path. It flushes
    //   outbound then closes, and unlike close() has its own idempotent guard against a half-closed
    //   protocol. If drain resolves the socket is gone.
    //   Layer 2: last resort. nats.js `NatsConnectionImpl.protocol.transport` (see
    //   node_modules/@nats-io/nats-core/lib/{nats,protocol,transport}.d.ts) is the TCP socket the
    //   dialer produced. Its `close(err?)` returns a Promise once the socket is torn down; its
    //   synchronous `disconnect()` forces the FIN without waiting. Reached only after the public
    //   API has already refused, guarded only against the shape not being what the pinned version
    //   documents.
    try {
      await failedNc.close();
      return;
    } catch { /* fall through to the layered fallback */ }
    if (!failedNc.isClosed?.()) {
      try {
        await drainAndClose(failedNc);
        return;
      } catch { /* both graceful paths refused, drop to the transport */ }
    }
    const proto = (failedNc as unknown as { protocol?: { transport?: {
      close?: (err?: Error) => Promise<void>;
      disconnect?: () => void;
      isClosed?: boolean;
    } } }).protocol;
    const transport = proto?.transport;
    if (transport && !transport.isClosed) {
      try {
        await transport.close?.();
      } catch { /* transport close itself threw, force it down synchronously below */ }
      if (!transport.isClosed) {
        try { transport.disconnect?.(); } catch { /* nothing left to try */ }
      }
    }
  }

  /** If stop() ran during a rebuild's `await connectAndBind`, the just-bound connection +
   *  heartbeat + supervisor would be left live on a stopped endpoint. Tear that fresh
   *  connection back down and report it. Reads `this.nc` in its own scope (a bare `this.nc`
   *  in doRebuild narrows to `never` via TS inlining connectAndBind's assignment). Returns
   *  true iff it tore something down (caller bails out of the rebuild). */
  async tearDownIfStopped(): Promise<boolean> {
    if (!this.lifecycle.stopped) return false;
    const nc = this.conn.nc;
    if (nc) this.disableLibraryReconnect(nc);
    this.clearConnectionScoped();
    await this.closeWithoutLibraryReconnect(nc);
    this.conn.nc = undefined;
    return true;
  }

  async stopOnce(): Promise<void> {
    if (this.conn.nc) this.disableLibraryReconnect(this.conn.nc);
    this.lifecycle.stopped = true;
    for (const follower of this.delivery.activeGoalFollowers) {
      follower.cancel();
    }
    this.delivery.activeGoalFollowers.clear();
    this.lifecycle.presenceEpoch++;
    // Every principal serve ends now, so a `ready` still waiting for the broker rejects and no new
    // request is taken. Its handlers in flight finish below, before the connection they reply on
    // closes, or their requests' deadlines pass.
    const principalStops = [...this.delivery.principalServes.values()].map((intent) => this.stopPrincipalServe(intent, false));
    this.presence.cancelRebind();
    // Wake a reestablishLoop sitting in backoff so it sees `stopped` and exits instead of
    // sleeping out retryMs; also clears the timer so it can't fire later.
    this.kickBackoff();
    for (const wake of [...this.lifecycle.membershipPauses]) wake();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.cred.cancelBearerRenewal?.();
    this.cancelCredsRefresh();
    if (this.cred.authExpiryReconnectTimer) clearTimeout(this.cred.authExpiryReconnectTimer);
    for (const watch of this.conn.membershipFeedWatches) {
      watch.stopped = true;
      watch.arm = watch.arm.catch(() => {}).then(async () => {
        await this.disarmMembershipWatch(watch);
        await this.deleteRetainedMembershipConsumer(watch);
      });
    }
    // Permanent endpoint shutdown has no future epoch. Try strict cleanup on the current live epoch;
    // if the broker is already gone, terminate local ownership rather than hanging shutdown forever.
    await Promise.all([...this.conn.membershipFeedWatches].map((watch) => watch.arm.catch((err) => {
      if (this.conn.nc && !this.conn.nc.isClosed()) throw err;
    })));
    for (const watch of this.conn.membershipFeedWatches) {
      watch.resolveStop?.();
      watch.resolveStop = undefined;
      watch.rejectStop = undefined;
    }
    this.conn.membershipFeedWatches.clear();
    for (const msgs of this.delivery.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed */
      }
    }
    this.presence.retireWatch();
    if (this.conn.channelWatchIter) this.retireKvWatch(this.conn.channelWatchIter);
    this.conn.channelWatchIter = undefined;
    this.stopDeliveryLeaseWatch();
    await Promise.all(principalStops);
    try {
      if (this.identity.doRegister) {
        await this.presence.publishOffline();
      }
    } catch {
      /* best-effort graceful leave */
    }
    await Promise.all([this.settleDeliveryLeaseWatches(), this.settleKvWatches()]);
    // DM-only: the pull above is stopped, so no new copy reaches the handler. Let a running handler
    // settle while the connection is still open, so its ack can reach the broker; close either way.
    let dmOnlyUnsettled = false;
    if (this.identity.dmOnly && this.delivery.dmOnlyInFlight) {
      const settleMs = this.identity.dmOnly.settleTimeoutMs ?? 30_000;
      dmOnlyUnsettled = await withDeadline(this.delivery.dmOnlyInFlight.then(() => false), settleMs, () => new Error("unsettled"))
        .catch(() => true);
    }
    await this.closeWithoutLibraryReconnect(this.conn.nc);
    // #1356: stop() does its own teardown and never runs clearConnectionScoped, so clear here too —
    // AFTER the best-effort offline publish above, which would otherwise re-record a refusal on its
    // way out. A stopped endpoint has no live basis for "this bucket is refusing writes", and the
    // duration is computed from `Date.now()`, so a retained record does not merely go stale: it keeps
    // COUNTING UP for as long as the dead object is held.
    this.clearPresenceWriteFailure();
    // Custody callers must not observe stop completion while a concurrent rebind can still
    // publish a late consuming connection. doRebuild closes its stopped epoch before resolving.
    await this.lifecycle.rebuildPromise;
    await this.lifecycle.startPromise;
    if ([...this.conn.ownedConnections].some((nc) => !nc.isClosed()))
      throw new Error("endpoint stop could not prove its connection closed; local consumer custody must be retained");
    if (dmOnlyUnsettled)
      throw new Error(`endpoint stop closed the connection but the DM-only handler did not settle within ${this.identity.dmOnly?.settleTimeoutMs ?? 30_000}ms; its copy stays unacked and handler custody must be retained`);
  }

  /** The native binding of every connection this endpoint holds. A host compares the list with a
   *  complete native census of the account to show that no other connection uses it. The list
   *  proves neither liveness nor the absence of other connections. A stopped endpoint whose
   *  connections all closed reports none. It throws while there is no settled answer: before
   *  start, during a start, rebuild or stop, while a credential transaction or its connection swap
   *  is pending, and while the connection is down or redialing. */
  nativeConnections(): NativeConnectionBinding[] {
    const unsettled = (why: string) => new Error(`endpoint connection inventory is unsettled: ${why}`);
    if (this.lifecycle.startPromise !== undefined || this.lifecycle.rebuildPromise !== undefined || this.lifecycle.reconnecting)
      throw unsettled("a start or rebuild is in flight");
    const open = [...this.conn.ownedConnections].filter((nc) => !nc.isClosed());
    if (this.lifecycle.stopped) {
      if (open.length > 0) throw unsettled("the endpoint stopped but a connection has not closed");
      return [];
    }
    if (this.cred.credsTxnsRunning > 0 || this.cred.residentSwap !== undefined)
      throw unsettled("a credential adoption is in flight");
    if (!this.conn.nc || !this.conn.nativeBound) throw unsettled("the connection is down or redialing");
    return open.map((nc) => nativeConnectionBinding(nc, "endpoint connection"));
  }
}
