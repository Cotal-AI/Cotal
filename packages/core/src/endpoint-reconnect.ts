// The rebuild and retry pacing of CotalEndpoint, as an internal component: the single serialized rebuild,
// its transition onto a fresh connection, the capped retry delay, and the backoff and membership pauses.
// Moved verbatim from endpoint.ts; the endpoint keeps the supervisor and the retry loop and forwards to
// these. Not re-exported by the index.
import type { NatsConnection } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { TransportState } from "./endpoint-options.js";
import type { EndpointDeliveryLease } from "./endpoint-delivery-lease.js";
import type { MembershipFeedWatch } from "./endpoint-subscriptions.js";

/** What the reconnect component reads from its endpoint. State is read when it is used, never copied, a
 *  field it reassigns is written back through its setter, and every method is looked up on the endpoint
 *  at call time, so a member a caller replaced on the endpoint is the one that runs. */
export interface EndpointReconnectDeps {
  rebuildPromise: () => Promise<void> | undefined;
  setRebuildPromise: (value: Promise<void> | undefined) => void;
  nc: () => NatsConnection | undefined;
  setNc: (value: NatsConnection | undefined) => void;
  reconnecting: () => boolean;
  setReconnecting: (value: boolean) => void;
  membershipFeedWatches: () => Set<MembershipFeedWatch>;
  js: () => JetStreamClient | undefined;
  setJs: (value: JetStreamClient | undefined) => void;
  jsm: () => JetStreamManager | undefined;
  setJsm: (value: JetStreamManager | undefined) => void;
  kv: () => KV | undefined;
  setKv: (value: KV | undefined) => void;
  channelKv: () => KV | undefined;
  setChannelKv: (value: KV | undefined) => void;
  membersKv: () => KV | undefined;
  setMembersKv: (value: KV | undefined) => void;
  aclKv: () => KV | undefined;
  setAclKv: (value: KV | undefined) => void;
  membershipFeedKv: () => KV | undefined;
  setMembershipFeedKv: (value: KV | undefined) => void;
  deliveryLease: () => EndpointDeliveryLease;
  managerLeaseKv: () => KV | undefined;
  setManagerLeaseKv: (value: KV | undefined) => void;
  daemonRenewalLeaseRevision: () => number | undefined;
  setDaemonRenewalLeaseRevision: (value: number | undefined) => void;
  stopped: () => boolean;
  retryMs: () => number;
  retryAttempt: () => number;
  setRetryAttempt: (value: number) => void;
  backoffResolve: () => (() => void) | undefined;
  backoffTimer: () => ReturnType<typeof setTimeout> | undefined;
  setBackoffTimer: (value: ReturnType<typeof setTimeout> | undefined) => void;
  membershipPauses: () => Set<() => void>;
  disableLibraryReconnect: (nc: NatsConnection) => void;
  clearConnectionScoped: () => void;
  settleDeliveryLeaseWatches: () => Promise<void>;
  settleKvWatches: () => Promise<void>;
  closeWithoutLibraryReconnect: (nc: NatsConnection | undefined) => Promise<void>;
  connectAndBind: () => Promise<void>;
  tearDownIfStopped: () => Promise<boolean>;
  superviseConnection: () => void;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's rebuild and retry pacing. Internal: `CotalEndpoint` keeps the fields, the supervisor
 *  and the retry loop, and forwards to it. */
export class EndpointReconnect {
  constructor(private readonly deps: EndpointReconnectDeps) {}

