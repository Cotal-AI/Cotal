// The rebuild and retry pacing of CotalEndpoint, as an internal component: the single serialized rebuild,
// its transition onto a fresh connection, the capped retry delay, and the backoff and membership pauses.
// Moved verbatim from endpoint.ts. It owns the retry attempt count and the backoff, and clears the endpoint's
// ConnectionState around a rebuild; the connection part runs the
// supervisor and the retry loop and calls these. Not re-exported by the index.
import type { LifecycleState } from "./endpoint-lifecycle-state.js";
import type { ConnectionState } from "./endpoint-connection-state.js";
import type { TransportState } from "./endpoint-options.js";
import type { EndpointParts } from "./endpoint-parts.js";

/** What the reconnect component reads from its endpoint. State is read when it is used, never copied, a
 *  field it reassigns is written back through its setter, and every method is looked up on the endpoint
 *  at call time, so a member a caller replaced on the endpoint is the one that runs. A peer part is read
 *  from the parts record at call time. */
export interface EndpointReconnectDeps {
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's rebuild and retry pacing. Internal: it owns the retry count and the backoff, and
 *  `CotalEndpoint` keeps the other shared fields, {@link EndpointConnection} runs the supervisor and the retry loop, and both call it. */
export class EndpointReconnect {
  private readonly retryMs = 3000;
  /** Consecutive failed rebuilds, driving {@link nextRetryDelayMs}. Reset on every success. */
  private retryAttempt = 0;
  /** Interruptible backoff for reestablishLoop — reconnect()/stop() resolves this to retry
   *  now instead of awaiting the full retryMs. */
  private backoffResolve?: () => void;
  private backoffTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly conn: ConnectionState, private readonly lifecycle: LifecycleState, private readonly deps: EndpointReconnectDeps, private readonly parts: Pick<EndpointParts, "connection" | "credentials" | "deliveryLease">) {}

  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  async reconnect(): Promise<void> {
    if (this.lifecycle.stopped) throw new Error("endpoint stopped - cannot reconnect");
    this.kickBackoff();
    try {
      await this.rebuild();
    } catch (e) {
      void this.parts.connection.reestablishLoop(); // background retry until success or stop
      throw e;
    }
  }

  /** Single serialized rebuild: drain the old connection and rebind via {@link EndpointConnection.connectAndBind},
   *  guarded so concurrent triggers (manual {@link reconnect}, the supervisor's closed(), the
   *  retry loop) coalesce onto ONE in-flight rebuild instead of racing two connectAndBinds and
   *  leaking a connection. Returns the shared promise; a second caller gets the in-flight one. */
  rebuild(): Promise<void> {
    if (this.lifecycle.rebuildPromise) return this.lifecycle.rebuildPromise;
    const p = this.doRebuild().finally(() => {
      if (this.lifecycle.rebuildPromise === p) this.lifecycle.rebuildPromise = undefined;
    });
    this.lifecycle.rebuildPromise = p;
    return p;
  }

  /** The transition: stop the connection-scoped timers FIRST (so nothing live touches
   *  this.nc during the null window), drop the connection refs, close the old nc, then
   *  rebind + re-arm the supervisor on the fresh connection. clearConnectionScoped is
   *  idempotent, so connectAndBind's own call here is a noop. */
  private async doRebuild(): Promise<void> {
    const oldNc = this.conn.nc;
    if (oldNc) this.parts.credentials.disableLibraryReconnect(oldNc);
    this.lifecycle.reconnecting = true;
    try {
      this.parts.connection.clearConnectionScoped();
      // Manual reconnect still has a live old epoch: complete broker-consumer cleanup before close.
      // Terminal self-heal has an already-closed epoch: disarm retains stream/name for fresh cleanup,
      // and the KV watch consumers that closed with it are left to the broker's inactive threshold.
      if (oldNc && !oldNc.isClosed())
        await Promise.all([...[...this.conn.membershipFeedWatches].map((watch) => watch.arm), this.parts.deliveryLease.settleDeliveryLeaseWatches(), this.parts.connection.settleKvWatches()]);
      this.conn.nc = undefined;
      this.conn.js = undefined;
      this.conn.jsm = undefined;
      this.conn.kv = undefined;
      this.conn.channelKv = undefined;
      // Plane-3 KV handles are bound to the old connection too — drop them so the daemon re-opens them on
      // the fresh nc (else durableJoin/leave/list, the reader's ACL re-auth, and lease renew use a dead
      // handle after a reconnect).
      this.conn.membersKv = undefined;
      this.conn.aclKv = undefined;
      this.conn.membershipFeedKv = undefined;
      this.parts.deliveryLease.resetConnection();
      // The manager's liveness-lease handle too: left bound to the old connection, every renew and
      // re-read after a reconnect times out, and the manager reports its lease unknown for good.
      this.conn.managerLeaseKv = undefined;
      this.conn.daemonRenewalLeaseRevision = undefined;
      // This is an application-requested epoch teardown, not a transient nats.js blip. The old
      // status iterator is now stale by construction and its close is epoch-dropped, so this line is
      // the authoritative raw-liveness edge for the no-nc window until the new watcher seeds true.
      this.emit("transport", { connected: false } satisfies TransportState);
      this.emit("connection", { connected: false });
      await this.parts.credentials.closeWithoutLibraryReconnect(oldNc);
      // stop() can arrive while the old epoch closes. Do not start another authentication
      // handshake after it: a terminal credential may already have expired in that window.
      // Keep old-epoch and late-epoch close failures outside this dial-only catch.
      if (this.lifecycle.stopped) return;
      try {
        await this.parts.connection.connectAndBind();
      } catch (error) {
        if (!this.lifecycle.stopped) throw error;
      }
      // stop() may have run during the await — don't leave a live connection + heartbeat +
      // supervisor on a stopped endpoint. (Reads this.nc in its own scope — a bare `this.nc`
      // here in doRebuild narrows to `never` via TS inlining connectAndBind's assignment.)
      // Re-arm on the fresh nc only after this stopped fence accepts it.
      if (await this.parts.connection.tearDownIfStopped()) return;
      this.parts.connection.superviseConnection();
    } finally {
      this.lifecycle.reconnecting = false;
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

  /** Wait out one rebuild backoff of `delay` ms; {@link kickBackoff} ends it early. */
  backoff(delay: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.backoffResolve = resolve;
      this.backoffTimer = setTimeout(resolve, delay);
    });
  }

  /** A rebuild succeeded: the next drop starts from {@link retryMs} again. */
  resetRetryDelay(): void {
    this.retryAttempt = 0;
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
    if (this.lifecycle.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.lifecycle.membershipPauses.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(30_000, 1000 * 2 ** attempt));
      this.lifecycle.membershipPauses.add(wake);
    });
  }
}
