import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  DEFAULT_SERVER, DEV_OWNER, mintCreds, newIdentity, principalKey, inspectCredHealth,
  standaloneConnectOpts, serveEndpoint, drainAndClose, createEndpointStreams,
  contractStoreContext, publishContractArtifact, contractArtifactCanonicalBytes,
  provisionEndpointGateOpen, endpointRegistrationBarrier, serveIssuanceGateKv,
  readEndpointGateGeneration, registerServingInstance, mintLifecycleUid, rejectionText,
  commitSiblingIssuance, credentialIdOf, newArtifactSigner, RotatingSigner,
  generationAnchor, sessionsBucket, SESSION_GRANT_MAX_TTL_MS, epgateKey,
  markLedgerRowRevoked, epcredRowKey,
  type Identity, type SpaceAuth, type EpServeGrant, type EpServeHandle, type EpCommandDef,
  type ServiceNameAuthority, type dialerFor,
} from "@cotal-ai/core";
import { claimManagerSiblingIdentities } from "@cotal-ai/workspace";
import { servedConnectorStatuses } from "./connector-inventory.js";
import { DELIVERY_ADMIN_BOOT_WAIT_MS, makeManagerEndpointHolderEvictor } from "./endpoint-evict.js";
import { MANAGER_ENDPOINT, managerClusterArtifacts, managerContractArtifactValues, type ManagerConnectorStatus } from "./manager-service-contract.js";
import { ManagerSessionPlane, openSessionLedgerKv, type SessionServing } from "./session/index.js";
import type { ManagerOptions } from "./manager.js";
import type { Manager } from "./manager.js";
import type { ManagerParts } from "./manager-parts.js";
import { caughtEnvelope } from "./turn-relay.js";
import { lifecycleBlocked, lifecycleBlockedFrom } from "@cotal-ai/core";
import { REMOTE_STANDING_BUDGET_MS, remoteStandingTimeLeft } from "./credential-renewal.js";
import { withTimeout } from "./manager-timeout.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";

/** The serve connection's ping, the same as every agent connection's (CotalEndpoint's default), so a
 *  Manager and its agents judge one outage alike: every 10 s, stale after 2 unanswered. */
const SERVE_PING_INTERVAL_MS = 10_000;
const SERVE_MAX_PING_OUT = 2;

type ServiceServe = { handle: EpServeHandle; nc: NatsConnection; identity: Identity; grant: EpServeGrant; creds?: string };
type SessionLedgerConnection = { nc: NatsConnection; creds?: string };
type ExecutorStores = { recordsKv: KV; authKv: KV; nc: NatsConnection };

/** Why a frozen manager gate stays frozen on an open mesh. Reconciliation must prove the holder
 *  gone, and an open mesh runs no delivery daemon to prove it, so neither boot self-heal nor
 *  `cotal manager reconcile` can reopen the gate there. */
const OPEN_MESH_GATE_LIMIT = "reconciliation needs liveness evidence an open mesh cannot currently provide, so `cotal manager reconcile` refuses this gate. Keep this store intact; upgrading alone does not recover it";

/** The open mesh's registration evictor. An open mesh has no eviction oracle, so the superseded
 *  family's holders stay unverified as they do with no evictor, and the barrier keeps the gate
 *  frozen. Throwing instead of answering `false` only puts the reason in the refusal. */
function openMeshUnverifiedEviction(holders: readonly string[]): never {
  throw new Error(`principal(s) ${holders.map((h) => `"${h}"`).join(", ")} not verified evicted: ${OPEN_MESH_GATE_LIMIT}`);
}

/** An open-mesh registration refused by a gate another registration froze, restated without the
 *  `cotal reconcile-gate` remedy that cannot run there. Code, gate state, blocked op and op id are
 *  kept. Any other failure is returned as it is. */
function openMeshFrozenGateRefusal(e: unknown, instanceId: string): unknown {
  const envelope = caughtEnvelope(e);
  const blocked = lifecycleBlockedFrom(envelope);
  if (envelope === undefined || blocked?.gateState !== "frozen" || blocked.blockedOp !== "registration") return e;
  return lifecycleBlocked(envelope.code, `the issuance gate for "${instanceId}" is frozen under another registration, and this manager cannot register while it is; ${OPEN_MESH_GATE_LIMIT} (SPEC 13.8)`,
    { blockedOp: blocked.blockedOp, gateState: blocked.gateState, ...(blocked.opId !== undefined ? { opId: blocked.opId } : {}) }, envelope.outcome);
}

/** Current manager authority and shared renewal state, read when an operation runs. */
export interface ServePlaneDeps {
  managerServeIdentity(): Identity;
  leaseStopping(): boolean;
  remoteStandingBudgetMs: number;
  dial: (opts: Parameters<ReturnType<typeof dialerFor>>[0]) => Promise<NatsConnection>;
  dialRemoteStanding: (opts: Parameters<ReturnType<typeof dialerFor>>[0], deadline: number) => Promise<NatsConnection>;
  managerServiceDefs: () => EpCommandDef[];
  omitClassCommands: () => readonly string[] | undefined;
  resolveTarget: (target: { owner: string; actor: string }) => { lifecycleUid: string; mappingRevision: number } | undefined;
  withEndpointServeExecutor: <T>(fn: (kvs: ExecutorStores) => Promise<T>) => Promise<T>;
  withOpenServeConnection: <T>(fn: (kvs: ExecutorStores) => Promise<T>) => Promise<T>;
  boundedReconnect: (label: string, attempt: () => Promise<boolean>, expired?: boolean) => Promise<boolean>;
  renewRemoteBeforeRedial: (label: string, read: () => string | undefined) => Promise<void>;
  stop: () => Promise<void>;
  healFrozenRegistrationGate: (authKv: KV, instanceId: string, auth: SpaceAuth, recordsKv: KV) => Promise<void>;
  mintAndStageGoalWriter: (authKv: KV) => Promise<string>;
  retireConnection: (nc: NatsConnection) => Promise<void>;
  withTimeout: <T>(task: Promise<T>, ms: number, message: string) => Promise<T>;
  remoteStandingTimeLeft: (deadline: number) => number;
  openMeshUnverifiedEviction: (holders: readonly string[]) => never;
  openMeshFrozenGateRefusal: (error: unknown, instanceId: string) => unknown;
}

