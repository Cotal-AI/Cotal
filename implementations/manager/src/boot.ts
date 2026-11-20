import { CotalEndpoint, credsClaims, DEFAULT_SERVER, drainAndClose, ensureAuthorityStores, epgateKey, listGoalIndex, MANAGER_LEASE_RENEW_MS, mintCreds, mintLifecycleUid, newIdentity, parseEndpointGate, recordsBucket, rejectionText, standaloneConnectOpts, STANDING_RENEWABLE_TTL_SEC } from "@cotal-ai/core";
import type { SpaceAuth } from "@cotal-ai/core";
import { authDir, claimIdentityRecord, createManagerInstanceIdentity, getSpaceAuth, hasUserAuthState, loadManagerInstanceIdentity, loadMeshes, localTrustOfSpace, userAuthStateDir } from "@cotal-ai/workspace";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { credRenewIntervalMs } from "./credential-renewal.js";
import { DELIVERY_ADMIN_BOOT_WAIT_MS, makeManagerEndpointHolderEvictor } from "./endpoint-evict.js";
import { makeManagerHolderLivenessProbe } from "./holder-liveness.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";
import { GateReconcileRefused, reconcileEndpointGate } from "./reconcile-gate.js";
import { RunHosting } from "./run-hosting.js";
import { TranscriptReceiver } from "./transcript-receive.js";

/** Startup reconciliation overlaps control-service registration. A spawn or attach for one of
 * these aliases must wait until THAT alias's exact-op terminal attempt returns rather than racing
 * a reuse. */
const STARTUP_RECONCILING = "startup static lifecycle reconciliation";

