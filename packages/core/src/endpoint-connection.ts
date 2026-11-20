// The connection bind and teardown of CotalEndpoint, as an internal component: open a connection and bind
// everything that hangs off it, clear the connection-scoped state, close a failed bind, tear down a bind
// that lost a race with stop, stop the endpoint, and report its native connections. Moved verbatim from
// endpoint.ts; the endpoint keeps connectAndBind, the supervisor and the retry loop and forwards to these.
// Not re-exported by the index.
import { requireBrokerFloor } from "./broker-floor.js";
import { openChannelRegistry } from "./channels.js";
import { drainAndClose } from "./connection-cleanup.js";
import { withDeadline } from "./deadline.js";
import type { EndpointDeliveryLease } from "./endpoint-delivery-lease.js";
import type { EndpointDeliveryPlane } from "./endpoint-delivery-plane.js";
import { bearerRenewalDeadlineMs, RepeatedRefusal, dialerFor, authOpts } from "./endpoint-dial.js";
import type { DmOnlyOptions, PrincipalServeIntent, TransportState } from "./endpoint-options.js";
import type { EndpointPresence } from "./endpoint-presence.js";
import type { MembershipFeedWatch } from "./endpoint-subscriptions.js";
import { credsRenewalDelayMs, credsClaims } from "./identity.js";
import { type IssuedSubjectPermission, importNativeSubjectPermissions, readAcceptedRow } from "./issued-authority.js";
import type { LivenessPlane, ResponderState } from "./liveness.js";
import { type NativeConnectionBinding, nativeConnectionBinding } from "./native-connection.js";
import { nextHeartbeat } from "./presence-heartbeat.js";
import { PRESENCE_STORAGE } from "./streams.js";
import { presenceBucket, dmStream, dmDurable } from "./subjects.js";
import type { AgentCard, CotalMessage, ChannelConfig, ChannelDefaults } from "./types.js";
import { type JetStreamClient, type JetStreamManager, type ConsumerMessages, type ConsumerInfo, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { type KV, Kvm } from "@nats-io/kv";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";

/** What the connection component reads from its endpoint. State is read when it is used, never copied, a
 *  field it reassigns is written back through its setter, and every method is looked up on the endpoint
 *  at call time, so a member a caller replaced on the endpoint is the one that runs. */
export interface EndpointConnectionDeps {
  bearerSource: () => (() => Promise<string>) | undefined;
  currentBearer: () => string | undefined;
  bearerRenewalFailures: () => number;
  bearerAdoptedAtMs: () => number;
  credsSource: () => (() => Promise<string>) | undefined;
  currentCreds: () => string | undefined;
  userMode: () => boolean;
  bearerRefusalSurfaced: () => boolean;
  setBearerRefusalSurfaced: (value: boolean) => void;
  nc: () => NatsConnection | undefined;
  setNc: (value: NatsConnection | undefined) => void;
  servers: () => string;
  connId: () => string;
  card: () => AgentCard;
  transportPingIntervalMs: () => number | undefined;
  transportMaxPingOut: () => number | undefined;
  transportConnectTimeoutMs: () => number | undefined;
  token: () => string | undefined;
  user: () => string | undefined;
  pass: () => string | undefined;
  sentinelCreds: () => string | undefined;
  tls: () => boolean;
  watchDeletePermissions: () => WeakMap<object, () => IssuedSubjectPermission | undefined>;
  ownedConnections: () => Set<NatsConnection>;
  onConnection: () => ((nc: NatsConnection) => void) | undefined;
  js: () => JetStreamClient | undefined;
  setJs: (value: JetStreamClient | undefined) => void;
  dmOnly: () => DmOnlyOptions | undefined;
  beforeBind: () => (() => Promise<void>) | undefined;
  stopped: () => boolean;
  setStopped: (value: boolean) => void;
  acceptedToken: () => string | undefined;
  space: () => string;
  owner: () => string;
  actor: () => string;
  issuedGeneration: () => string | undefined;
  setIssuedGeneration: (value: string | undefined) => void;
  doWatch: () => boolean;
  doRegister: () => boolean;
  kv: () => KV | undefined;
  setKv: (value: KV | undefined) => void;
  authed: () => boolean;
  ttlMs: () => number;
  readOnce: () => boolean;
  sweepTimer: () => ReturnType<typeof setInterval> | undefined;
  setSweepTimer: (value: ReturnType<typeof setInterval> | undefined) => void;
  doWatchChannels: () => boolean;
  doConsume: () => boolean;
  channelKv: () => KV | undefined;
  setChannelKv: (value: KV | undefined) => void;
  readsChannelsOnDemand: () => boolean;
  deliveryLease: () => EndpointDeliveryLease;
  jsm: () => JetStreamManager | undefined;
  setJsm: (value: JetStreamManager | undefined) => void;
  heartbeatMs: () => number;
  heartbeatTimer: () => ReturnType<typeof setInterval> | undefined;
  setHeartbeatTimer: (value: ReturnType<typeof setInterval> | undefined) => void;
  livenessResponders: () => Map<LivenessPlane, { readState: () => Promise<ResponderState> | ResponderState; sub?: Subscription }>;
  taps: () => { readonly handler: (subject: string, msg: CotalMessage | undefined) => void; readonly subject: string }[];
  activeGoalFollowers: () => Set<{ cancel: () => void; reconnected: (nc: NatsConnection) => void; }>;
  authExpiryReconnectTimer: () => NodeJS.Timeout | undefined;
  setAuthExpiryReconnectTimer: (value: NodeJS.Timeout | undefined) => void;
  streamMsgs: () => ConsumerMessages[];
  presenceEpoch: () => number;
  setPresenceEpoch: (value: number) => void;
  presence: () => EndpointPresence;
  channelWatchIter: () => Awaited<ReturnType<KV["watch"]>> | undefined;
  setChannelWatchIter: (value: Awaited<ReturnType<KV["watch"]>> | undefined) => void;
  chatSubs: () => Map<string, Subscription>;
  chatSubDenied: () => Set<string>;
  ownWatchDeletePrefixes: () => Set<string>;
  channelConfigs: () => Map<string, ChannelConfig>;
  channelDefaults: () => ChannelDefaults;
  setChannelDefaults: (value: ChannelDefaults) => void;
  channelRead: () => Promise<void> | undefined;
  setChannelRead: (value: Promise<void> | undefined) => void;
  channelReadGeneration: () => number;
  setChannelReadGeneration: (value: number) => void;
  channelReadApplied: () => number;
  setChannelReadApplied: (value: number) => void;
  membershipFeedWatches: () => Set<MembershipFeedWatch>;
  membersKv: () => KV | undefined;
  setMembersKv: (value: KV | undefined) => void;
  aclKv: () => KV | undefined;
  setAclKv: (value: KV | undefined) => void;
  membershipFeedKv: () => KV | undefined;
  setMembershipFeedKv: (value: KV | undefined) => void;
  managerLeaseKv: () => KV | undefined;
  setManagerLeaseKv: (value: KV | undefined) => void;
  daemonRenewalLeaseRevision: () => number | undefined;
  setDaemonRenewalLeaseRevision: (value: number | undefined) => void;
  deliveryPlane: () => EndpointDeliveryPlane;
  subs: () => Subscription[];
  principalServes: () => Map<string, PrincipalServeIntent>;
  membershipPauses: () => Set<() => void>;
  cancelBearerRenewal: () => (() => void) | undefined;
  credsTimer: () => NodeJS.Timeout | undefined;
  dmOnlyInFlight: () => Promise<void> | undefined;
  rebuildPromise: () => Promise<void> | undefined;
  startPromise: () => Promise<void> | undefined;
  reconnecting: () => boolean;
  credsTxnsRunning: () => number;
  residentSwap: () => Promise<void> | undefined;
  nativeBound: () => boolean;
  refreshBearer: (initial?: boolean) => Promise<void>;
  refreshCreds: (initial?: boolean) => Promise<void>;
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
  bindTap: (tap: { readonly handler: (subject: string, msg: CotalMessage | undefined) => void; readonly subject: string }) => void;
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

/** One endpoint's connection bind and teardown. Internal: `CotalEndpoint` keeps the fields, connectAndBind,
 *  the supervisor and the retry loop, and forwards to it. */
export class EndpointConnection {
  constructor(private readonly deps: EndpointConnectionDeps) {}

  private get bearerSource() { return this.deps.bearerSource(); }
  private get currentBearer() { return this.deps.currentBearer(); }
  private get bearerRenewalFailures() { return this.deps.bearerRenewalFailures(); }
  private get bearerAdoptedAtMs() { return this.deps.bearerAdoptedAtMs(); }
  private get credsSource() { return this.deps.credsSource(); }
  private get currentCreds() { return this.deps.currentCreds(); }
  private get userMode() { return this.deps.userMode(); }
  private get bearerRefusalSurfaced() { return this.deps.bearerRefusalSurfaced(); }
  private set bearerRefusalSurfaced(value: boolean) { this.deps.setBearerRefusalSurfaced(value); }
  private get nc() { return this.deps.nc(); }
  private set nc(value: NatsConnection | undefined) { this.deps.setNc(value); }
  private get servers() { return this.deps.servers(); }
  private get connId() { return this.deps.connId(); }
  private get card() { return this.deps.card(); }
  private get transportPingIntervalMs() { return this.deps.transportPingIntervalMs(); }
  private get transportMaxPingOut() { return this.deps.transportMaxPingOut(); }
  private get transportConnectTimeoutMs() { return this.deps.transportConnectTimeoutMs(); }
  private get token() { return this.deps.token(); }
  private get user() { return this.deps.user(); }
  private get pass() { return this.deps.pass(); }
  private get sentinelCreds() { return this.deps.sentinelCreds(); }
  private get tls() { return this.deps.tls(); }
  private get watchDeletePermissions() { return this.deps.watchDeletePermissions(); }
  private get ownedConnections() { return this.deps.ownedConnections(); }
  private get onConnection() { return this.deps.onConnection(); }
  private get js() { return this.deps.js(); }
  private set js(value: JetStreamClient | undefined) { this.deps.setJs(value); }
  private get dmOnly() { return this.deps.dmOnly(); }
  private get beforeBind() { return this.deps.beforeBind(); }
  private get stopped() { return this.deps.stopped(); }
  private set stopped(value: boolean) { this.deps.setStopped(value); }
  private get acceptedToken() { return this.deps.acceptedToken(); }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get issuedGeneration() { return this.deps.issuedGeneration(); }
  private set issuedGeneration(value: string | undefined) { this.deps.setIssuedGeneration(value); }
  private get doWatch() { return this.deps.doWatch(); }
  private get doRegister() { return this.deps.doRegister(); }
  private get kv() { return this.deps.kv(); }
  private set kv(value: KV | undefined) { this.deps.setKv(value); }
  private get authed() { return this.deps.authed(); }
  private get ttlMs() { return this.deps.ttlMs(); }
  private get readOnce() { return this.deps.readOnce(); }
  private get sweepTimer() { return this.deps.sweepTimer(); }
  private set sweepTimer(value: ReturnType<typeof setInterval> | undefined) { this.deps.setSweepTimer(value); }
  private get doWatchChannels() { return this.deps.doWatchChannels(); }
  private get doConsume() { return this.deps.doConsume(); }
  private get channelKv() { return this.deps.channelKv(); }
  private set channelKv(value: KV | undefined) { this.deps.setChannelKv(value); }
  private get readsChannelsOnDemand() { return this.deps.readsChannelsOnDemand(); }
  private get deliveryLease() { return this.deps.deliveryLease(); }
  private get jsm() { return this.deps.jsm(); }
  private set jsm(value: JetStreamManager | undefined) { this.deps.setJsm(value); }
  private get heartbeatMs() { return this.deps.heartbeatMs(); }
  private get heartbeatTimer() { return this.deps.heartbeatTimer(); }
  private set heartbeatTimer(value: ReturnType<typeof setInterval> | undefined) { this.deps.setHeartbeatTimer(value); }
  private get livenessResponders() { return this.deps.livenessResponders(); }
  private get taps() { return this.deps.taps(); }
  private get activeGoalFollowers() { return this.deps.activeGoalFollowers(); }
  private get authExpiryReconnectTimer() { return this.deps.authExpiryReconnectTimer(); }
  private set authExpiryReconnectTimer(value: NodeJS.Timeout | undefined) { this.deps.setAuthExpiryReconnectTimer(value); }
  private get streamMsgs() { return this.deps.streamMsgs(); }
  private get presenceEpoch() { return this.deps.presenceEpoch(); }
  private set presenceEpoch(value: number) { this.deps.setPresenceEpoch(value); }
  private get presence() { return this.deps.presence(); }
  private get channelWatchIter() { return this.deps.channelWatchIter(); }
  private set channelWatchIter(value: Awaited<ReturnType<KV["watch"]>> | undefined) { this.deps.setChannelWatchIter(value); }
  private get chatSubs() { return this.deps.chatSubs(); }
  private get chatSubDenied() { return this.deps.chatSubDenied(); }
  private get ownWatchDeletePrefixes() { return this.deps.ownWatchDeletePrefixes(); }
  private get channelConfigs() { return this.deps.channelConfigs(); }
  private get channelDefaults() { return this.deps.channelDefaults(); }
  private set channelDefaults(value: ChannelDefaults) { this.deps.setChannelDefaults(value); }
  private get channelRead() { return this.deps.channelRead(); }
  private set channelRead(value: Promise<void> | undefined) { this.deps.setChannelRead(value); }
  private get channelReadGeneration() { return this.deps.channelReadGeneration(); }
  private set channelReadGeneration(value: number) { this.deps.setChannelReadGeneration(value); }
  private get channelReadApplied() { return this.deps.channelReadApplied(); }
  private set channelReadApplied(value: number) { this.deps.setChannelReadApplied(value); }
  private get membershipFeedWatches() { return this.deps.membershipFeedWatches(); }
  private get membersKv() { return this.deps.membersKv(); }
  private set membersKv(value: KV | undefined) { this.deps.setMembersKv(value); }
  private get aclKv() { return this.deps.aclKv(); }
  private set aclKv(value: KV | undefined) { this.deps.setAclKv(value); }
  private get membershipFeedKv() { return this.deps.membershipFeedKv(); }
  private set membershipFeedKv(value: KV | undefined) { this.deps.setMembershipFeedKv(value); }
  private get managerLeaseKv() { return this.deps.managerLeaseKv(); }
  private set managerLeaseKv(value: KV | undefined) { this.deps.setManagerLeaseKv(value); }
  private get daemonRenewalLeaseRevision() { return this.deps.daemonRenewalLeaseRevision(); }
  private set daemonRenewalLeaseRevision(value: number | undefined) { this.deps.setDaemonRenewalLeaseRevision(value); }
  private get deliveryPlane() { return this.deps.deliveryPlane(); }
  private get subs() { return this.deps.subs(); }
  private get principalServes() { return this.deps.principalServes(); }
  private get membershipPauses() { return this.deps.membershipPauses(); }
  private get cancelBearerRenewal() { return this.deps.cancelBearerRenewal(); }
  private get credsTimer() { return this.deps.credsTimer(); }
  private get dmOnlyInFlight() { return this.deps.dmOnlyInFlight(); }
  private get rebuildPromise() { return this.deps.rebuildPromise(); }
  private get startPromise() { return this.deps.startPromise(); }
  private get reconnecting() { return this.deps.reconnecting(); }
  private get credsTxnsRunning() { return this.deps.credsTxnsRunning(); }
  private get residentSwap() { return this.deps.residentSwap(); }
  private get nativeBound() { return this.deps.nativeBound(); }
  private refreshBearer(initial?: boolean): Promise<void> { return this.deps.refreshBearer(initial); }
  private refreshCreds(initial?: boolean): Promise<void> { return this.deps.refreshCreds(initial); }
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
  private bindTap(tap: { readonly handler: (subject: string, msg: CotalMessage | undefined) => void; readonly subject: string }): void { return this.deps.bindTap(tap); }
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
    if (this.bearerSource) {
      if (!this.currentBearer) await this.refreshBearer(true);
      else if (this.bearerRenewalFailures === 0 && Date.now() >= bearerRenewalDeadlineMs(this.currentBearer, this.bearerAdoptedAtMs)) await this.refreshBearer();
    }
    // Creds-source endpoints likewise fetch before the FIRST connect, and re-fetch on a rebuild
    // whose cached cred is expired or inside its renewal window.
    if (this.credsSource) {
      const stale = !this.currentCreds || credsRenewalDelayMs(this.currentCreds) <= 0;
      if (stale) await this.refreshCreds(!this.currentCreds);
    }
    // Never dial with material we can already prove is dead. The refresh above is best-effort (a
    // failed renewal emits and retries rather than throwing, so a dead auth service does not
    // instantly drop a still-live mesh), which used to leave the connect below presenting an
    // EXPIRED bearer: a guaranteed denial that still costs a full auth-callout round trip, repeated
    // by the reestablish loop at a flat rate for as long as the process lives. Refuse here instead.
    // The loop's capped backoff paces the retries and re-enters this method, and a renewal that
    // starts working ends its wait; an endpoint with no bearer source cannot renew at all, and says
    // so. The refusal is surfaced once per outage: the loop retries a repeat without a notice.
    if (this.userMode) {
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
    this.nc = await dialerFor(this.servers)({
      servers: this.servers,
      // Keep native failures without eagerly capturing a request-origin stack on every operation.
      noAsyncTraces: true,
      // In USER MODE the connection `name` carries the client-chosen inbox nonce (= connId) the callout
      // scopes `_INBOX_<connId>.>` on (see EndpointOptions.bearer); otherwise it's the display handle.
      name: this.userMode ? this.connId : `cotal:${this.card.name}`,
      // Per-CONNECTION inbox namespace (the "Private Inbox" pattern), keyed on the connection nkey
      // (NOT the owner+actor principal): the reply inbox is per-connection plumbing, and under the auth
      // callout the principal is unknown to the client pre-connect (owner is derived server-side) while
      // the connection id always is. nats.js routes ALL generated inboxes — request replies, JetStream
      // pull delivery, kv.watch ordered-consumer delivery — through this prefix. Paired with
      // sub.allow=[_INBOX_<connId>.>] it stops a peer from subscribing the wildcard inbox to sniff
      // others' DM deliveries. Set unconditionally so the prefix can never drift from the ACL.
      inboxPrefix: `_INBOX_${this.connId}`,
      ...(this.transportPingIntervalMs === undefined ? {} : { pingInterval: this.transportPingIntervalMs }),
      ...(this.transportMaxPingOut === undefined ? {} : { maxPingOut: this.transportMaxPingOut }),
      ...(this.transportConnectTimeoutMs === undefined ? {} : { timeout: this.transportConnectTimeoutMs }),
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
      ...authOpts({ token: this.token, user: this.user, pass: this.pass, creds: this.currentCreds !== undefined || this.credsSource ? () => this.presentCreds() : undefined, bearer: this.userMode ? () => this.presentBearer() : undefined, sentinelCreds: this.sentinelCreds, tls: this.tls,
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
    this.watchDeletePermissions.set(this.nc, () => watchDeletePermission);
    this.ownedConnections.add(this.nc);
    const owned = this.nc;
    void owned.closed().then(() => this.ownedConnections.delete(owned));
    this.onConnection?.(this.nc);
    requireBrokerFloor(this.nc);
    this.armAuthExpiryReconnectFence(this.nc);
    this.watchStatus();
    this.js = jetstream(this.nc);

    // DM-only (EndpointOptions.dmOnly): the own DM durable is the whole binding. Nothing below runs:
    // no accepted-row read, presence, channel registry, JetStream manager, lease, membership,
    // Plane-3 or liveness responder, so the credential needs no row for any of them.
    if (this.dmOnly) {
      await this.beforeBind?.();
      if (this.stopped) return;
      await this.bindDmOnly(this.dmOnly);
      if (this.stopped) return;
      this.emit("connection", { connected: true });
      return;
    }

    // Discovery of the issued generation (SPEC 13.15): the ISSUER wrote the accepted reference
    // under the token this launch was handed; the broker admits the read only under this
    // connection's own per-key grant. What comes back must name this incarnation, and a fresh
    // connection re-reads it: the generation is bound to the credential the transport presented,
    // never to a file that may have been replaced under it.
    if (this.acceptedToken !== undefined) {
      const ref = await readAcceptedRow(this.nc, this.space, this.acceptedToken);
      const uid = this.requireLifecycleUid("an issued endpoint");
      if (ref.owner !== this.owner || ref.actor !== this.actor || ref.uid !== uid)
        throw new Error(`the accepted row names ${ref.owner}.${ref.actor} (uid ${ref.uid}), not this endpoint ${this.owner}.${this.actor} (uid ${uid}); refusing to ride a foreign issuance (SPEC 13.15)`);
      this.issuedGeneration = ref.generation;
    }

    await this.beforeBind?.();
    if (this.stopped) return;

    if (this.doWatch || this.doRegister) {
      const kvm = new Kvm(this.nc);
      // The presence bucket is a JetStream stream. Open mode lazily creates it; auth mode
      // OPENs it (it's pre-created at `cotal up`; KV stream-create is denied to agents).
      this.kv = this.authed
        ? await kvm.open(presenceBucket(this.space))
        : await kvm.create(presenceBucket(this.space), { ttl: this.ttlMs, storage: PRESENCE_STORAGE });
    }

    if (this.doWatch && this.readOnce) await this.readPresenceOnce();
    else if (this.doWatch) {
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
      this.channelKv = await openChannelRegistry(this.nc, this.space, { create: !this.authed });
      if (watchChannels) await (this.readOnce ? this.readChannelsOnce() : this.startChannelWatch());
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
    if (this.authed && (this.doConsume || this.doRegister))
      this.requireLifecycleUid(this.doConsume ? "an authed consuming endpoint" : "an authed presence-registering endpoint");

    // Consumers bind BEFORE presence publishes: the durable bind is the broker's proof that this
    // incarnation's lifecycle-keyed names match its minted grants, so a wrong-uid launch dies
    // with NO presence ghost instead of advertising an agent that can never receive.
    if (this.doConsume) {
      this.jsm = await jetstreamManager(this.nc);
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
    if (this.doRegister && !this.doConsume && this.authed && this.card.kind === "agent") {
      const jsm = this.jsm ?? (this.jsm = await jetstreamManager(this.nc));
      const uid = this.requireLifecycleUid("an authed presence-registering agent");
      try {
        await jsm.consumers.info(dmStream(this.space), dmDurable(this.owner, this.actor, uid));
      } catch (e) {
        throw new Error(
          `lifecycle proof failed for ${this.card.id} (uid ${uid}): its dm_ durable is not present at the broker, so this incarnation's uid does not match its provisioned resources - refusing to publish presence (SPEC 13.1 fail-before-presence): ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }

    if (this.doRegister) {
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
          `presence registration failed for ${this.card.id}: the space's presence KV bucket "${presenceBucket(this.space)}" did not accept this endpoint's first write (${detail}). The bucket can be OPENED and WATCHED while refusing every write, so a healthy-looking connection does not rule this out; a broker whose store has latched refuses until it is restarted, and no client can clear it (#1356).`,
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
        const next = nextHeartbeat(phase, this.heartbeatMs, beat, Date.now());
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
    for (const plane of this.livenessResponders.keys()) this.bindLiveness(plane);
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
    if (this.stopped) return;
    this.emit("connection", { connected: true });
    if (this.nc) {
      for (const follower of this.activeGoalFollowers) {
        follower.reconnected(this.nc);
      }
    }
  }

  /** Tear down everything {@link connectAndBind} (re)creates, so a rebind can't leak a
   *  second heartbeat, double-pump a consumer, or keep stale roster ghosts. Caller-owned
   *  subs (tap/serve) are left alone — they aren't rebuilt here. */
  clearConnectionScoped(): void {
    if (this.authExpiryReconnectTimer) {
      clearTimeout(this.authExpiryReconnectTimer);
      this.authExpiryReconnectTimer = undefined;
    }
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
    this.presenceEpoch++;
    this.presence.cancelRebind();
    this.presence.retireWatch();
    if (this.channelWatchIter) this.retireKvWatch(this.channelWatchIter);
    this.channelWatchIter = undefined;
    this.stopDeliveryLeaseWatch();
    for (const sub of this.chatSubs.values()) {
      try {
        sub.unsubscribe();
      } catch {
        /* already closed with the connection */
      }
    }
    this.chatSubs.clear();
    this.chatSubDenied.clear();
    this.ownWatchDeletePrefixes.clear();
    this.presence.resetConnection();
    this.channelConfigs.clear();
    this.channelDefaults = {};
    // A read in flight on the old connection must not land in the new connection's cache.
    this.channelRead = undefined;
    this.channelReadGeneration++;
    this.channelReadApplied = this.channelReadGeneration;
    for (const watch of this.membershipFeedWatches)
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
    const failedNc = this.nc;
    if (failedNc) this.disableLibraryReconnect(failedNc);
    this.clearConnectionScoped();
    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    this.kv = undefined;
    this.channelKv = undefined;
    this.membersKv = undefined;
    this.aclKv = undefined;
    this.membershipFeedKv = undefined;
    this.deliveryLease.resetConnection();
    this.managerLeaseKv = undefined;
    this.daemonRenewalLeaseRevision = undefined;
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
    for (const sub of this.subs) {
      try { sub.unsubscribe(); } catch { /* dead with the old connection */ }
    }
    this.subs.length = 0;
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
    if (!this.stopped) return false;
    const nc = this.nc;
    if (nc) this.disableLibraryReconnect(nc);
    this.clearConnectionScoped();
    await this.closeWithoutLibraryReconnect(nc);
    this.nc = undefined;
    return true;
  }

  async stopOnce(): Promise<void> {
    if (this.nc) this.disableLibraryReconnect(this.nc);
    this.stopped = true;
    for (const follower of this.activeGoalFollowers) {
      follower.cancel();
    }
    this.activeGoalFollowers.clear();
    this.presenceEpoch++;
    // Every principal serve ends now, so a `ready` still waiting for the broker rejects and no new
    // request is taken. Its handlers in flight finish below, before the connection they reply on
    // closes, or their requests' deadlines pass.
    const principalStops = [...this.principalServes.values()].map((intent) => this.stopPrincipalServe(intent, false));
    this.presence.cancelRebind();
    // Wake a reestablishLoop sitting in backoff so it sees `stopped` and exits instead of
    // sleeping out retryMs; also clears the timer so it can't fire later.
    this.kickBackoff();
    for (const wake of [...this.membershipPauses]) wake();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.cancelBearerRenewal?.();
    if (this.credsTimer) clearTimeout(this.credsTimer);
    if (this.authExpiryReconnectTimer) clearTimeout(this.authExpiryReconnectTimer);
    for (const watch of this.membershipFeedWatches) {
      watch.stopped = true;
      watch.arm = watch.arm.catch(() => {}).then(async () => {
        await this.disarmMembershipWatch(watch);
        await this.deleteRetainedMembershipConsumer(watch);
      });
    }
    // Permanent endpoint shutdown has no future epoch. Try strict cleanup on the current live epoch;
    // if the broker is already gone, terminate local ownership rather than hanging shutdown forever.
    await Promise.all([...this.membershipFeedWatches].map((watch) => watch.arm.catch((err) => {
      if (this.nc && !this.nc.isClosed()) throw err;
    })));
    for (const watch of this.membershipFeedWatches) {
      watch.resolveStop?.();
      watch.resolveStop = undefined;
      watch.rejectStop = undefined;
    }
    this.membershipFeedWatches.clear();
    for (const msgs of this.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed */
      }
    }
    this.presence.retireWatch();
    if (this.channelWatchIter) this.retireKvWatch(this.channelWatchIter);
    this.channelWatchIter = undefined;
    this.stopDeliveryLeaseWatch();
    await Promise.all(principalStops);
    try {
      if (this.doRegister) {
        await this.presence.publishOffline();
      }
    } catch {
      /* best-effort graceful leave */
    }
    await Promise.all([this.settleDeliveryLeaseWatches(), this.settleKvWatches()]);
    // DM-only: the pull above is stopped, so no new copy reaches the handler. Let a running handler
    // settle while the connection is still open, so its ack can reach the broker; close either way.
    let dmOnlyUnsettled = false;
    if (this.dmOnly && this.dmOnlyInFlight) {
      const settleMs = this.dmOnly.settleTimeoutMs ?? 30_000;
      dmOnlyUnsettled = await withDeadline(this.dmOnlyInFlight.then(() => false), settleMs, () => new Error("unsettled"))
        .catch(() => true);
    }
    await this.closeWithoutLibraryReconnect(this.nc);
    // #1356: stop() does its own teardown and never runs clearConnectionScoped, so clear here too —
    // AFTER the best-effort offline publish above, which would otherwise re-record a refusal on its
    // way out. A stopped endpoint has no live basis for "this bucket is refusing writes", and the
    // duration is computed from `Date.now()`, so a retained record does not merely go stale: it keeps
    // COUNTING UP for as long as the dead object is held.
    this.clearPresenceWriteFailure();
    // Custody callers must not observe stop completion while a concurrent rebind can still
    // publish a late consuming connection. doRebuild closes its stopped epoch before resolving.
    await this.rebuildPromise;
    await this.startPromise;
    if ([...this.ownedConnections].some((nc) => !nc.isClosed()))
      throw new Error("endpoint stop could not prove its connection closed; local consumer custody must be retained");
    if (dmOnlyUnsettled)
      throw new Error(`endpoint stop closed the connection but the DM-only handler did not settle within ${this.dmOnly?.settleTimeoutMs ?? 30_000}ms; its copy stays unacked and handler custody must be retained`);
  }

  /** The native binding of every connection this endpoint holds. A host compares the list with a
   *  complete native census of the account to show that no other connection uses it. The list
   *  proves neither liveness nor the absence of other connections. A stopped endpoint whose
   *  connections all closed reports none. It throws while there is no settled answer: before
   *  start, during a start, rebuild or stop, while a credential transaction or its connection swap
   *  is pending, and while the connection is down or redialing. */
  nativeConnections(): NativeConnectionBinding[] {
    const unsettled = (why: string) => new Error(`endpoint connection inventory is unsettled: ${why}`);
    if (this.startPromise !== undefined || this.rebuildPromise !== undefined || this.reconnecting)
      throw unsettled("a start or rebuild is in flight");
    const open = [...this.ownedConnections].filter((nc) => !nc.isClosed());
    if (this.stopped) {
      if (open.length > 0) throw unsettled("the endpoint stopped but a connection has not closed");
      return [];
    }
    if (this.credsTxnsRunning > 0 || this.residentSwap !== undefined)
      throw unsettled("a credential adoption is in flight");
    if (!this.nc || !this.nativeBound) throw unsettled("the connection is down or redialing");
    return open.map((nc) => nativeConnectionBinding(nc, "endpoint connection"));
  }
}