/** Builds the {@link ServePlaneDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function servePlaneDeps(m: Manager): ServePlaneDeps {
  return {
    managerServeIdentity: () => m["managerServeIdentity"],
    leaseStopping: () => m["leaseStopping"],
    remoteStandingBudgetMs: REMOTE_STANDING_BUDGET_MS,
    dial: (...args) => m["dial"](...args),
    dialRemoteStanding: (...args) => m["dialRemoteStanding"](...args),
    managerServiceDefs: (...args) => m["managerServiceDefs"](...args),
    omitClassCommands: (...args) => m["omitClassCommands"](...args),
    resolveTarget: (target) => m["resolveServeTarget"](target),
    withEndpointServeExecutor: (...args) => m["withEndpointServeExecutor"](...args),
    withOpenServeConnection: (...args) => m["withOpenServeConnection"](...args),
    boundedReconnect: (...args) => m["boundedReconnect"](...args),
    renewRemoteBeforeRedial: (...args) => m["renewRemoteBeforeRedial"](...args),
    stop: (...args) => m["stop"](...args),
    healFrozenRegistrationGate: (...args) => m["healFrozenRegistrationGate"](...args),
    mintAndStageGoalWriter: (...args) => m["mintAndStageGoalWriter"](...args),
    retireConnection: (...args) => m["retireConnection"](...args),
    withTimeout,
    remoteStandingTimeLeft,
    openMeshUnverifiedEviction,
    openMeshFrozenGateRefusal,
  };
}

/** Registers and recovers the manager control service and its dedicated session authority. */
export class ServePlane {
  /** Maps credentialId → the nkey that credential was minted for, for the live per-session
   *  SERVING credentials. The §13.1 ledger row records the holder principal, and the row is written
   *  at stage time (after the mint), so the two steps need this one hop. Entries are dropped at
   *  revoke; a session that never staged drops its entry when the manager exits. */
  private readonly sessionServingKeys = new Map<string, string>();