/** What {@link ManagerBoot} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface ManagerBootDeps {
  admittedLocalIdentity: () => Manager["admittedLocalIdentity"];
  setAdmittedLocalIdentity: (value: Manager["admittedLocalIdentity"]) => void;
  attach: () => Manager["attach"];
  auth: () => Manager["auth"];
  setAuth: (value: Manager["auth"]) => void;
  bootNotes: () => Manager["bootNotes"];
  credRenewTimer: () => Manager["credRenewTimer"];
  setCredRenewTimer: (value: Manager["credRenewTimer"]) => void;
  daemonRenewalLeaseTimer: () => Manager["daemonRenewalLeaseTimer"];
  setDaemonRenewalLeaseTimer: (value: Manager["daemonRenewalLeaseTimer"]) => void;
  ep: () => Manager["ep"];
  setEp: (value: Manager["ep"]) => void;
  execution: () => Manager["execution"];
  leaseInfo: () => Manager["leaseInfo"];
  setLeaseInfo: (value: Manager["leaseInfo"]) => void;
  leaseRevision: () => Manager["leaseRevision"];
  setLeaseRevision: (value: Manager["leaseRevision"]) => void;
  leaseStopping: () => Manager["leaseStopping"];
  leaseTimer: () => Manager["leaseTimer"];
  setLeaseTimer: (value: Manager["leaseTimer"]) => void;
  managerInstanceId: () => Manager["managerInstanceId"];
  setManagerInstanceId: (value: Manager["managerInstanceId"]) => void;
  managerLifecycleUid: () => Manager["managerLifecycleUid"];
  managerServeIdentity: () => Manager["managerServeIdentity"];
  setManagerServeIdentity: (value: Manager["managerServeIdentity"]) => void;
  name: () => Manager["name"];
  onServiceIdentity: () => Manager["onServiceIdentity"];
  remoteAuthority: () => Manager["remoteAuthority"];
  remoteSupervisorCreds: () => Manager["remoteSupervisorCreds"];
  resumeCredRenewal: () => Manager["resumeCredRenewal"];
  setResumeCredRenewal: (value: Manager["resumeCredRenewal"]) => void;
  runHosting: () => Manager["runHosting"];
  setRunHosting: (value: Manager["runHosting"]) => void;
  runtimeKind: () => Manager["runtimeKind"];
  secrets: () => Manager["secrets"];
  servers: () => Manager["servers"];
  serviceServe: () => Manager["serviceServe"];
  space: () => Manager["space"];
  staticLifecycle: () => Manager["staticLifecycle"];
  streamsTerminal: () => Manager["streamsTerminal"];
  transcripts: () => Manager["transcripts"];
  setTranscripts: (value: Manager["transcripts"]) => void;
  transportDown: () => Manager["transportDown"];
  userMode: () => Manager["userMode"];
  setUserMode: (value: Manager["userMode"]) => void;
  workspaceRoot: () => Manager["workspaceRoot"];
  acquireInstanceLease: (...args: Parameters<Manager["acquireInstanceLease"]>) => ReturnType<Manager["acquireInstanceLease"]>;
  adoptReleasedSeats: (...args: Parameters<Manager["adoptReleasedSeats"]>) => ReturnType<Manager["adoptReleasedSeats"]>;
  claimDaemonRenewalOwnership: (...args: Parameters<Manager["claimDaemonRenewalOwnership"]>) => ReturnType<Manager["claimDaemonRenewalOwnership"]>;
  dial: (...args: Parameters<Manager["dial"]>) => ReturnType<Manager["dial"]>;
  executionRecordPath: (...args: Parameters<Manager["executionRecordPath"]>) => ReturnType<Manager["executionRecordPath"]>;
  inspectConnectorsAtBoot: (...args: Parameters<Manager["inspectConnectorsAtBoot"]>) => ReturnType<Manager["inspectConnectorsAtBoot"]>;
  keepDaemonRenewalLease: (...args: Parameters<Manager["keepDaemonRenewalLease"]>) => ReturnType<Manager["keepDaemonRenewalLease"]>;
  logSeatMeshTransitions: (...args: Parameters<Manager["logSeatMeshTransitions"]>) => ReturnType<Manager["logSeatMeshTransitions"]>;
  reconcileGoalIndex: (...args: Parameters<Manager["reconcileGoalIndex"]>) => ReturnType<Manager["reconcileGoalIndex"]>;
  reconcileStaticLifecycles: (...args: Parameters<Manager["reconcileStaticLifecycles"]>) => ReturnType<Manager["reconcileStaticLifecycles"]>;
  registerManagerService: (...args: Parameters<Manager["registerManagerService"]>) => ReturnType<Manager["registerManagerService"]>;
  renewDaemonCreds: (...args: Parameters<Manager["renewDaemonCreds"]>) => ReturnType<Manager["renewDaemonCreds"]>;
  renewLease: (...args: Parameters<Manager["renewLease"]>) => ReturnType<Manager["renewLease"]>;
  renewRemoteExecutor: (...args: Parameters<Manager["renewRemoteExecutor"]>) => ReturnType<Manager["renewRemoteExecutor"]>;
  renewRemoteStandingBundle: (...args: Parameters<Manager["renewRemoteStandingBundle"]>) => ReturnType<Manager["renewRemoteStandingBundle"]>;
  serviceIdentityObservation: (...args: Parameters<Manager["serviceIdentityObservation"]>) => ReturnType<Manager["serviceIdentityObservation"]>;
  startGoalWriter: (...args: Parameters<Manager["startGoalWriter"]>) => ReturnType<Manager["startGoalWriter"]>;
  startSessionPlane: (...args: Parameters<Manager["startSessionPlane"]>) => ReturnType<Manager["startSessionPlane"]>;
  withTransferReader: <T>(fn: (nc: NatsConnection) => Promise<T>) => Promise<T>;
}

/** Builds the {@link ManagerBootDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function bootDeps(m: Manager): ManagerBootDeps {
  return {
    admittedLocalIdentity: () => m["admittedLocalIdentity"],
    setAdmittedLocalIdentity: (value) => { m["admittedLocalIdentity"] = value; },
    attach: () => m["attach"],
    auth: () => m["auth"],
    setAuth: (value) => { m["auth"] = value; },
    bootNotes: () => m["bootNotes"],
    credRenewTimer: () => m["credRenewTimer"],
    setCredRenewTimer: (value) => { m["credRenewTimer"] = value; },
    daemonRenewalLeaseTimer: () => m["daemonRenewalLeaseTimer"],
    setDaemonRenewalLeaseTimer: (value) => { m["daemonRenewalLeaseTimer"] = value; },
    ep: () => m["ep"],
    setEp: (value) => { m["ep"] = value; },
    execution: () => m["execution"],
    leaseInfo: () => m["leaseInfo"],
    setLeaseInfo: (value) => { m["leaseInfo"] = value; },
    leaseRevision: () => m["leaseRevision"],
    setLeaseRevision: (value) => { m["leaseRevision"] = value; },
    leaseStopping: () => m["leaseStopping"],
    leaseTimer: () => m["leaseTimer"],
    setLeaseTimer: (value) => { m["leaseTimer"] = value; },
    managerInstanceId: () => m["managerInstanceId"],
    setManagerInstanceId: (value) => { m["managerInstanceId"] = value; },
    managerLifecycleUid: () => m["managerLifecycleUid"],
    managerServeIdentity: () => m["managerServeIdentity"],
    setManagerServeIdentity: (value) => { m["managerServeIdentity"] = value; },
    name: () => m["name"],
    onServiceIdentity: () => m["onServiceIdentity"],
    remoteAuthority: () => m["remoteAuthority"],
    remoteSupervisorCreds: () => m["remoteSupervisorCreds"],
    resumeCredRenewal: () => m["resumeCredRenewal"],
    setResumeCredRenewal: (value) => { m["resumeCredRenewal"] = value; },
    runHosting: () => m["runHosting"],
    setRunHosting: (value) => { m["runHosting"] = value; },
    runtimeKind: () => m["runtimeKind"],
    secrets: () => m["secrets"],
    servers: () => m["servers"],
    serviceServe: () => m["serviceServe"],
    space: () => m["space"],
    staticLifecycle: () => m["staticLifecycle"],
    streamsTerminal: () => m["streamsTerminal"],
    transcripts: () => m["transcripts"],
    setTranscripts: (value) => { m["transcripts"] = value; },
    transportDown: () => m["transportDown"],
    userMode: () => m["userMode"],
    setUserMode: (value) => { m["userMode"] = value; },
    workspaceRoot: () => m["workspaceRoot"],
    acquireInstanceLease: (...args) => m["acquireInstanceLease"](...args),
    adoptReleasedSeats: (...args) => m["adoptReleasedSeats"](...args),
    claimDaemonRenewalOwnership: (...args) => m["claimDaemonRenewalOwnership"](...args),
    dial: (...args) => m["dial"](...args),
    executionRecordPath: (...args) => m["executionRecordPath"](...args),
    inspectConnectorsAtBoot: (...args) => m["inspectConnectorsAtBoot"](...args),
    keepDaemonRenewalLease: (...args) => m["keepDaemonRenewalLease"](...args),
    logSeatMeshTransitions: (...args) => m["logSeatMeshTransitions"](...args),
    reconcileGoalIndex: (...args) => m["reconcileGoalIndex"](...args),
    reconcileStaticLifecycles: (...args) => m["reconcileStaticLifecycles"](...args),
    registerManagerService: (...args) => m["registerManagerService"](...args),
    renewDaemonCreds: (...args) => m["renewDaemonCreds"](...args),
    renewLease: (...args) => m["renewLease"](...args),
    renewRemoteExecutor: (...args) => m["renewRemoteExecutor"](...args),
    renewRemoteStandingBundle: (...args) => m["renewRemoteStandingBundle"](...args),
    serviceIdentityObservation: (...args) => m["serviceIdentityObservation"](...args),
    startGoalWriter: (...args) => m["startGoalWriter"](...args),
    startSessionPlane: (...args) => m["startSessionPlane"](...args),
    withTransferReader: (fn) => m["withTransferReader"](fn),
  };
}

/** Starting the manager: admitting its execution state, connecting and registering it, taking its instance lease, and healing a predecessor's frozen registration gate. */
export class ManagerBoot {
  constructor(private readonly deps: ManagerBootDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get admittedLocalIdentity() { return this.deps.admittedLocalIdentity(); }
  private set admittedLocalIdentity(value: Manager["admittedLocalIdentity"]) { this.deps.setAdmittedLocalIdentity(value); }
  private get attach() { return this.deps.attach(); }
  private get auth() { return this.deps.auth(); }
  private set auth(value: Manager["auth"]) { this.deps.setAuth(value); }
  private get bootNotes() { return this.deps.bootNotes(); }
  private get credRenewTimer() { return this.deps.credRenewTimer(); }
  private set credRenewTimer(value: Manager["credRenewTimer"]) { this.deps.setCredRenewTimer(value); }
  private get daemonRenewalLeaseTimer() { return this.deps.daemonRenewalLeaseTimer(); }
  private set daemonRenewalLeaseTimer(value: Manager["daemonRenewalLeaseTimer"]) { this.deps.setDaemonRenewalLeaseTimer(value); }
  private get ep() { return this.deps.ep(); }
  private set ep(value: Manager["ep"]) { this.deps.setEp(value); }
  private get execution() { return this.deps.execution(); }
  private get leaseInfo() { return this.deps.leaseInfo(); }
  private set leaseInfo(value: Manager["leaseInfo"]) { this.deps.setLeaseInfo(value); }
  private get leaseRevision() { return this.deps.leaseRevision(); }
  private set leaseRevision(value: Manager["leaseRevision"]) { this.deps.setLeaseRevision(value); }
  private get leaseStopping() { return this.deps.leaseStopping(); }
  private get leaseTimer() { return this.deps.leaseTimer(); }
  private set leaseTimer(value: Manager["leaseTimer"]) { this.deps.setLeaseTimer(value); }
  private get managerInstanceId() { return this.deps.managerInstanceId(); }
  private set managerInstanceId(value: Manager["managerInstanceId"]) { this.deps.setManagerInstanceId(value); }
  private get managerLifecycleUid() { return this.deps.managerLifecycleUid(); }
  private get managerServeIdentity() { return this.deps.managerServeIdentity(); }
  private set managerServeIdentity(value: Manager["managerServeIdentity"]) { this.deps.setManagerServeIdentity(value); }
  private get name() { return this.deps.name(); }
  private get onServiceIdentity() { return this.deps.onServiceIdentity(); }
  private get remoteAuthority() { return this.deps.remoteAuthority(); }
  private get remoteSupervisorCreds() { return this.deps.remoteSupervisorCreds(); }
  private get resumeCredRenewal() { return this.deps.resumeCredRenewal(); }
  private set resumeCredRenewal(value: Manager["resumeCredRenewal"]) { this.deps.setResumeCredRenewal(value); }
  private get runHosting() { return this.deps.runHosting(); }
  private set runHosting(value: Manager["runHosting"]) { this.deps.setRunHosting(value); }
  private get runtimeKind() { return this.deps.runtimeKind(); }
  private get secrets() { return this.deps.secrets(); }
  private get servers() { return this.deps.servers(); }
  private get serviceServe() { return this.deps.serviceServe(); }
  private get space() { return this.deps.space(); }
  private get staticLifecycle() { return this.deps.staticLifecycle(); }
  private get streamsTerminal() { return this.deps.streamsTerminal(); }
  private get transcripts() { return this.deps.transcripts(); }
  private set transcripts(value: Manager["transcripts"]) { this.deps.setTranscripts(value); }
  private get transportDown() { return this.deps.transportDown(); }
  private get userMode() { return this.deps.userMode(); }
  private set userMode(value: Manager["userMode"]) { this.deps.setUserMode(value); }
  private get workspaceRoot() { return this.deps.workspaceRoot(); }
  private acquireInstanceLease(...args: Parameters<Manager["acquireInstanceLease"]>): ReturnType<Manager["acquireInstanceLease"]> { return this.deps.acquireInstanceLease(...args); }
  private adoptReleasedSeats(...args: Parameters<Manager["adoptReleasedSeats"]>): ReturnType<Manager["adoptReleasedSeats"]> { return this.deps.adoptReleasedSeats(...args); }
  private claimDaemonRenewalOwnership(...args: Parameters<Manager["claimDaemonRenewalOwnership"]>): ReturnType<Manager["claimDaemonRenewalOwnership"]> { return this.deps.claimDaemonRenewalOwnership(...args); }
  private dial(...args: Parameters<Manager["dial"]>): ReturnType<Manager["dial"]> { return this.deps.dial(...args); }
  private executionRecordPath(...args: Parameters<Manager["executionRecordPath"]>): ReturnType<Manager["executionRecordPath"]> { return this.deps.executionRecordPath(...args); }
  private inspectConnectorsAtBoot(...args: Parameters<Manager["inspectConnectorsAtBoot"]>): ReturnType<Manager["inspectConnectorsAtBoot"]> { return this.deps.inspectConnectorsAtBoot(...args); }
  private keepDaemonRenewalLease(...args: Parameters<Manager["keepDaemonRenewalLease"]>): ReturnType<Manager["keepDaemonRenewalLease"]> { return this.deps.keepDaemonRenewalLease(...args); }
  private logSeatMeshTransitions(...args: Parameters<Manager["logSeatMeshTransitions"]>): ReturnType<Manager["logSeatMeshTransitions"]> { return this.deps.logSeatMeshTransitions(...args); }
  private reconcileGoalIndex(...args: Parameters<Manager["reconcileGoalIndex"]>): ReturnType<Manager["reconcileGoalIndex"]> { return this.deps.reconcileGoalIndex(...args); }
  private reconcileStaticLifecycles(...args: Parameters<Manager["reconcileStaticLifecycles"]>): ReturnType<Manager["reconcileStaticLifecycles"]> { return this.deps.reconcileStaticLifecycles(...args); }
  private registerManagerService(...args: Parameters<Manager["registerManagerService"]>): ReturnType<Manager["registerManagerService"]> { return this.deps.registerManagerService(...args); }
  private renewDaemonCreds(...args: Parameters<Manager["renewDaemonCreds"]>): ReturnType<Manager["renewDaemonCreds"]> { return this.deps.renewDaemonCreds(...args); }
  private renewLease(...args: Parameters<Manager["renewLease"]>): ReturnType<Manager["renewLease"]> { return this.deps.renewLease(...args); }
  private renewRemoteExecutor(...args: Parameters<Manager["renewRemoteExecutor"]>): ReturnType<Manager["renewRemoteExecutor"]> { return this.deps.renewRemoteExecutor(...args); }
  private renewRemoteStandingBundle(...args: Parameters<Manager["renewRemoteStandingBundle"]>): ReturnType<Manager["renewRemoteStandingBundle"]> { return this.deps.renewRemoteStandingBundle(...args); }
  private serviceIdentityObservation(...args: Parameters<Manager["serviceIdentityObservation"]>): ReturnType<Manager["serviceIdentityObservation"]> { return this.deps.serviceIdentityObservation(...args); }
  private startGoalWriter(...args: Parameters<Manager["startGoalWriter"]>): ReturnType<Manager["startGoalWriter"]> { return this.deps.startGoalWriter(...args); }
  private startSessionPlane(...args: Parameters<Manager["startSessionPlane"]>): ReturnType<Manager["startSessionPlane"]> { return this.deps.startSessionPlane(...args); }
  private withTransferReader<T>(fn: (nc: NatsConnection) => Promise<T>): Promise<T> { return this.deps.withTransferReader(fn); }

  claimExecutionRecord(instanceId: string): void {
    const record = claimIdentityRecord(this.executionRecordPath(instanceId), "manager execution capability", (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const r = raw as Record<string, unknown>;
      return Object.keys(r).sort().join(",") === "execution,instanceId,space,v" && r.v === 1 && r.space === this.space &&
        r.instanceId === instanceId && (r.execution === "none" || r.execution === "runtime") ? r : undefined;
    }, () => ({ v: 1, space: this.space, instanceId, execution: this.execution }));
    if (record.execution !== this.execution)
      throw new Error("manager execution capability differs from its retained instance record; execution cannot change across restart");
  }

  private async admitExecutionState(): Promise<void> {
    if (!this.remoteAuthority) {
      let local = this.admittedLocalIdentity;
      this.admittedLocalIdentity = undefined;
      if (this.execution === "none") {
        const recorded = loadMeshes().find((m) => m.space === this.space);
        const auth = hasUserAuthState(this.workspaceRoot, this.space) && recorded?.mode === "user"
          ? await getSpaceAuth(this.secrets, this.space) : undefined;
        if (!auth)
          throw new Error("execution: none requires a genuine hosting user-auth root and its user-mode mesh record");
        if (!local) local = loadManagerInstanceIdentity(this.workspaceRoot, this.space);
        if (local && !existsSync(this.executionRecordPath(local.instanceId)))
          throw new Error("execution: none refuses an existing unclassified manager instance; keep its runtime and retained state, or register a fresh control instance");
        if (!local) {
          const proposed = { instanceId: mintLifecycleUid(), serveIdentity: newIdentity() };
          local = createManagerInstanceIdentity(this.workspaceRoot, this.space, () => proposed);
          if (local.instanceId !== proposed.instanceId)
            throw new Error("execution: none refuses a concurrently claimed unclassified manager identity");
        }
        const localInstanceId = local.instanceId;
        this.claimExecutionRecord(localInstanceId);
        const nc = await this.dial({ ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }), maxReconnectAttempts: 0 });
        try {
          const kvm = new Kvm(nc);
          await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
          const entries = await listGoalIndex(await kvm.open(recordsBucket(this.space)), MANAGER_ENDPOINT);
          if (entries.some((entry) => entry.iid === localInstanceId && (entry.allocated !== undefined || entry.note !== undefined)))
            throw new Error("execution: none refuses retained seat or turn inventory before recovery; keep the execution-owning Manager");
        } finally { await drainAndClose(nc); }
        this.admittedLocalIdentity = local;
      } else {
        local ??= createManagerInstanceIdentity(this.workspaceRoot, this.space, () => ({ instanceId: mintLifecycleUid(), serveIdentity: newIdentity() }));
        this.claimExecutionRecord(local.instanceId);
        this.admittedLocalIdentity = local;
      }
      return;
    }
    if (this.remoteAuthority) {
      if (this.execution === "none" && (await localTrustOfSpace(this.secrets, this.space)).present)
        throw new Error("remote manager-service authority cannot be combined with local space signing trust - choose one authority path, never a fallback");
      // Execution is fixed for a registered instance. An older instance with no capability
      // record might own retained seats/runs, so it cannot be converted to none by omission.
      const remote = this.remoteAuthority;
      const path = this.executionRecordPath(remote.instanceId);
      if (this.execution === "none" && !existsSync(path) && remote.serveGrant.epoch !== 0)
        throw new Error("execution: none refuses an existing unclassified manager instance; keep its runtime and retained state, or register a fresh control instance");
      if (this.execution === "none") {
        const entries = await remote.scanGoalIndex();
        if (entries.some((entry) => entry.iid === remote.instanceId && (entry.allocated !== undefined || entry.note !== undefined)))
          throw new Error("execution: none refuses retained seat or turn inventory before recovery; keep the execution-owning Manager");
      }
      if (this.execution === "none" || existsSync(path)) this.claimExecutionRecord(remote.instanceId);
    }
  }

  async runStart(): Promise<void> {
    await this.admitExecutionState();
    this.staticLifecycle.start();
    await this.inspectConnectorsAtBoot();
    await this.attach.start();
    // In auth mode the manager is just another user in the space's account — it mints
    // itself creds from the same signing key it uses for the agents it spawns. The signer comes
    // through the SecretStore seam (`this.secrets` — the injected `ManagerOptions.secretStore`, or
    // the local `.cotal/auth/auth.json` FS default), so a HOSTED composition mints from its KMS/Vault
    // and no signing seed is ever read from the hosted disk. `this.space` cross-checks the bundle.
    //
    // REMOTE AUTHORITY (#1944): a manager holding host-issued remote authority mints nothing from a
    // local signer, so it never composes or validates local trust. It asks ONE question of the
    // store — does THIS space's own local signing trust exist (`localTrustOfSpace`) — because that
    // alone is the conflict of authorities a supervisor refuses. The stock behaviour this replaces
    // read the whole root's trust chain (`getSpaceAuth`): with no records for this space it fell
    // back to the legacy monolith of an UNRELATED static tenant and reported that bundle as
    // "corrupt or mislabeled". Other tenants' records — split (their account + the shared
    // per-root broker record) or monolith — are not this space's trust and never refuse; an
    // unreadable record on a key that is read refuses loud with the store's own parse message.
    //
    // An OPEN mesh mints nothing, also in a root that still holds a static stack's accounts. A
    // credential minted there joins this instance's family in the open account, and the next open
    // boot could re-register only by verify-evicting it through a delivery daemon that an open mesh
    // does not run.
    const recorded = loadMeshes().find((m) => m.space === this.space);
    if (this.remoteAuthority) {
      if ((await localTrustOfSpace(this.secrets, this.space)).present)
        throw new Error("remote manager-service authority cannot be combined with local space signing trust - choose one authority path, never a fallback");
      this.auth = undefined;
    } else {
      this.auth = recorded?.mode === "open" ? undefined : await getSpaceAuth(this.secrets, this.space);
    }
    // USER-MODE detection is FAIL-CLOSED on the on-disk marker (the space-scoped state dir), never
    // on the mutable mesh registry alone — registry drift/tamper must not let a user-auth space
    // take the static self-mint branch. A marker/registry disagreement is a refused start with the
    // repair, not a guess.
    this.userMode = this.remoteAuthority !== undefined || hasUserAuthState(this.workspaceRoot, this.space);
    if (!this.remoteAuthority && recorded && (recorded.mode === "user") !== this.userMode)
      throw new Error(
        `mesh registry says space "${this.space}" is ${recorded.mode}-mode but the on-disk user-auth marker ${this.userMode ? "exists" : "is missing"} (${userAuthStateDir(this.workspaceRoot, this.space)}) - \`cotal down\` and re-\`cotal up\` this space to reconcile before running a manager`,
      );
    if (!this.remoteAuthority && this.userMode && !recorded)
      throw new Error(
        `space "${this.space}" has user-auth state on disk but no mesh registry entry - a user-mode manager needs the authoritative record (\`cotal up\` writes it before the control plane); \`cotal up --user-auth\` this space, or remove the stale ${userAuthStateDir(this.workspaceRoot, this.space)}`,
      );
    if (!this.remoteAuthority && this.userMode && !this.auth)
      throw new Error(
        `space "${this.space}" has user-auth state but no auth.json under ${authDir(this.workspaceRoot)} - the pre-flip manager still needs the space trust bundle; re-run \`cotal up --user-auth\` here`,
      );
    // SPEC 13.6 item 7: the LOGICAL instance id + serve identity PERSIST across restart
    // (a space-scoped manager identity file under .cotal). A restart re-registers the SAME id with an
    // ADVANCED epoch (the successor fences the predecessor); a fresh mint over a malformed file is
    // refused loud (no-fallbacks - a restart never silently becomes a fresh instance). A second
    // manager in a DIFFERENT workspace root is a DIFFERENT logical id by construction (its own state
    // dir) - two managers in ONE space are two workspace roots.
    //
    // First mint on a fresh root is exclusive create (#1263). Two processes that both observe no
    // file must not keep different in-memory ids: of N concurrent starts exactly one publishes the
    // file by hard link and the others adopt that identity before taking a lease, or refuse with
    // identity-record-create-lost. A filesystem without hard links refuses the first start with
    // atomic-publish-unsupported. Atomic rename is not enough, because the loser
    // of a replace would still serve under the id it minted.
    {
      if (this.remoteAuthority) {
        this.managerInstanceId = this.remoteAuthority.instanceId;
        this.managerServeIdentity = this.remoteAuthority.identities.serve;
      } else {
        // Admission already resolved this identity, including the first mint. A second claim here
        // would stat the same record again.
        const claimed = this.admittedLocalIdentity;
        if (!claimed) throw new Error("manager start has no admitted local identity");
        this.admittedLocalIdentity = undefined;
        this.managerInstanceId = claimed.instanceId;
        this.managerServeIdentity = claimed.serveIdentity;
      }
    }
    await this.onServiceIdentity?.(this.serviceIdentityObservation());
    let creds: (() => Promise<string>) | undefined;
    let id: string | undefined;
    if (this.remoteAuthority) {
      const remote = this.remoteAuthority;
      id = remote.identities.supervisor.id;
      creds = async () => this.remoteSupervisorCreds!;
    } else if (this.auth) {
      const identity = newIdentity();
      const auth = this.auth;
      id = identity.id;
      // The long-lived SUPERVISOR cred (closure (ii), residual 2): serve the three control tiers, hold the
      // singleton lease (open-only), publish + watch presence — and nothing else. Provisioning runs on an
      // EPHEMERAL provisioner connection per spawn (withProvisioner); destructive purge mints a PURGER per
      // call. So the always-on daemon holds no DM/DLV read, no consumer-create, no stream-admin tamper.
      //
      // STANDING RENEWAL (class 1): the manager holds the DATA signing seed, so it is its
      // own renewal owner — the cred rides the endpoint's SOURCE seam and self-remints (same identity,
      // pinned by the endpoint) ahead of each bounded supervisor JWT's expiry. A copied supervisor
      // cred is broker-dead within the matrix TTL.
      creds = () => mintCreds(auth, identity, "supervisor");
    }
    this.ep = new CotalEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      creds,
      // The supervisor registers on the roster, and an authed presence-registering endpoint is
      // lifecycle-keyed (SPEC 13.1, fail-before-presence). The manager process is the top of its
      // own launch chain (the operator command IS its launcher): its incarnation uid is the
      // per-process `managerLifecycleUid` field (also the `managerInstance` audit coordinate on
      // every static activation).
      lifecycleUid: this.remoteAuthority?.lifecycleUid ?? this.managerLifecycleUid,
      // The supervisor serves control + watches presence; it never consumes chat/dm/task
      // (no message handler). consume:false avoids binding consumers it doesn't use — and
      // under auth avoids trying to bind its own DM/task durables that nothing pre-created.
      // It still pre-creates OTHERS' durables via provisionDmInbox/provisionTaskQueue (lazy jsm).
      consume: false,
      // It also never reads the channel registry (it provisions + serves control, no channel
      // pull/display), so skip the channel-registry watch — the supervisor cred (residual 2) then
      // holds no channel-KV read grant. Presence (the roster) is still watched.
      watchChannels: false,
      // `host` says which machine runs this manager, as an agent's card does: an owner with several
      // managers tells them apart by it. Advisory display metadata, never a routing input.
      card: { id, ...(this.remoteAuthority ? { owner: this.remoteAuthority.owner, actor: this.remoteAuthority.actors.supervisor } : {}), name: this.name, role: "manager", kind: "endpoint", meta: { host: hostname(), terminal: this.streamsTerminal ? "stream" : "none" } },
    });
    // Raw failures ride error; conditions the endpoint is already surviving ride warning. Both
    // matter to a supervisor operator, especially a failed standing-credential renewal.
    const reportEndpoint = (e: Error) => console.error(`! manager endpoint: ${e.message}`);
    this.ep.on("error", reportEndpoint);
    this.ep.on("warning", reportEndpoint);
    // Every roster change and every view transition, so a seat that is offline in a fresh snapshot
    // (recorded with no presence event) is logged the moment the view can support the verdict.
    this.ep.on("roster", () => this.logSeatMeshTransitions());
    this.ep.on("presence-view", () => this.logSeatMeshTransitions());
    console.error("manager startup: connecting the supervisor endpoint");
    await this.ep.start();
    await this.ep.setActivity(`supervisor (${this.runtimeKind})`);
    // Per-instance liveness lease (the old per-space singleton is DEMOTED). Acquire
    // THIS logical instance's own key (atomic CAS create). A DIFFERENT instance (a second manager in a
    // second workspace root) has a distinct id ⇒ a distinct key ⇒ it coexists; the create THROWS only
    // when the SAME instance id is already live (a same-root double-start, or a restart racing the
    // crashed predecessor's not-yet-expired key). A double-start REFUSES loud; a restart whose
    // predecessor is provably dead on this host waits for that key's bucket TTL to remove it (#4092,
    // {@link acquireInstanceLease}). Losing the key LATER ends this process only when another process holds it; otherwise
    // the renew loop puts it back or keeps retrying ({@link renewLease}).
    this.leaseInfo = { holder: this.ep.ref().id, instanceId: this.managerInstanceId, runtime: this.runtimeKind, root: resolve(this.workspaceRoot), pid: process.pid };
    try {
      console.error("manager startup: acquiring the instance liveness lease");
      this.leaseRevision = await this.acquireInstanceLease(this.leaseInfo);
    } catch (e) {
      await this.ep.stop();
      await this.attach.stop();
      throw e;
    }
    this.leaseTimer = setInterval(() => { void this.renewLease(); }, MANAGER_LEASE_RENEW_MS);
    this.leaseTimer.unref?.();
    // THE PEER-READABLE LIVENESS RESPONDER for the manager plane (#1577). Bound HERE — after the
    // lease, before registration — precisely so it is up during the window in which the manager is
    // NOT yet serving. A responder that only appeared once everything worked could never report the
    // broken state it exists to report, which is the reported defect in a new place.
    //
    // WHAT IT GRADES is `serviceServe`, the v0.4 service endpoint's serve handle, which is assigned
    // only after `serveEndpoint` has bound this instance's rails, AND that handle's connection. A
    // closed serve connection holds no subscriptions, while `onServeConnectionClosed` keeps the
    // handle through its re-dial waits, so the handle alone would answer `bound` with every rail
    // gone. The re-dial swaps in the fresh connection and handle together, so `bound` returns only
    // once the rails are served again. A DISCONNECTED serve connection is the same fault without the
    // close: it reconnects without limit, so it stays open while the broker holds none of its rails,
    // and this probe arrives on the separate supervisor connection that is still up. So the grade
    // also requires the serve transport to be connected. That is a RESPONDER fact. It is
    // deliberately NOT "this process is alive": this process is trivially alive whenever it answers
    // at all, so grading on that would make the surface a `pgrep` that also lies in both directions
    // — the exact instrument the reporter's evidence table indicts. Between lease acquisition and a
    // successful registration the honest answer is `unbound`, and that is what a peer is told.
    //
    // The lease row is never consulted and never sent: presence is the whole ask, and the row
    // carries the operator's workspace root and pid.
    this.ep.serveLiveness("manager", () => {
      const s = this.serviceServe;
      return s?.handle && !s.nc.isClosed() && !this.transportDown.has(s.nc) ? "bound" : "unbound";
    });
    // Static §13.1: after this instance holds its lease, collect the durable static rows
    // now, but do not let their exact-op terminals make the whole space unreachable. The service
    // comes up below, then the sweep overlaps the remaining registration work. Two-window
    // heal-then-register is slower than one executor, but the overlap is still the no-outage
    // property: `reconcilingAliases` refuses spawn or attach of THAT alias until its terminal
    // attempt returns.
    const startupReconcile = this.auth && !this.userMode ? this.reconcileStaticLifecycles() : undefined;
    if (startupReconcile)
      void startupReconcile.catch((e) => console.error(`! ${STARTUP_RECONCILING}: ${rejectionText(e)} - no per-alias retry could be planned; a later manager start re-reads unfinished durable terminals`));
    // A default stop records a user-mode seat it released while the seat was still running. This
    // start adopts that seat, or retires it when the runtime proves it gone. Static seats stay on
    // the sweep above.
    if (this.userMode)
      void this.adoptReleasedSeats().catch((e) => console.error(`! a released seat was not adopted: ${rejectionText(e)}`));
    // The manager serves NO ctl tiers - its whole control surface is the v0.4
    // service endpoint registered below. The old three-tier rail (self/manager/admin) is deleted;
    // `ctl.delivery`/`ctl.delivery-admin` (the delivery daemon) and `ctl.auth-admin` (the auth
    // plane) are separate services and keep their rails.
    // Class 2: the manager is the CLASS-2 RENEWAL OWNER — the one control-plane process
    // that is resident in EVERY mesh mode (foreground `up`, `up --detach`, same-root refresh) and
    // holds the signer. Ordered initial pass NOW (ensureControlPlane starts delivery BEFORE the
    // manager, so the daemon's launch-time creds write always precedes this — no write race), then
    // every half-TTL: re-sign the daemon creds files for their EXISTING nkeys, request the explicit
    // `reloadCreds` adoption on the delivery-admin rail, and persist the audit record doctor renders.
    if (this.auth) {
      // #1634: a space may be served by several managers, so ownership of the daemon's credential
      // renewal is decided here rather than by being the only manager able to start. #871: a daemon
      // that is still binding or re-acquiring its lease leaves this challenge unanswered for a few
      // seconds, so boot waits that out instead of exiting over a daemon about to answer.
      await this.claimDaemonRenewalOwnership(DELIVERY_ADMIN_BOOT_WAIT_MS);
      // ARMED BEFORE the first remint, not after. That first `renewDaemonCreds()` re-signs through
      // the SecretStore, and a slow or contended store makes the one pass outlast the lease's
      // MANAGER_LEASE_TTL_MS. Arming afterwards leaves the whole first remint unprotected: the lease
      // expires mid-pass, a second manager's CAS create succeeds, and both remint into one store.
      this.daemonRenewalLeaseTimer = setInterval(() => { void this.keepDaemonRenewalLease(); }, MANAGER_LEASE_RENEW_MS);
      this.daemonRenewalLeaseTimer.unref?.();
      await this.renewDaemonCreds();
      this.credRenewTimer = setInterval(() => { void this.renewDaemonCreds(); }, credRenewIntervalMs(STANDING_RENEWABLE_TTL_SEC));
      this.credRenewTimer.unref?.();
    } else if (this.remoteAuthority) {
      if (this.remoteAuthority.renewStandingBundle) await this.renewRemoteStandingBundle();
      else await this.renewRemoteExecutor();
      let standingTtl = STANDING_RENEWABLE_TTL_SEC;
      if (this.remoteSupervisorCreds) {
        try {
          const claims = credsClaims(this.remoteSupervisorCreds);
          if (typeof claims.exp === "number" && typeof claims.iat === "number" && claims.exp > claims.iat) {
            standingTtl = claims.exp - claims.iat;
          }
        } catch {}
      }
      // A refused family needs another pass inside the final quarter of its lifetime.
      const intervalMs = Math.min(credRenewIntervalMs(5 * 60), Math.max(1, Math.floor(standingTtl * 1000 / 8)));
      this.resumeCredRenewal = () => {
        if (this.credRenewTimer || this.leaseStopping) return;
        this.credRenewTimer = setInterval(async () => {
          try {
            if (this.remoteAuthority?.renewStandingBundle) await this.renewRemoteStandingBundle();
            else await this.renewRemoteExecutor();
          } catch (e) {
            console.error(`! remote manager renewal pass failed: ${rejectionText(e)}`);
          }
          try {
            await this.runHosting?.renew();
          } catch (e) {
            console.error(`! remote run-hosting renewal pass failed: ${rejectionText(e)}`);
          }
        }, intervalMs);
        this.credRenewTimer.unref?.();
      };
      this.resumeCredRenewal();
    }
    // stop() fences before it waits for an accepted startup reconciliation terminal. Once that
    // terminal drains, start() and stop() resume from the same await boundary; start must observe
    // the fence before it can publish a fresh service registration after shutdown.
    if (this.staticLifecycle.stopping) return;
    // Register the manager as an ordinary v0.4 `service` endpoint (SPEC §13.7/§13.9)
    // and serve its typed command surface on the ep rails - the ONLY control door, in
    // EVERY mesh mode. Static + user meshes mint the scoped executor + endpoint-serve credential;
    // an open mesh runs the same gate/registration ceremony over bare connections and never mints
    // (there is no credential system - the broker enforces nothing, matching the old open-mesh ctl
    // trust). Fail-loud: a manager that cannot register does not start half-registered.
    console.error("manager startup: binding the service endpoint");
    await this.registerManagerService();
    if (this.staticLifecycle.stopping) return;
    // Stand up the standing goal-writer connection for spawn-as-action — AFTER
    // registration (it writes this endpoint's goal facts/records), disjoint from the serve cred.
    await this.startGoalWriter();
    // Stand up the ONE §13.6 session plane for `attach` — AFTER registration too (it
    // rides the serve grant's epoch + the family-staged session-ledger cred), on its own standing
    // connection disjoint from both the serve and goal-writer creds.
    await this.startSessionPlane();
    // Reconcile any accepted-but-unterminal goals inherited from a predecessor
    // BEFORE spawn-as-action begins accepting (the goalReconcileDone gate) — a fresh incarnation
    // never drops a goal a dead predecessor accepted. Never fatal; the gate opens either way.
    console.error("manager startup: reconciling predecessor goals");
    await this.reconcileGoalIndex();
    // SPEC 14.3: the manager hosts workflow runs. Stood up AFTER registration (it names this
    // instance's coordinates) and reconciled AFTER the goal index, for the same reason: a fresh
    // incarnation takes back every run a dead predecessor was driving before it accepts new ones.
    // The serve surface is already live by here, so the family itself holds the gate: `runHost()`
    // refuses `run-start`/`run-resume` as `unavailable` until the host exists and `RunHosting`
    // refuses them until its reconcile has returned. A remote user-auth manager uses its four
    // registered issuer callbacks instead of holding a signer; a local user mesh stands none up.
    const remoteRuns = this.remoteAuthority?.runHosting;
    if (this.execution !== "none" && this.remoteAuthority && remoteRuns) {
      this.runHosting = new RunHosting({
        space: this.space,
        servers: this.servers,
        endpoint: MANAGER_ENDPOINT,
        instanceId: this.managerInstanceId,
        holder: { id: this.remoteAuthority.identities.supervisor.id, lifecycleUid: this.managerLifecycleUid },
        auth: undefined,
        log: (line) => console.error(line),
        admitRun: remoteRuns.admitRun,
        submitRun: remoteRuns.submitRun,
        revokeRun: remoteRuns.revokeRun,
        cancelRun: remoteRuns.cancelRun,
        issueAttempt: remoteRuns.issueAttempt,
        issueOperator: remoteRuns.issueOperator,
        renewRun: remoteRuns.renewRun,
      });
      await this.runHosting.reconcile();
    } else if (!this.remoteAuthority && !this.userMode) {
      this.runHosting = new RunHosting({
        space: this.space,
        servers: this.servers,
        endpoint: MANAGER_ENDPOINT,
        instanceId: this.managerInstanceId,
        holder: { id: this.ep.ref().id, lifecycleUid: this.managerLifecycleUid },
        auth: this.auth,
        log: (line) => console.error(line),
      });
      await this.runHosting.reconcile();
    }
    // A carried resume (#1499) needs this instance's transfer reader: minted from the space's signing
    // seed, issued by the host to a remote manager, or none on an open mesh.
    if (this.execution !== "none" && (!this.remoteAuthority || this.remoteAuthority.mintTransferReader)) {
      this.transcripts = new TranscriptReceiver({
        space: this.space,
        instanceId: this.managerInstanceId,
        workspaceRoot: this.workspaceRoot,
        withReader: (fn) => this.withTransferReader(fn),
        log: (line) => console.error(line),
      });
      await this.transcripts.start();
    }
    for (const note of this.bootNotes.splice(0)) console.error(note);
    // Plane-3 (durable backstop) is NOT the manager's job — the manager only manages agent lifecycle.
    // The server-side delivery daemon hosts the fan-out writer + trusted reader, owns the durable
    // membership registry, and serves the runtime durable join/leave/list ops (on `ctl.delivery`). The
    // manager records each agent's read ACL at spawn (`commitAcl`, in provisionAgent) so the daemon can
    // re-authorize it; that is the only Plane-3 state the manager touches, and it rides minting.
  }

  /** Complete a crashed predecessor's FROZEN registration gate before this incarnation starts a
   *  new one (#783 item 3 / #871). The CLI `cotal reconcile-gate` already does this; a successor
   *  that cannot register is exactly the state that command exists to repair, so boot must run
   *  the SAME composition rather than waiting for an operator.
   *
   *  Admit only `gone` AND `sweepComplete=true` (the probe mapping already folds an incomplete
   *  `gone` into `unestablishable`). Live / unknown / unestablishable / wrong-op-kind stay loud
   *  refusals. No TTL: request-ingress has no process-epoch fence, so a clock would either let a
   *  superseded serve credential keep consuming ingress or just rename the freeze. An open gate
   *  is a no-op (the successor's own freeze comes next). A committed spec under that freeze is
   *  finished at the committed registrationRevision; only a definite no-commit abort-reopens. */
  async healFrozenRegistrationGate(authKv: KV, instanceId: string, auth: SpaceAuth, recordsKv: KV): Promise<void> {
    const key = epgateKey(MANAGER_ENDPOINT, instanceId);
    const entry = await authKv.get(key);
    if (!entry || entry.operation !== "PUT") return;
    const row = parseEndpointGate(entry.value, key);
    if (row.state !== "frozen") return;
    const servers = this.servers ?? DEFAULT_SERVER;
    const log = (line: string) => console.error(`  ${line}`);
    let report;
    try {
      report = await reconcileEndpointGate({
        kv: authKv, space: this.space, endpoint: MANAGER_ENDPOINT, instanceId,
        probeHolder: makeManagerHolderLivenessProbe({ space: this.space, servers, auth, log, unreachableWaitMs: DELIVERY_ADMIN_BOOT_WAIT_MS }),
        evictHolders: makeManagerEndpointHolderEvictor({ space: this.space, servers, auth, log }),
        log,
        recordsKv,
      });
    } catch (e) {
      // We observed frozen, then a concurrent reconciler finished first. If the gate is now open,
      // this incarnation continues the takeover. Every other refusal — including raced-but-still-
      // frozen — stays loud.
      if (e instanceof GateReconcileRefused && (e.condition === "not-frozen" || e.condition === "raced")) {
        const latest = await authKv.get(key);
        if (latest && latest.operation === "PUT" && parseEndpointGate(latest.value, key).state === "open") {
          console.error(`boot self-heal: ${MANAGER_ENDPOINT}/${instanceId} is open after ${e.condition}; continuing the normal takeover`);
          return;
        }
      }
      throw e;
    }
    console.error(
      `✓ boot self-heal: ${MANAGER_ENDPOINT}/${instanceId} registration gate reopened at generation ${
        report.reopenedAtGeneration} (processEpoch ${report.after.processEpoch}, registrationRevision ${report.after.registrationRevision}; freeze-holder gone, sweepComplete=true). Continuing the normal takeover.`,
    );
  }
}
