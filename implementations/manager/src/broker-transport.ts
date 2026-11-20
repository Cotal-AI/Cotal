import { bindIssuedStores, DEFAULT_SERVER, DEV_OWNER, dialerFor, drainAndClose, ensureAuthorityStores, epAuthBucket, inspectCredHealth, mintCreds, newIdentity, principalKey, recordsBucket, rejectionText, standaloneConnectOpts } from "@cotal-ai/core";
import type { CotalEndpoint, EpServeHandle, IssuanceSeam, IssuedStore, LifecycleStateTransport } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { remoteStandingTimeLeft } from "./credential-renewal.js";
import { withScopedEndpoint } from "./endpoint-evict.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import { withTimeout } from "./manager-timeout.js";
import type { Manager } from "./manager.js";
import { appendStaticCredentialRow, recordSlotCredential, staticLifecycleTransport } from "./static-lifecycle.js";

/** One issuance window: the issued-authority stores, and the version of the nats-server the
 *  window's connection reached, which a mint carrying an exclusion must name (SPEC §9). */
export interface IssuerWindow {
  store: IssuedStore;
  accepted: KV;
  brokerVersion: string | undefined;
}

/** What {@link BrokerTransport} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface BrokerTransportDeps {
  auth: () => Manager["auth"];
  endpointServeExecutorExpiresInSeconds: () => Manager["endpointServeExecutorExpiresInSeconds"];
  leaseStopping: () => Manager["leaseStopping"];
  managerInstanceId: () => Manager["managerInstanceId"];
  remoteAuthority: () => Manager["remoteAuthority"];
  remoteBundleAdoption: () => Manager["remoteBundleAdoption"];
  remoteExecutorCreds: () => Manager["remoteExecutorCreds"];
  servers: () => Manager["servers"];
  space: () => Manager["space"];
  transportDown: () => Manager["transportDown"];
  renewRemoteExecutor: (...args: Parameters<Manager["renewRemoteExecutor"]>) => ReturnType<Manager["renewRemoteExecutor"]>;
  renewRemoteStandingBundle: (...args: Parameters<Manager["renewRemoteStandingBundle"]>) => ReturnType<Manager["renewRemoteStandingBundle"]>;
  /** `Manager.dial`, for the dials this component makes itself, so a test that replaces the Manager's
   *  `dial` still intercepts them (as it did before these bodies left manager.ts). */
  dialViaManager: (opts: Parameters<ReturnType<typeof dialerFor>>[0]) => Promise<NatsConnection>;
}