  /** The manager's ONE §13.6 session plane — offer mint + one-use redeem + PTY-bridge
   *  standup for `attach`. The face's establisher and the CLI attach handler both call THIS one
   *  plane; the manager never constructs a second. Undefined until {@link startSessionPlane}. */
  sessionPlane?: ManagerSessionPlane;
  /** The standing session-LEDGER connection + its mutable creds holder (the authenticator
   *  presents the refreshed cred on the next reconnect after a half-TTL renewal — the goal-writer
   *  precedent). Auth mode only; an open mesh runs the plane over a bare connection. */
  sessionLedgerConn?: SessionLedgerConnection;
  /** Renews the session signing key long before its window closes. A key that expires unattended
   *  takes the whole session plane down until the manager is restarted, which kills live sessions. */
  sessionKeyRenewTimer?: ReturnType<typeof setInterval>;
  /** The STABLE session-LEDGER identity (auth mode) — minted once at registration
   *  alongside the serve + goal-writer identities; a renewal re-mints the SAME nkey with a fresh
   *  bounded exp and re-stages its distinct credId into the §13.1 revocation family. The current
   *  credential is minted INSIDE {@link registerManagerService}'s run block and stashed here. */
  sessionLedgerIdentity?: Identity;
  /** The manager's v0.4 service-endpoint serve state — the serve handle +
   *  its dedicated connection, the STABLE serve identity (renewals re-mint the same nkey), the
   *  branded serve grant, and the CURRENT credential (the connection's authenticator reads it on
   *  every (re)connect, so a renewal is adopted without re-registration). Absent on open meshes,
   *  in user mode, and before registration completes. */
  serviceServe?: ServiceServe;
  sessionLedgerCreds?: string;

  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: ServePlaneDeps, private readonly parts: Pick<ManagerParts, "brokerTransport" | "connectorInventory" | "credentialRenewal" | "goalWriter">, private readonly state: ManagerStartState) {}

  private get auth(): SpaceAuth | undefined { return this.state.auth; }
  private get remoteAuthority(): Pick<NonNullable<ManagerOptions["remoteAuthority"]>, "identities" | "goalWriterCreds" | "sessionLedgerCreds" | "serveCreds" | "serveGrant" | "mintSessionServing"> | undefined { return this.config.remoteAuthority; }
  private get managerInstanceId(): string { return this.state.managerInstanceId!; }
  private get managerServeIdentity(): Identity { return this.deps.managerServeIdentity(); }
  private get leaseStopping(): boolean { return this.deps.leaseStopping(); }
  /** The connector rows a status read serves (see {@link servedConnectorStatuses}), after refreshing the inventory. */
  private get connectorStatuses(): readonly ManagerConnectorStatus[] {
    const inventory = this.parts.connectorInventory;
    inventory.refreshConnectors();
    return servedConnectorStatuses(inventory.connectorStatuses);
  }

  /** #2073: dial the manager's ONE control-plane connection and serve its typed command surface on
   *  it. Shared by the
   *  initial registration AND the closed-connection recovery path ({@link onServeConnectionClosed}),
   *  so there is one place that dials and serves this endpoint. Attaches {@link
   *  onServeConnectionClosed} as the close handler in both cases: a closed serve connection is
   *  always a fault this manager acts on, never a bare log line. */
  async dialServeConnection(
    state: { nc: NatsConnection; identity: Identity; grant: EpServeGrant; creds?: string },
    readCreds: () => string = () => state.creds!,
    deadline?: number,
  ): Promise<{ nc: NatsConnection; handle: EpServeHandle }> {
    const opts = {
      // Open mesh: a bare serve connection (no credential exists; the broker enforces nothing).
      ...(state.creds !== undefined ? standaloneConnectOpts({ creds: readCreds, tls: false }) : {}),
      inboxPrefix: `_INBOX_${state.identity.id}`,
      maxReconnectAttempts: -1,
      // A silent network loss resets no socket, so only pings find it, and the liveness grade above
      // reads this transport. At the nats.js default (120 s, 2 outstanding) a computer that lost its
      // network reported its Manager connected for minutes; this calls the link stale within 30 s.
      pingInterval: SERVE_PING_INTERVAL_MS,
      maxPingOut: SERVE_MAX_PING_OUT,
    };
    const nc = await (deadline === undefined ? this.deps.dial(opts) : this.deps.dialRemoteStanding(opts, deadline));
    this.parts.brokerTransport.trackTransport(nc);
    let handle: EpServeHandle | undefined;
    try {
      // The typed surface + the derived `describe`. The descriptor stays PUBLIC in static
      // mode: the broker grant (who holds each command's request-publish row) is the
      // load-bearing authority tier, and a static single-operator mesh leaks nothing by listing
      // command names; the trusted per-caller `view(caller)` scoping joins the user-mode
      // registration follow-up (where actorScope is the trusted source). Every ordinary handler
      // runs the SHARED admission chokepoint ({@link serveGated}).
      handle = this.serveOnConnection(nc, state.grant);
      // A subscribed replacement must be visible to the broker before the old rails retire.
      if (deadline === undefined) await nc.flush();
      else await this.deps.withTimeout(nc.flush(), this.deps.remoteStandingTimeLeft(deadline),
        "remote manager standing serve flush exceeded its 10000ms aggregate budget");
    } catch (e) {
      await this.parts.brokerTransport.discardServeCandidate(nc, handle);
      throw e;
    }
    // Wired only once the connection serves: a candidate this method closes after a
    // refused serve is not a fault to recover, and the caller already sees the refusal.
    nc.closed().then((err) => {
      if (this.serviceServe?.nc === nc) void this.onServeConnectionClosed(err ?? undefined, nc);
    });
    return { nc, handle };
  }

  private serveOnConnection(nc: NatsConnection, grant: EpServeGrant): EpServeHandle {
    return serveEndpoint(nc, this.config.space, grant, this.deps.managerServiceDefs(), { public: true }, {
      resolveTarget: (t) => this.deps.resolveTarget(t),
      omitClassCommands: this.deps.omitClassCommands(),
    });
  }

  /** Update the class spawn rails when application availability crosses zero, without redialing. */
  syncClassSpawn(): void {
    const serving = this.serviceServe;
    if (!serving || this.leaseStopping) return;
    const replacement = this.serveOnConnection(serving.nc, serving.grant);
    // Reusing the incarnation queues keeps overlap single-delivery. Do not await the old
    // handlers here: the status or launch that changed availability can be one of them.
    let draining: Promise<void> | undefined = serving.handle.stop();
    void draining.finally(() => { draining = undefined; });
    serving.handle = { stop: async () => { await Promise.all([replacement.stop(), draining]); } };
  }

  /** #2073: re-mint the SAME `endpoint-serve` identity through the SAME scoped one-shot executor and
   *  §13.1 mint fence `renewDaemonCreds`'s serve branch uses - never a second copy of that mint. Used
   *  by both the periodic renewal pass and the closed-connection recovery path below, so a
   *  superseded instance's re-mint fails the SAME gate CAS in both places and lands in the exit
   *  path rather than needing a second epoch check. */
  async remintServeCreds(s: { identity: Identity; grant: EpServeGrant }): Promise<string> {
    const authRef = this.auth!;
    return this.deps.withEndpointServeExecutor(({ authKv }) =>
      mintCreds(authRef, s.identity, "endpoint-serve", {
        serveIssuance: serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId }),
        endpointServe: s.grant,
      }));
  }

  /** #2073: a closed serve connection is a FAULT the manager acts on, not a log line: this is the
   *  control plane a report showed staying dead for hours while the process kept its liveness
   *  lease and answered nothing (#2073). `stop()` sets `leaseStopping` BEFORE it tears down this
   *  connection, so a close landing from OUR OWN graceful teardown returns here at once. Any other
   *  close re-dials with the current credential (a transport blip needs nothing new), re-mints
   *  through the existing serve branch when the credential itself has expired, and re-serves on the
   *  new connection - bounded by {@link STATIC_RECONCILE_RETRY_DELAYS_MS}. Exhausting every attempt
   *  releases this process's lease and exits loud (without `withAgents`, so seats stay up, the path
   *  `supervise`'s signal handler already uses) so a restart can serve: a manager that holds the
   *  lease and answers nothing is the worst of the three states this issue named, and holding the
   *  connection open under unbounded reconnects (the transport-drop case) never reaches this method
   *  at all - `nc.closed()` does not resolve until the client itself gives up. */
  async onServeConnectionClosed(err: Error | undefined, closed: NatsConnection): Promise<void> {
    if (this.leaseStopping) return;
    const s = this.serviceServe;
    console.error(`! manager service endpoint connection closed: ${err?.message ?? "unknown reason"}`);
    const recovered = await this.deps.boundedReconnect("service endpoint", async () => {
      if (!s) return false;
      const deadline = this.remoteAuthority ? performance.now() + this.deps.remoteStandingBudgetMs : undefined;
      // Let an admitted renewal finish owning its candidate before recovery opens another.
      if (deadline === undefined) await this.parts.credentialRenewal.remoteBundleRenewal;
      else await this.deps.withTimeout(Promise.resolve(this.parts.credentialRenewal.remoteBundleRenewal), this.deps.remoteStandingTimeLeft(deadline),
        "remote manager closed-serve renewal wait exceeded its 10000ms aggregate budget");
      if (this.leaseStopping || this.serviceServe !== s || s.nc !== closed) return true;
      if (deadline !== undefined) await this.deps.withTimeout(this.deps.renewRemoteBeforeRedial("serve", () => s.creds), this.deps.remoteStandingTimeLeft(deadline),
        "remote manager closed-serve renewal wait exceeded its 10000ms aggregate budget");
      else if (inspectCredHealth(s.creds ?? "").state !== "healthy" && s.creds !== undefined) {
        s.creds = await this.remintServeCreds(s);
        this.parts.credentialRenewal.scheduleServeRenewal(s.creds);
      }
      if (this.leaseStopping || this.serviceServe !== s || s.nc !== closed) return true;
      const { nc, handle } = await this.dialServeConnection(s, undefined, deadline);
      if (this.leaseStopping || this.serviceServe !== s || s.nc !== closed) {
        try { await handle.stop(); } finally { await nc.close(); }
        return true;
      }
      s.nc = nc;
      s.handle = handle;
      console.error(`manager service endpoint re-dialed: ${MANAGER_ENDPOINT}/${this.managerInstanceId} (epoch ${s.grant.epoch})`);
      return true;
    });
    if (this.leaseStopping || recovered) return;
    console.error(
      `! manager service endpoint could not be restored for ${this.config.space}/${MANAGER_ENDPOINT}/${this.managerInstanceId}: releasing the lease and exiting`,
    );
    await this.deps.stop();
    process.exit(1);
  }

  /** Register the manager as an ordinary v0.4 `service` endpoint and serve its typed
   *  command surface on the ep rails - the manager's ONLY control door. On an AUTH mesh
   *  the whole credential path is the SAME one an ordinary endpoint traverses (the enforcement
   *  test that keeps "ordinary" honest): provision the §13.1 issuance gate, drive the
   *  registration BARRIER's gate CAS, then release the serve credential only on the mint FENCE's
   *  revision-pinned CAS win - all over the scoped one-shot executor ({@link
   *  withEndpointServeExecutor}), never a seed-signed shortcut. Holding the signing seed only
   *  AUTHORIZES the reserved single-label name (`manager`, operator name authority, DEV_OWNER).
   *  On an OPEN mesh the same gate/registration/serve-grant ceremony runs over bare one-shot
   *  connections and NO credential is ever minted: there is no credential system to issue from,
   *  so the gate legitimately keeps an empty `epcred` family (the §13.1 fence is issuance-only)
   *  and the serve connection is bare - the broker enforces nothing on an open mesh, exactly the
   *  old open-mesh ctl trust ("open = single-trusted-host"). */
  async registerManagerService(): Promise<void> {
    const auth = this.auth;
    if (this.remoteAuthority) {
      const remote = this.remoteAuthority;
      this.parts.goalWriter.goalWriterIdentity = remote.identities.goalWriter;
      this.sessionLedgerIdentity = remote.identities.sessionLedger;
      this.parts.goalWriter.goalWriterCreds = remote.goalWriterCreds;
      this.sessionLedgerCreds = remote.sessionLedgerCreds;
      const state = {
        handle: undefined as unknown as EpServeHandle,
        nc: undefined as unknown as NatsConnection,
        identity: remote.identities.serve,
        grant: remote.serveGrant,
        creds: remote.serveCreds,
      };
      // The shared dialer wires the closed-connection handler, which re-dials through the all-duty family.
      const { nc, handle } = await this.dialServeConnection(state);
      state.handle = handle;
      state.nc = nc;
      this.serviceServe = state;
      console.error(`remote manager service endpoint activated: ${MANAGER_ENDPOINT}/${this.managerInstanceId} (epoch ${state.grant.epoch})`);
      return;
    }
    // The §13.7 contract store is REGISTRATION's dependency, ensured here MODE-NEUTRALLY:
    // it used to ride the static-only lifecycle reconcile, so a USER-mode manager registered
    // against an absent stream and its artifact publish died no-responders (live-repro'd). A
    // provisioner one-shot creates-or-verifies it (config-B immutability incl. the shadowed-legacy
    // refuse) before the executor publishes a single artifact.
    {
      // Open mesh: the bare connection holds the rights (there is no credential system to mint from).
      const provCreds = auth ? await mintCreds(auth, newIdentity(), "provisioner") : undefined;
      const provNc = await this.deps.dial({ ...standaloneConnectOpts({ creds: provCreds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
      try {
        // The manager now WRITES goal facts (EPF) + progress events (EPE), so the §13.12
        // endpoint streams must exist. Nothing provisioned them before spawn-as-action (no endpoint
        // wrote to EPF/EPE), so the manager ensures the full set here over the provisioner (whose
        // STREAM.CREATE now covers them), idempotently - createEndpointStreams is a superset of
        // ensureContractStore + ensureAuthorityStores, fail-loud on drift. Auth + open both run this.
        await createEndpointStreams(await jetstreamManager(provNc), new Kvm(provNc), this.config.space);
      } finally {
        await drainAndClose(provNc);
      }
    }
    const iid = this.managerInstanceId;
    const artifacts = managerClusterArtifacts();
    // In-memory §13.7 content store: the manager is this document's AUTHOR, so registration and
    // serve authorization verify against the exact artifacts it publishes from memory. The DURABLE
    // `epc` contract-store publication (for third-party digest fetches) runs below inside the same
    // executor, BEFORE the registration that advertises the digests.
    const store = new Map<string, unknown>([
      [artifacts.rootDigest, artifacts.document],
      [artifacts.closureDigest, artifacts.manifest],
    ]);
    const readClusterArtifact = (digest: string): unknown => store.get(digest);
    // §13.9 name authority, static mode: `manager` is a core single-label name requiring OPERATOR
    // authority - the manager holds the space signing seed, so it self-authorizes exactly its own
    // name for exactly DEV_OWNER (never a general authority; any other (name, owner) refuses).
    const authority: ServiceNameAuthority = {
      authorize: (name, owner) => ({ authorized: name === MANAGER_ENDPOINT && owner === DEV_OWNER, revision: 0 }),
    };
    // The STABLE serve identity: the PERSISTED serve nkey, reused across restart so the
    // gate binds the SAME principal (§13.1 serving-principal binding) - provisionEndpointGateOpen
    // stays idempotent and verified eviction has a stable target. Renewals re-mint the same nkey
    // with a fresh bounded exp; a restart re-provisions the same (idempotent) gate + re-registers.
    const serveIdentity = this.managerServeIdentity;
    const servePrincipal = principalKey(DEV_OWNER, serveIdentity.id).key;
    // An open mesh mints no credentials, so it has no family for a fresh pair to grow.
    const siblings = auth ? claimManagerSiblingIdentities(this.config.workspaceRoot, this.config.space) : { goalWriter: newIdentity(), sessionLedger: newIdentity() };
    // The STABLE goal-writer identity - a SIBLING credential in the same §13.1 family
    // (not the gate's bound serving principal), so the run block can family-stage it.
    this.parts.goalWriter.goalWriterIdentity = siblings.goalWriter;
    // The STABLE session-LEDGER identity - another SIBLING in the SAME §13.1 family, so
    // the takeover barrier revokes a deposed manager's ledger cred alongside its goal-writer. The
    // per-session serving creds join the same family, each with its own fresh identity.
    this.sessionLedgerIdentity = siblings.sessionLedger;
    // One registration operation for this boot. Fresh executors may replace a dead connection, but
    // they must resume THIS freeze rather than minting a new op that discards Phase-2 progress.
    const registrationOpId = mintLifecycleUid();
    const executorExpired = (e: unknown): boolean => /closed connection/i.test(rejectionText(e));
    const retryExpiredExecutor = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      for (;;) {
        try {
          return await fn();
        } catch (e) {
          if (!executorExpired(e)) throw e;
          console.error(`manager ${label} executor expired; retrying${label === "registration" ? ` operation ${registrationOpId}` : ""} with fresh scoped authority`);
        }
      }
    };
    const publishAndProvision = async (
      { authKv, nc: execNc }: { recordsKv: KV; authKv: KV; nc: NatsConnection },
    ) => {
      // §13.7 contract-artifact publication: every schema root + its closure manifest, plus
      // the cluster document + ITS manifest, land in the EPC store BEFORE the registration that
      // advertises their digests - so a caller can always fetch-verify-compile a registered
      // digest (the generic-invoke read path). Create-only + content-addressed: a retry
      // or a same-artifact republish is an idempotent lost-CAS. The registration itself still
      // verifies against the in-memory copies (the manager is the author).
      const storeCtx = await contractStoreContext(execNc, this.config.space);
      for (const value of [...managerContractArtifactValues(), artifacts.document, artifacts.manifest])
        await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
      // §13.1 pre-registration: the issuance gate, born open@gen0 bound to the serve
      // principal - provisioned ONCE, on the FIRST registration. On a RESTART the gate
      // already EXISTS (advanced past gen0 by the prior registration), so re-provisioning the gen0
      // row would conflict "foreign content"; the persisted instanceId makes this a TAKEOVER, and
      // registerServiceInstance below freezes + re-registers the EXISTING gate (advancing the epoch
      // after it verify-evicts the superseded family). The serve principal is the SAME persisted one,
      // so the gate's principal binding is unchanged either way.
      if ((await serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid }).observe()) === null)
        await provisionEndpointGateOpen(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: iid, principal: servePrincipal });
    };
    const completeRegistration = async (
      { recordsKv, authKv, nc: execNc }: { recordsKv: KV; authKv: KV; nc: NatsConnection },
    ) => {
      await publishAndProvision({ recordsKv, authKv, nc: execNc });
      // On an AUTH mesh a RE-registration (restart of the persisted instanceId)
      // must VERIFY-EVICT the superseded serve family BEFORE the epoch advances (§13.1 "old authority
      // dies before new authority is visible"). Inject the SCOPED delivery-admin evictor; the OPEN
      // mesh mints no serve family, so its empty-family restart never consults an evictor, and one
      // an earlier release staged there stays unverified with the reason in the refusal
      // ({@link openMeshUnverifiedEviction}). NO-ORACLE = LOUD: with no reachable delivery daemon the
      // evictor THROWS naming the cure, so PHASE 2 fails closed with the delivery-daemon fix in the
      // error text - a crash-restart never silently skips eviction (no-fallbacks).
      const barrier = endpointRegistrationBarrier(authKv, this.config.space, {
        endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: registrationOpId,
        evict: auth ? makeManagerEndpointHolderEvictor({ space: this.config.space, servers: this.config.servers ?? DEFAULT_SERVER, auth, log: (line) => console.error(line), unreachableWaitMs: DELIVERY_ADMIN_BOOT_WAIT_MS }) : this.deps.openMeshUnverifiedEviction,
      });
      const spec = { endpoint: MANAGER_ENDPOINT, owner: DEV_OWNER, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 as const } };
      const { grant } = await registerServingInstance(recordsKv, {
        space: this.config.space, spec, instanceId: iid, registrant: { owner: DEV_OWNER }, authority, barrier, readClusterArtifact,
        // #1393: when a FOREIGN instance holds the endpoint governance slot, let core tell an
        // in-flight registration from one abandoned by a predecessor that died between its
        // slot-take and its spec publish. The read rides THIS executor's existing auth-bucket read
        // grant (no new grant, no new writer); core refuses on anything but a gate provably
        // reopened past the slot's stamp.
        observeHolderGeneration: (holderInstanceId) =>
          readEndpointGateGeneration(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: holderInstanceId }),
        status: { connectors: [...this.connectorStatuses] },
      });
      const fence = serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
      // Open mesh: NO mint - the §13.1 fence is issuance-only and nothing is ever issued, so the
      // gate keeps an empty `epcred` family; the serve connection below stays bare.
      const creds = auth ? await mintCreds(auth, serveIdentity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant }) : undefined;
      // Mint + family-stage the goal-writer credential HERE, over this executor's
      // authKv (the fence is live), so its credId lands in `epcred.<e>.<iid>` and the takeover
      // barrier revokes it. Open mesh: no mint (no credential system; the goal-writer conn is bare).
      const goalWriterCreds = auth ? await this.deps.mintAndStageGoalWriter(authKv) : undefined;
      // Mint + family-stage the session-LEDGER credential HERE too (same executor, same
      // fence, same §13.1 family), so takeover revokes a deposed manager's ledger connection. The
      // per-session SERVING credentials are minted later, one per redemption, into the SAME family.
      // Open mesh: no mint (no credential system; the ledger connection stays bare).
      const sessionLedgerCreds = auth ? await this.mintAndStageSessionLedger(authKv) : undefined;
      return { grant, creds, goalWriterCreds, sessionLedgerCreds };
    };
    let registration;
    if (auth) {
      // Boot heal may consume an arbitrarily large prior family. End that executor window here and
      // mint fresh scoped authority for the new registration, rather than forcing heal + takeover
      // through one fixed-lifetime connection. A closed connection during heal retries the SAME
      // frozen predecessor op via reconcile's durable cursor; a closed connection during
      // registration retries THIS boot's operationId without heal, so Phase-2 progress stays bound.
      // #783/#871: a predecessor that died mid-barrier leaves this gate frozen under a
      // registration op. registerServiceInstance will then refuse SPEC 13.8 forever, even
      // when the freeze-holder is gone. Complete that SAME op (abort-reopen) on independent
      // holder-gone evidence BEFORE this incarnation freezes a new one. Auth only: the
      // CONNZ oracle rides delivery-admin, which an open mesh does not have.
      await retryExpiredExecutor("boot-heal", () => this.deps.withEndpointServeExecutor(async ({ recordsKv, authKv, nc: execNc }) => {
        await publishAndProvision({ recordsKv, authKv, nc: execNc });
        if (auth) {
          await this.deps.healFrozenRegistrationGate(authKv, iid, auth, recordsKv);
        }
      }));
      registration = await retryExpiredExecutor("registration", () => this.deps.withEndpointServeExecutor(completeRegistration));
    } else {
      registration = await this.deps.withOpenServeConnection(completeRegistration).catch((e: unknown) => { throw this.deps.openMeshFrozenGateRefusal(e, iid); });
    }
    if (!registration) throw new Error("manager registration produced no serve authority");
    const { grant, creds, goalWriterCreds, sessionLedgerCreds } = registration;
    this.parts.goalWriter.goalWriterCreds = goalWriterCreds;
    this.sessionLedgerCreds = sessionLedgerCreds;
    // The serve connection presents the CURRENT credential on every (re)connect (the state object
    // is captured by the authenticator), so a fence-traversing renewal is adopted by reconnect
    // without re-registration. Reconnects stay unbounded: the serve rails are this instance's
    // registered surface for its whole incarnation.
    const state = { handle: undefined as unknown as EpServeHandle, nc: undefined as unknown as NatsConnection, identity: serveIdentity, grant, creds };
    const { nc, handle } = await this.dialServeConnection(state);
    state.nc = nc;
    state.handle = handle;
    this.serviceServe = state;
    console.error(`manager service endpoint registered: ${MANAGER_ENDPOINT}/${iid} (epoch ${grant.epoch}, registrationRevision ${grant.registrationRevision})`);
    // #2073: arm the serve credential's own renewal now, from ITS window, instead of leaving it to
    // `credRenewTimer`'s boot-phased TTL/4 tick. Open mesh mints no credential (`creds` is
    // undefined) and has nothing to schedule.
    if (state.creds !== undefined) this.parts.credentialRenewal.scheduleServeRenewal(state.creds);
  }

  /** Mint the standing `session-ledger` credential and STAGE it into this instance's
   *  §13.1 revocation family (`epcred.<e>.<iid>`), over the passed executor's `authKv`, following the
   *  {@link mintAndStageGoalWriter} pattern under the same open-and-commit fence.
   *
   *  This credential carries the DEDICATED sessions-bucket ledger rows and no session rail at all.
   *  It therefore takes no epoch pin: §13.6 makes it the durable revocation authority that must
   *  outlive the serving endpoint, so scoping it to one serving epoch would defeat its purpose. The
   *  epoch lives where it belongs, on the per-session serving credentials, which are minted per
   *  redemption into this same family. Because `mintCreds` stamps a random `issuance:` tag on
   *  `session-ledger` (`userTags`), re-minting the SAME nkey on renewal or restart signs distinct
   *  bytes and stages a distinct ledger row (per-JWT `credentialId` digest) even within one
   *  second. */
  async mintAndStageSessionLedger(authKv: KV): Promise<string> {
    const auth = this.auth!;
    const identity = this.sessionLedgerIdentity!;
    // Registration instanceId (the persisted logical id), not the per-process lifecycleUid:
    // the barrier enumerates `epcred.<e>.<managerInstanceId>`, so the ledger cred joins that family.
    const iid = this.managerInstanceId;
    const fence = serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
    const observed = await fence.observe();
    if (observed === null)
      throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${iid} vanished; the session-ledger cred cannot join its §13.1 revocation family`);
    const creds = await mintCreds(auth, identity, "session-ledger");
    const exp = inspectCredHealth(creds).exp;
    if (exp === undefined)
      throw new Error(`the session-ledger credential for ${MANAGER_ENDPOINT}/${iid} is unbounded; the §13.1 ledger row requires an expiry`);
    // The §13.1 open-and-commit fence (see {@link mintAndStageGoalWriter}): stage + revision-pinned
    // commit against the gate this mint's grant was scoped from, releasing only on the win.
    await commitSiblingIssuance(fence, observed, {
      credentialId: credentialIdOf(creds),
      credentialKey: identity.id,
      holderPrincipal: principalKey(DEV_OWNER, identity.id).key,
      endpoint: MANAGER_ENDPOINT, lifecycleUid: iid, sourceChain: ["root"], state: "active", exp,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    });
    return creds;
  }

  /** #2073: dial the session-ledger's ONE standing connection - shared by the initial start and the
   *  closed-connection recovery ({@link onSessionLedgerConnectionClosed}), the same shape {@link
   *  dialGoalWriter} uses for its rail. The KV/JetStream clients the session plane opened from the
   *  connection at start stay bound to it for this incarnation's life; a redial refreshes the
   *  standing authenticator connection the credential renewal presents onto (mirroring `sw.creds`),
   *  which is what a closed-connection fault on this rail needs restored. */
  async dialSessionLedgerConnection(
    sw: { nc: NatsConnection; creds?: string }, identity: Identity,
  ): Promise<void> {
    const nc = await this.deps.dial({
      ...((this.auth || this.remoteAuthority) ? standaloneConnectOpts({ creds: () => sw.creds!, tls: false }) : {}),
      inboxPrefix: `_INBOX_${identity.id}`,
      maxReconnectAttempts: -1,
    });
    nc.closed().then((err) => { void this.onSessionLedgerConnectionClosed(err ?? undefined); });
    this.parts.brokerTransport.trackTransport(nc);
    sw.nc = nc;
  }

  /** #2073: the session-ledger rail's closed-connection fault, the same bounded shape {@link
   *  onGoalWriterConnectionClosed} uses: re-dial with the current credential, re-mint through the
   *  existing session-ledger renewal branch when the credential itself has expired, then re-attach.
   *  Exhaustion logs and leaves the credential to the next renewal pass; it never exits the process
   *  (brief step 4: only the serve rail is the control plane the report lost). */
  async onSessionLedgerConnectionClosed(err: Error | undefined): Promise<void> {
    if (this.leaseStopping) return;
    console.error(`! manager session-ledger connection closed: ${err?.message ?? "unknown reason"}`);
    const sw = this.sessionLedgerConn;
    const identity = this.sessionLedgerIdentity;
    const recovered = await this.deps.boundedReconnect("session-ledger", async () => {
      if (!sw || !identity) return false;
      if (this.remoteAuthority) await this.deps.renewRemoteBeforeRedial("session-ledger", () => sw.creds);
      else if (sw.creds !== undefined && inspectCredHealth(sw.creds).state !== "healthy") {
        sw.creds = await this.deps.withEndpointServeExecutor(({ authKv }) => this.mintAndStageSessionLedger(authKv));
        this.sessionLedgerCreds = sw.creds;
      }
      await this.dialSessionLedgerConnection(sw, identity);
      console.error("manager session-ledger re-dialed");
      return true;
    }, inspectCredHealth(sw?.creds ?? "").state === "expired");
    if (this.leaseStopping || recovered) return;
    console.error("! manager session-ledger could not be re-dialed; leaving the credential to the next renewal pass");
  }

  /** Stand up the ONE §13.6 session plane on its own standing connection. Mode-dual,
   *  mirroring {@link startGoalWriter}: an AUTH mesh presents the scoped `session-ledger` cred
   *  already minted + family-staged inside registration's run block ({@link mintAndStageSessionLedger});
   *  an OPEN mesh uses a bare connection (no credential system to mint from). The connection presents
   *  the CURRENT credential on every (re)connect, so a half-TTL renewal is adopted without reconnecting.
   *
   *  The offer SIGNER is a per-incarnation in-memory keypair: the static collapsed path mints AND
   *  redeems the offer in one call ({@link ManagerSessionPlane.establishAttach}), so the manager
   *  self-signs and self-verifies its own §13.6 grants and the keypair never leaves the process - a
   *  holder never verifies the signature (it presents the grant back over the rail; the broker's
   *  per-session caller cred is the holder's real fence). The plane's ledger lives in the DEDICATED
   *  sessions bucket (createEndpointStreams provisioned it at registration). */
  async startSessionPlane(): Promise<void> {
    const identity = (this.auth || this.remoteAuthority) ? this.sessionLedgerIdentity! : newIdentity();
    // The mutable holder captured by the authenticator (mirrors the goal-writer): a half-TTL renewal
    // updates `sw.creds` and the next (re)connect presents the refreshed credential.
    const sw: { nc: NatsConnection; creds?: string } =
      { nc: undefined as unknown as NatsConnection, creds: (this.auth || this.remoteAuthority) ? this.sessionLedgerCreds : undefined };
    await this.dialSessionLedgerConnection(sw, identity);
    const nc = sw.nc;
    const serveEpoch = this.serviceServe?.grant.epoch;
    if (serveEpoch === undefined)
      throw new Error("the manager session plane needs the serve grant epoch; registerManagerService must run first");
    const ledgerKv = await openSessionLedgerKv(nc, sessionsBucket(this.config.space));
    // The session signing key ROTATES. It used to be minted once here with a flat 24h window and
    // handed back frozen forever, so a manager that stayed up past 24h lost its session plane
    // permanently: every attach failed closed with "outside its validity window", and the only
    // recovery was restarting the manager, which kills every live session. It happened three times
    // in one day. Failing closed on an expired key is correct (SPEC 13.10); the defect was that
    // nothing ever renewed the key, so the correct refusal became permanent.
    //
    // Renewal is driven from two places on purpose - a timer below, and opportunistically before
    // each signature. A timer alone stops if the loop is starved or the host suspends; an
    // opportunistic check alone never fires on an idle plane that must sign after a long quiet
    // period. Expiry now requires both to fail at once.
    const rotating = new RotatingSigner((seq, now) => {
      const kp = newArtifactSigner();
      const keyId = seq === 0
        ? `mgr-sessions-${identity.id.slice(0, 12)}`
        : `mgr-sessions-${identity.id.slice(0, 12)}-g${seq}`;
      return {
        keyId,
        keyPair: kp,
        anchor: generationAnchor({
          keyId, publicKey: kp.publicKey, owner: MANAGER_ENDPOINT, roles: ["sessions"],
          scope: { sessions: [MANAGER_ENDPOINT] }, now, ttlMs: SESSION_GRANT_MAX_TTL_MS,
        }),
      };
    }, Date.now());
    this.sessionPlane = new ManagerSessionPlane({
      space: this.config.space,
      // The session's serving identity is the persisted REGISTRATION instanceId, not the
      // per-process lifecycleUid: a restarted manager re-registers the SAME logical instanceId with
      // an ADVANCED epoch, so a client re-attaches by the same instance while the epoch fences the
      // old incarnation's sessions.
      serving: { instanceId: this.managerInstanceId, epoch: serveEpoch },
      // Read through the rotator on EVERY use rather than capturing a key: signing takes the newest
      // generation, and resolution accepts any generation still inside its overlap so an artifact
      // signed a moment before a swap is not orphaned a moment after it.
      signer: {
        get keyId() { rotating.maybeRenew(Date.now()); return rotating.current().keyId; },
        keyPair: { sign: (input: Uint8Array) => rotating.current().keyPair.sign(input) },
      },
      resolveAnchor: (id) => rotating.resolve(id),
      ledgerKv, ttlMs: SESSION_GRANT_MAX_TTL_MS,
      servingCredential: this.sessionServingCredentials(),
      ...(this.config.maxSessions !== undefined ? { maxSessions: this.config.maxSessions } : {}),
    });
    this.sessionLedgerConn = sw;
    // The belt to the signing path's braces: renew on a timer as well, so a plane that sits idle
    // for longer than a window still holds a live key when work finally arrives. Checked well
    // inside the renewal margin, unref'd so it never holds the process open.
    const renewTimer = setInterval(() => {
      const rotated = rotating.maybeRenew(Date.now());
      if (rotated)
        console.error(
          `manager session signing key rotated to ${rotated} (previous generations stay verifiable ` +
            `through their overlap; a key is never allowed to expire unattended)`,
        );
    }, 15 * 60 * 1000);
    renewTimer.unref?.();
    this.sessionKeyRenewTimer = renewTimer;
    console.error(`manager session plane standing (endpoint ${MANAGER_ENDPOINT}, epoch ${serveEpoch}, ${(this.auth || this.remoteAuthority) ? "scoped session-ledger cred, §13.1 family-staged" : "open/bare"})`);
  }

  /**
   * The per-session SERVING credential seam (SPEC 13.6): the manager mints, gate-stages,
   * connects and revokes ONE credential per live session, replacing a standing credential that held
   * `eps.manager.*.<epoch>.{in,out}` and so reached every live session's bytes at its epoch.
   *
   * Each session gets its OWN nkey identity, so the §13.1 barrier's evict-by-holderPrincipal reaches
   * it individually, and each is staged into `epcred.manager.<instanceId>` - the SAME family the
   * ledger and goal-writer creds join. That is how manager takeover still kills a deposed manager's
   * sessions: the barrier enumerates the family, revokes every row, and evicts every holder, so the
   * per-session creds die with the incarnation exactly as the standing one did, with the blast
   * radius of a leaked credential cut from "every session at this epoch" to "one dead session".
   *
   * OPEN MESH: no credential system exists to mint from, so the seam mints nothing and opens a bare
   * connection. That is not a degraded auth path - an open mesh has no broker enforcement at all -
   * and it is still per-session: the connection and the ledger row are still one-per-session, so
   * teardown behaves identically in both modes.
   */
  sessionServingCredentials(): SessionServing {
    const iid = this.managerInstanceId;
    const gate = async <T>(fn: (authKv: KV) => Promise<T>): Promise<T> =>
      this.deps.withEndpointServeExecutor(({ authKv }) => fn(authKv));
    return {
      mint: async (grant) => {
        // Open mesh: no auth to mint from. The id still names the session so the ledger row and the
        // teardown path are identical in both modes.
        if (this.remoteAuthority) {
          const identity = newIdentity();
          const creds = await this.remoteAuthority.mintSessionServing({
            identity,
            endpoint: grant.endpoint,
            sessionId: grant.sessionId,
            epoch: grant.serving.epoch,
            exp: Math.floor(grant.exp / 1000),
          });
          const id = credentialIdOf(creds);
          this.sessionServingKeys.set(id, identity.id);
          return { id, creds, exp: grant.exp };
        }
        if (!this.auth) return { id: `${grant.sessionId}.s`, creds: "", exp: grant.exp };
        const identity = newIdentity();
        const creds = await mintCreds(this.auth, identity, "session-serving", {
          sessionServing: { endpoint: grant.endpoint, sessionId: grant.sessionId, epoch: grant.serving.epoch },
          expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms; the JWT exp is seconds
        });
        const health = inspectCredHealth(creds);
        if (health.exp === undefined)
          throw new Error(`the session-serving credential for ${grant.sessionId} is unbounded; a per-session credential never outlives its session (SPEC 13.6)`);
        const id = credentialIdOf(creds);
        this.sessionServingKeys.set(id, identity.id);
        return { id, creds, exp: grant.exp };
      },
      observeGate: async (_endpoint, instanceId) => {
        // Open mesh: nothing is minted and nothing is staged, so there is no gate to pin (see
        // ServingGatePin.gate - the stage refuses loudly if this is ever missing on an auth mesh).
        if (!this.auth && !this.remoteAuthority) return { key: epgateKey(MANAGER_ENDPOINT, instanceId), revision: 0 };
        return gate(async (authKv) => {
          const observed = await serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId }).observe();
          if (observed === null)
            throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${instanceId} vanished; a session credential never stages against a missing gate (SPEC 13.1)`);
          // The WHOLE observation rides the pin: the stage's fence compares every field of it, which
          // is what lets a lost CAS be classified rather than blanket-refused.
          return { key: epgateKey(MANAGER_ENDPOINT, instanceId), revision: observed.revision, gate: observed };
        });
      },
      stage: async (grant, cred, pin) => {
        if (!this.auth && !this.remoteAuthority) return; // open mesh: nothing minted, so nothing to make revocable
        const key = this.sessionServingKeys.get(cred.id);
        if (key === undefined)
          throw new Error(`no minted identity for session credential ${cred.id}; the stage cannot record a holder it did not mint (SPEC 13.1)`);
        // THE REDEMPTION'S OWN PIN IS THE FENCE, and it is never re-read into something newer here:
        // `commitSiblingIssuance` CASes on this observation's revision and, on a loss, refuses unless
        // the gate is still identical to it in every field but the revision. A barrier
        // (freeze, or reopen at a successor coordinate) is therefore always a refusal, while another
        // session's identical-bytes commit touch is not - per-session credentials all serialize on
        // this one gate key, so refusing on that would fail live sessions for contention rather than
        // for a barrier. A read is never a fence (SPEC 13.1); the pinned CAS is.
        const observed = pin.gate;
        if (observed === undefined)
          throw new Error(`the redemption of session ${grant.sessionId} carries no gate observation for ${MANAGER_ENDPOINT}/${iid}; a session credential never stages unfenced (SPEC 13.1)`);
        await gate(async (authKv) => {
          const fence = serveIssuanceGateKv(authKv, this.config.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
          await commitSiblingIssuance(fence, observed, {
            credentialId: cred.id,
            credentialKey: key,
            holderPrincipal: principalKey(DEV_OWNER, key).key,
            endpoint: MANAGER_ENDPOINT, lifecycleUid: iid,
            // The lineage records that this credential exists because a session was redeemed, so a
            // ledger reader can tell a per-session row from a standing one (SPEC 13.6 sourceChain).
            sourceChain: [`session.${grant.sessionId}`], state: "active",
            exp: Math.floor(cred.exp / 1000),
            generation: observed.generation, processEpoch: observed.processEpoch,
            registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
          });
        });
      },
      open: async (cred) => {
        // FAIL LOUD: there is deliberately no shared connection to fall back to. Serving a session
        // without its own credential is exactly the standing-writer shape this design removes.
        const opts = (this.auth || this.remoteAuthority) ? standaloneConnectOpts({ creds: cred.creds, /* not yet wired to a recorded transport */ tls: false }) : {};
        return this.deps.dial({ ...opts, maxReconnectAttempts: -1 });
      },
      revoke: async (credentialId) => {
        if (!this.auth && !this.remoteAuthority) return; // open mesh: nothing was minted
        await gate(async (authKv) => {
          await markLedgerRowRevoked(authKv, epcredRowKey(MANAGER_ENDPOINT, iid, credentialId));
        });
        this.sessionServingKeys.delete(credentialId);
      },
    };
  }

  /** Tear the session plane down (best-effort, both exit paths): end every live bridge with the
   *  honest `manager-restart` reason (this incarnation is going away; any successor takes a new epoch
   *  and refuses these grants), then drain each session's own connection and retire the ledger
   *  connection ({@link retireConnection}). */
  async stopSessionPlane(): Promise<void> {
    const plane = this.sessionPlane;
    const sw = this.sessionLedgerConn;
    this.sessionPlane = undefined;
    this.sessionLedgerConn = undefined;
    // `drain` awaits each session's teardown (connection close, terminal row, credential revoke);
    // `endAll` alone would let the process exit with per-session connections still open.
    try { await plane?.drain("manager-restart"); } catch { /* best effort */ }
    if (sw) await this.deps.retireConnection(sw.nc);
  }
}