  private get rebuildPromise() { return this.deps.rebuildPromise(); }
  private set rebuildPromise(value: Promise<void> | undefined) { this.deps.setRebuildPromise(value); }
  private get nc() { return this.deps.nc(); }
  private set nc(value: NatsConnection | undefined) { this.deps.setNc(value); }
  private get reconnecting() { return this.deps.reconnecting(); }
  private set reconnecting(value: boolean) { this.deps.setReconnecting(value); }
  private get membershipFeedWatches() { return this.deps.membershipFeedWatches(); }
  private get js() { return this.deps.js(); }
  private set js(value: JetStreamClient | undefined) { this.deps.setJs(value); }
  private get jsm() { return this.deps.jsm(); }
  private set jsm(value: JetStreamManager | undefined) { this.deps.setJsm(value); }
  private get kv() { return this.deps.kv(); }
  private set kv(value: KV | undefined) { this.deps.setKv(value); }
  private get channelKv() { return this.deps.channelKv(); }
  private set channelKv(value: KV | undefined) { this.deps.setChannelKv(value); }
  private get membersKv() { return this.deps.membersKv(); }
  private set membersKv(value: KV | undefined) { this.deps.setMembersKv(value); }
  private get aclKv() { return this.deps.aclKv(); }
  private set aclKv(value: KV | undefined) { this.deps.setAclKv(value); }
  private get membershipFeedKv() { return this.deps.membershipFeedKv(); }
  private set membershipFeedKv(value: KV | undefined) { this.deps.setMembershipFeedKv(value); }
  private get deliveryLease() { return this.deps.deliveryLease(); }
  private get managerLeaseKv() { return this.deps.managerLeaseKv(); }
  private set managerLeaseKv(value: KV | undefined) { this.deps.setManagerLeaseKv(value); }
  private get daemonRenewalLeaseRevision() { return this.deps.daemonRenewalLeaseRevision(); }
  private set daemonRenewalLeaseRevision(value: number | undefined) { this.deps.setDaemonRenewalLeaseRevision(value); }
  private get stopped() { return this.deps.stopped(); }
  private get retryMs() { return this.deps.retryMs(); }
  private get retryAttempt() { return this.deps.retryAttempt(); }
  private set retryAttempt(value: number) { this.deps.setRetryAttempt(value); }
  private get backoffResolve() { return this.deps.backoffResolve(); }
  private get backoffTimer() { return this.deps.backoffTimer(); }
  private set backoffTimer(value: ReturnType<typeof setTimeout> | undefined) { this.deps.setBackoffTimer(value); }
  private get membershipPauses() { return this.deps.membershipPauses(); }
  private disableLibraryReconnect(nc: NatsConnection) { void this.deps.disableLibraryReconnect(nc); }
  private clearConnectionScoped() { void this.deps.clearConnectionScoped(); }
  private settleDeliveryLeaseWatches() { return this.deps.settleDeliveryLeaseWatches(); }
  private settleKvWatches() { return this.deps.settleKvWatches(); }
  private closeWithoutLibraryReconnect(nc: NatsConnection | undefined) { return this.deps.closeWithoutLibraryReconnect(nc); }
  private connectAndBind() { return this.deps.connectAndBind(); }
  private tearDownIfStopped() { return this.deps.tearDownIfStopped(); }
  private superviseConnection() { void this.deps.superviseConnection(); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  /** Single serialized rebuild: drain the old connection and rebind via {@link connectAndBind},
   *  guarded so concurrent triggers (manual {@link reconnect}, the supervisor's closed(), the
   *  retry loop) coalesce onto ONE in-flight rebuild instead of racing two connectAndBinds and
   *  leaking a connection. Returns the shared promise; a second caller gets the in-flight one. */
  rebuild(): Promise<void> {
    if (this.rebuildPromise) return this.rebuildPromise;
    const p = this.doRebuild().finally(() => {
      if (this.rebuildPromise === p) this.rebuildPromise = undefined;
    });
    this.rebuildPromise = p;
    return p;
  }

  /** The transition: stop the connection-scoped timers FIRST (so nothing live touches
   *  this.nc during the null window), drop the connection refs, close the old nc, then
   *  rebind + re-arm the supervisor on the fresh connection. clearConnectionScoped is
   *  idempotent, so connectAndBind's own call here is a noop. */
  private async doRebuild(): Promise<void> {
    const oldNc = this.nc;
    if (oldNc) this.disableLibraryReconnect(oldNc);
    this.reconnecting = true;
    try {
      this.clearConnectionScoped();
      // Manual reconnect still has a live old epoch: complete broker-consumer cleanup before close.
      // Terminal self-heal has an already-closed epoch: disarm retains stream/name for fresh cleanup,
      // and the KV watch consumers that closed with it are left to the broker's inactive threshold.
      if (oldNc && !oldNc.isClosed())
        await Promise.all([...[...this.membershipFeedWatches].map((watch) => watch.arm), this.settleDeliveryLeaseWatches(), this.settleKvWatches()]);
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
      this.membershipFeedKv = undefined;
      this.deliveryLease.resetConnection();
      // The manager's liveness-lease handle too: left bound to the old connection, every renew and
      // re-read after a reconnect times out, and the manager reports its lease unknown for good.
      this.managerLeaseKv = undefined;
      this.daemonRenewalLeaseRevision = undefined;
      // This is an application-requested epoch teardown, not a transient nats.js blip. The old
      // status iterator is now stale by construction and its close is epoch-dropped, so this line is
      // the authoritative raw-liveness edge for the no-nc window until the new watcher seeds true.
      this.emit("transport", { connected: false } satisfies TransportState);
      this.emit("connection", { connected: false });
      await this.closeWithoutLibraryReconnect(oldNc);
      // stop() can arrive while the old epoch closes. Do not start another authentication
      // handshake after it: a terminal credential may already have expired in that window.
      // Keep old-epoch and late-epoch close failures outside this dial-only catch.
      if (this.stopped) return;
      try {
        await this.connectAndBind();
      } catch (error) {
        if (!this.stopped) throw error;
      }
      // stop() may have run during the await — don't leave a live connection + heartbeat +
      // supervisor on a stopped endpoint. (Reads this.nc in its own scope — a bare `this.nc`
      // here in doRebuild narrows to `never` via TS inlining connectAndBind's assignment.)
      // Re-arm on the fresh nc only after this stopped fence accepts it.
      if (await this.tearDownIfStopped()) return;
      this.superviseConnection();
    } finally {
      this.reconnecting = false;
    }
  }

  /** The ceiling {@link nextRetryDelayMs} grows to. A failure that outlives a couple of retries is
   *  a standing one (a down broker, a credential nothing can renew), and retrying it every few
   *  seconds forever is what turns one stuck client into a permanent flat load on the broker and its
   *  auth callout. */
  private static readonly RETRY_BACKOFF_CAP_MS = 60_000;

  /** The wait before the next rebuild attempt: {@link retryMs}, doubling per consecutive failure up
   *  to {@link RETRY_BACKOFF_CAP_MS}, then a random half of it taken off. A transient drop still
   *  recovers within retryMs, and endpoints refused together, as a broker restart or an auth limit
   *  refuses a host's agents, spread their retries instead of arriving at the callout at once. */
  nextRetryDelayMs(): number {
    const delay = Math.min(this.retryMs * 2 ** this.retryAttempt, EndpointReconnect.RETRY_BACKOFF_CAP_MS);
    this.retryAttempt++;
    return Math.round(delay / 2 + Math.random() * (delay / 2));
  }

  /** Cut an in-flight reestablish backoff short so the next attempt runs immediately, and
   *  clear its timer so it can't fire later on a stopped/restarted loop. */
  kickBackoff(): void {
    this.backoffResolve?.();
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /** Capped exponential pause between membership retries. stop() ends it early, so a loop waiting
   *  on an absent delivery daemon never holds a stopped endpoint's process open for the delay. */
  membershipPause(attempt: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.membershipPauses.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(30_000, 1000 * 2 ** attempt));
      this.membershipPauses.add(wake);
    });
  }
}