/** Builds the {@link BrokerTransportDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function brokerTransportDeps(m: Manager): BrokerTransportDeps {
  return {
    auth: () => m["auth"],
    endpointServeExecutorExpiresInSeconds: () => m["endpointServeExecutorExpiresInSeconds"],
    leaseStopping: () => m["leaseStopping"],
    managerInstanceId: () => m["managerInstanceId"],
    remoteAuthority: () => m["remoteAuthority"],
    remoteBundleAdoption: () => m["remoteBundleAdoption"],
    remoteExecutorCreds: () => m["remoteExecutorCreds"],
    servers: () => m["servers"],
    space: () => m["space"],
    transportDown: () => m["transportDown"],
    renewRemoteExecutor: (...args) => m["renewRemoteExecutor"](...args),
    renewRemoteStandingBundle: (...args) => m["renewRemoteStandingBundle"](...args),
    dialViaManager: (opts) => m["dial"](opts),
  };
}

/** Dialing the broker, tracking and retiring connections, and the scoped one-shot executor connections the manager's writes ride. */
export class BrokerTransport {
  constructor(private readonly deps: BrokerTransportDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get auth() { return this.deps.auth(); }
  private get endpointServeExecutorExpiresInSeconds() { return this.deps.endpointServeExecutorExpiresInSeconds(); }
  private get leaseStopping() { return this.deps.leaseStopping(); }
  private get managerInstanceId() { return this.deps.managerInstanceId(); }
  private get remoteAuthority() { return this.deps.remoteAuthority(); }
  private get remoteBundleAdoption() { return this.deps.remoteBundleAdoption(); }
  private get remoteExecutorCreds() { return this.deps.remoteExecutorCreds(); }
  private get servers() { return this.deps.servers(); }
  private get space() { return this.deps.space(); }
  private get transportDown() { return this.deps.transportDown(); }
  private renewRemoteExecutor(...args: Parameters<Manager["renewRemoteExecutor"]>): ReturnType<Manager["renewRemoteExecutor"]> { return this.deps.renewRemoteExecutor(...args); }
  private renewRemoteStandingBundle(...args: Parameters<Manager["renewRemoteStandingBundle"]>): ReturnType<Manager["renewRemoteStandingBundle"]> { return this.deps.renewRemoteStandingBundle(...args); }

  /** Every broker dial this manager makes, through ONE transport decision.
   *
   *  `this.servers` is whatever the mesh record held (`cotal supervise` reads it from there), so it
   *  can be a `ws://`/`wss://` broker published through an HTTPS edge. The raw node transport
   *  refuses such a URL instead of dialing it, so the scheme picks the dialer here rather than at
   *  thirteen call sites. `dialerFor` also owns the websocket transport's options, which is why
   *  callers below still pass their own auth options unchanged. */
  dial(opts: Parameters<ReturnType<typeof dialerFor>>[0]): Promise<NatsConnection> {
    const servers = this.servers ?? DEFAULT_SERVER;
    return dialerFor(servers)({ ...opts, servers });
  }

  /** Initial NATS timeout is per dial, not per server list. Keep the aggregate deadline too, and
   * close a late result rather than letting an abandoned preflight or recovery install a transport. */
  async dialRemoteStanding(opts: Parameters<ReturnType<typeof dialerFor>>[0], deadline: number): Promise<NatsConnection> {
    const ms = remoteStandingTimeLeft(deadline);
    const pending = this.deps.dialViaManager({ ...opts, timeout: ms });
    try {
      const nc = await withTimeout(pending, ms, "remote manager standing dial exceeded its 10000ms aggregate budget");
      remoteStandingTimeLeft(deadline);
      if (this.leaseStopping) throw new Error("manager stopped while a remote standing dial was in flight");
      return nc;
    } catch (e) {
      // Timing out our wait does not cancel connect(). It still owns its socket until it rejects
      // or returns a connection, which must close without serving or changing a current holder.
      void pending.then((nc) => nc.close(), () => {}).catch((error) => console.error(`! remote manager abandoned standing dial cleanup: ${rejectionText(error)}`));
      throw e;
    }
  }

  /** Retire a dedicated connection on stop: drain it while its transport is up, close it while the
   *  client is reconnecting it. A drain on a reconnecting connection does not fail, it waits for the
   *  reconnect, so the stop would last as long as the outage; a broker this connection cannot reach
   *  has nothing left to flush. `flush` (the serve loop's own drain) runs only while the transport is
   *  up. Best-effort, so a graceful stop completes its remaining teardown even when the broker is gone. */
  async retireConnection(nc: NatsConnection, flush?: () => Promise<unknown>): Promise<void> {
    if (this.transportDown.has(nc)) {
      try { await nc.close(); } catch { /* best effort */ }
      return;
    }
    if (flush) try { await flush(); } catch { /* best effort */ }
    try { await drainAndClose(nc); } catch { /* best effort */ }
  }

  /** A failed candidate must not extend preparation by draining subscriptions on a stalled socket.
   * Close only that candidate first. Native stop still owns any already-dispatched handlers, whose
   * outcomes remain unknown to callers and must not be replayed; they do not hold family adoption. */
  async discardServeCandidate(nc: NatsConnection, handle?: EpServeHandle): Promise<void> {
    await nc.close();
    if (handle) void handle.stop().catch((e) => console.error(`! remote manager discarded serve candidate cleanup: ${rejectionText(e)}`));
  }

  /** Track a dedicated connection's transport into {@link transportDown} from the first moment:
   *  nats.js reports `disconnect` when the socket drops and `reconnect` only after it has re-sent the
   *  connection's subscriptions. If the status stream itself fails, the transport can no longer be
   *  observed, so it counts as down. */
  trackTransport(nc: NatsConnection): void {
    void (async () => {
      for await (const st of nc.status()) {
        if (st.type === "disconnect") this.transportDown.add(nc);
        else if (st.type === "reconnect") this.transportDown.delete(nc);
      }
    })().catch(() => this.transportDown.add(nc));
  }

  /** Run one static §13.1 lifecycle OPERATION over an ephemeral, key-pinned `lifecycle-executor`
   *  connection: the credential's grants name exactly ONE incarnation's head/uid/gate/
   *  cred-family/slot keys, so the write authority exists only for this operation's window and
   *  can move nothing else. The transport is the direct-KV binding the shared core saga drives. */
  async withLifecycleExecutor<T>(
    pin: { owner: string; actor: string; lifecycleUid: string; alias: string },
    fn: (t: LifecycleStateTransport) => Promise<T>,
  ): Promise<T> {
    if (!this.auth) throw new Error("withLifecycleExecutor: no space auth (an open mesh has no lifecycle registry)");
    const identity = newIdentity();
    const creds = await mintCreds(this.auth, identity, "lifecycle-executor", {
      lifecycleExecutor: { owner: pin.owner, actor: pin.actor, lifecycleUid: pin.lifecycleUid, alias: pin.alias },
    });
    const nc = await this.deps.dialViaManager({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      const recordsKv = await kvm.open(recordsBucket(this.space));
      const authKv = await kvm.open(epAuthBucket(this.space));
      return await fn(staticLifecycleTransport(recordsKv, authKv));
    } finally {
      await drainAndClose(nc);
    }
  }

  /** Run one SPEC 13.15 issuance operation over an ephemeral `issuer` connection: the evidence
   *  stage/release of one mint, or the retirement walk of one lifecycle's issuances. The store
   *  handle and the accepted-row KV live only for this window; the standing supervisor holds no
   *  grant on either bucket. */
  async withIssuer<T>(fn: (i: IssuerWindow) => Promise<T>): Promise<T> {
    if (!this.auth) throw new Error("withIssuer: no space auth (an open mesh issues nothing)");
    const creds = await mintCreds(this.auth, newIdentity(), "issuer");
    const nc = await this.deps.dialViaManager({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      return await fn({ ...await bindIssuedStores(kvm, await jetstreamManager(nc), this.space), brokerVersion: nc.info?.version });
    } finally {
      await drainAndClose(nc);
    }
  }

  /** The issuance seam of ONE static credential mint (SPEC 13.15): the evidence is bound to the
   *  incarnation's own `cred.<uid>` ledger family, so the family's revocation (the static
   *  terminal) retires every issuance that named it. The finalizer is the §13.1 ledger append
   *  (slot credentialId + `cred.<uid>.<credId>` row); release runs it, then activates. */
  issuanceSeam(i: { store: IssuedStore; accepted: KV }, mode: "issue" | "renew", a: { name: string; id: string; lifecycleUid: string }, exp: number): IssuanceSeam {
    return {
      mode,
      store: i.store,
      accepted: i.accepted,
      sources: mode === "issue" ? [{ space: this.space, bucket: epAuthBucket(this.space), key: `cred.${a.lifecycleUid}` }] : [],
      finalize: async (credentialId) => {
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: a.id, lifecycleUid: a.lifecycleUid, alias: a.name }, async (t) => {
          await recordSlotCredential(t, DEV_OWNER, a.name, a.lifecycleUid, credentialId);
          await appendStaticCredentialRow(t, { lifecycleUid: a.lifecycleUid, credentialId, holderPrincipal: principalKey(DEV_OWNER, a.id).key, exp });
        });
      },
    };
  }

  /** Run one §13.1 endpoint-instance maintenance operation over an ephemeral,
   *  key-pinned `endpoint-serve-executor` connection: the credential's grants name exactly the
   *  manager instance's `epgate`/`epcred` keys plus its registration's two records keys, so the
   *  gate CAS, mint fence, spec/governance writes, and clean deregistration ride a one-shot scoped
   *  authority. The remote boot goal-index sweep instead uses the authenticated host-owned scan.
   *  This is NEVER the manager's standing seed/supervisor connection. */
  async withEndpointServeExecutor<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    const identity = this.remoteAuthority?.identities.executor ?? newIdentity();
    if (this.remoteAuthority && (!this.remoteExecutorCreds || inspectCredHealth(this.remoteExecutorCreds).state !== "healthy")) {
      // Shutdown has drained and discarded the standing serve context. Renew only its scoped
      // maintenance executor through the existing host operation; never resurrect standing duties.
      if (this.leaseStopping) await this.renewRemoteExecutor(true);
      else if (this.remoteAuthority.renewStandingBundle) {
        // The renewal drains old handlers after adopting. A handler waiting here must be
        // released at adoption, not after its own completion is required by that drain.
        const renewal = this.renewRemoteStandingBundle(true);
        void renewal.catch((error) => console.error(`! remote manager standing renewal completion: ${rejectionText(error)}`));
        await this.remoteBundleAdoption;
        if (!this.remoteExecutorCreds || inspectCredHealth(this.remoteExecutorCreds).state !== "healthy") {
          await renewal;
          throw new Error("standing renewal did not adopt a healthy scoped executor");
        }
      } else await this.renewRemoteExecutor(true);
    }
    const creds = this.remoteExecutorCreds ?? (this.auth
      ? await mintCreds(this.auth, identity, "endpoint-serve-executor", {
          endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId },
          ...(this.endpointServeExecutorExpiresInSeconds !== undefined
            ? { expiresInSeconds: this.endpointServeExecutorExpiresInSeconds }
            : {}),
        })
      : undefined);
    if (!creds) throw new Error("withEndpointServeExecutor: no scoped executor authority (an open mesh must use the bare path)");
    const nc = await this.deps.dialViaManager({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      return await fn({ recordsKv: await kvm.open(recordsBucket(this.space)), authKv: await kvm.open(epAuthBucket(this.space)), nc });
    } finally {
      await drainAndClose(nc);
    }
  }

  /** The open-mesh counterpart of {@link withEndpointServeExecutor}: an OPEN mesh has no
   *  credential system, so there is no scoped executor to mint - the same §13.1 gate/records
   *  writes ride a bare one-shot connection (the broker enforces nothing on an open mesh; the
   *  ceremony still produces the real gate, epoch, and registration the serve rails run on). */
  async withOpenServeConnection<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    if (this.auth || this.remoteAuthority)
      throw new Error("withOpenServeConnection: an authenticated mesh must use the scoped endpoint-serve executor");
    const nc = await this.deps.dialViaManager({ maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      // An open mesh may be a RAW broker (no `cotal up` provisioning ran), and `Kvm.open` binds
      // lazily without checking the stream exists — create-or-verify the §13.12 authority stores
      // first (the same mode-neutral treatment {@link registerManagerService} gives the contract
      // store), or the first gate write dies "stream not found".
      await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
      return await fn({ recordsKv: await kvm.open(recordsBucket(this.space)), authKv: await kvm.open(epAuthBucket(this.space)), nc });
    } finally {
      await drainAndClose(nc);
    }
  }

  /** Open a short-lived PROVISIONER connection, run the onboarding ops on it, and drain it (closure (ii),
   *  residual 2). The DM/DLV consumer-create surface — the irreducible onboarding power — lives only for
   *  this window, never as a standing grant on the long-lived supervisor. A provision-only endpoint
   *  (no presence/consume/channel-watch) connected with memory-only `provisioner` creds; it sets its own
   *  `inboxPrefix` so JS-API replies land on the `_INBOX_<id>.>` the provisioner cred subscribes. */
  async withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T> {
    if (!this.auth) throw new Error("withProvisioner: no space auth (an open mesh has no scoped creds)");
    // Onboarding runs several provisioning ops, so it keeps the provisioner profile's five-minute window.
    return withScopedEndpoint({ space: this.space, servers: this.servers ?? DEFAULT_SERVER, auth: this.auth }, "provisioner", "provisioner", fn, 5 * 60);
  }

  /** A connection holding this instance's transfer reader grants (docs/design/resume-transfer.md
   *  section 6) for this one receive or sweep: minted from the space's signing seed, or issued by the
   *  host to a remote manager. An open mesh enforces no grants, so a bare one-shot connection is that
   *  reader there. */
  async withTransferReader<T>(fn: (nc: NatsConnection) => Promise<T>): Promise<T> {
    const issue = this.remoteAuthority?.mintTransferReader;
    if (this.remoteAuthority && !issue) throw new Error("withTransferReader: this manager's remote authority issues no transfer reader");
    const identity = newIdentity();
    const creds = issue
      ? await issue(identity)
      : this.auth && await mintCreds(this.auth, identity, "transfer-reader", { transferReader: { instanceId: this.managerInstanceId } });
    const nc = await this.deps.dialViaManager(creds
      ? { ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 }
      : { maxReconnectAttempts: 0 });
    try {
      return await fn(nc);
    } finally {
      await drainAndClose(nc);
    }
  }
}
