import { EpEnvelopeError, loadCotalConfig, rejectionText, resolveAuthProvider, spawnEnvAllow } from "@cotal-ai/core";
import type { Connector, ConnectorModelCatalog, ControlReply, EpCaller } from "@cotal-ai/core";
import { agentAuthState, agentLifecycleSecretFilePaths, isTrustedProject, managerMachineId, userAuthStateDir } from "@cotal-ai/workspace";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { servedConnectorStatuses } from "./connector-inventory.js";
import type { ManagerStatus, ManagerStopImpact } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";
import type { ManagerParts } from "./manager-parts.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";
import { SharedPtyRuntime } from "./runtime/shared-pty.js";

// Capture the loaded package version before an installation can replace its files.
export const MANAGER_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

let machineRead: { machine?: string } | undefined;

/** This machine as status and presence name it (`machine`), or undefined when its OS identity
 *  cannot be read, as in a container without `/etc/machine-id`. Read once and said once. */
export function hostMachine(): string | undefined {
  if (!machineRead) {
    try { machineRead = { machine: managerMachineId() }; }
    catch (e) {
      machineRead = {};
      console.error(`! manager: this machine's identity could not be read, so status and presence name no machine: ${(e as Error).message}`);
    }
  }
  return machineRead.machine;
}

/** Sentinel owner-filter value that matches NO agent's `userOwner` (owner tokens never contain a
 *  dash) — what {@link Manager.psOwnerFilter} returns for an unparseable caller so a malformed
 *  principal fail-closes to an empty `ps` instead of an unbounded one. */
const NO_OWNER_MATCHES = "-no-owner-";

/** What {@link StatusAndModels} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface StatusAndModelsDeps {
  sharedLaunchHoldCount?: () => number;
  agents: () => Manager["agents"];
  ep: () => Manager["ep"];
  leaseStopping: () => Manager["leaseStopping"];
  maintenanceState: () => Manager["maintenanceState"];
  pendingWork: (...args: Parameters<Manager["pendingWork"]>) => ReturnType<Manager["pendingWork"]>;
  preservationAttemptId: () => Manager["preservationAttemptId"];
  preservationInventory: () => Manager["preservationInventory"];
  requiredRuntime: () => Manager["requiredRuntime"];
  resumeRequired: () => Manager["resumeRequired"];
  runtimeKind: () => Manager["runtimeKind"];
  classSpawnEnabled: (...args: Parameters<Manager["classSpawnEnabled"]>) => ReturnType<Manager["classSpawnEnabled"]>;
  epAdminReach: (...args: Parameters<Manager["epAdminReach"]>) => ReturnType<Manager["epAdminReach"]>;
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  forkProvenance: (...args: Parameters<Manager["forkProvenance"]>) => ReturnType<Manager["forkProvenance"]>;
  isProcessBoundSeat: (...args: Parameters<Manager["isProcessBoundSeat"]>) => ReturnType<Manager["isProcessBoundSeat"]>;
  resolveConnector: (...args: Parameters<Manager["resolveConnector"]>) => ReturnType<Manager["resolveConnector"]>;
  staticReconciliationStatus: (...args: Parameters<Manager["staticReconciliationStatus"]>) => ReturnType<Manager["staticReconciliationStatus"]>;
}

/** Builds the {@link StatusAndModelsDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function statusAndModelsDeps(m: Manager): StatusAndModelsDeps {
  return {
    agents: () => m["agents"],
    sharedLaunchHoldCount: () => m["seatLaunch"].sharedLaunchHoldCount,
    ep: () => m["ep"],
    leaseStopping: () => m["leaseStopping"],
    maintenanceState: () => m["maintenanceState"],
    pendingWork: (...args) => m["pendingWork"](...args),
    preservationAttemptId: () => m["preservationAttemptId"],
    preservationInventory: () => m["preservationInventory"],
    requiredRuntime: () => m["requiredRuntime"],
    resumeRequired: () => m["resumeRequired"],
    runtimeKind: () => m["runtimeKind"],
    classSpawnEnabled: (...args) => m["classSpawnEnabled"](...args),
    epAdminReach: (...args) => m["epAdminReach"](...args),
    executionRefusal: (...args) => m["executionRefusal"](...args),
    forkProvenance: (...args) => m["forkProvenance"](...args),
    isProcessBoundSeat: (...args) => m["isProcessBoundSeat"](...args),
    resolveConnector: (...args) => m["resolveConnector"](...args),
    staticReconciliationStatus: (...args) => m["staticReconciliationStatus"](...args),
  };
}

/** What the manager reports about itself: status, the seat list and its owner filter, local seat facts, and the model catalog. */
export class StatusAndModels {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: StatusAndModelsDeps, private readonly parts: Pick<ManagerParts, "connectorInventory" | "harnessResolution" | "seatLaunch" | "seatStop">, private readonly state: ManagerStartState) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.state.auth; }
  private get ep() { return this.deps.ep(); }
  private get leaseStopping() { return this.deps.leaseStopping(); }
  private get maintenanceState() { return this.deps.maintenanceState(); }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get preservationAttemptId() { return this.deps.preservationAttemptId(); }
  private get preservationInventory() { return this.deps.preservationInventory(); }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private get requiredRuntime() { return this.deps.requiredRuntime(); }
  private get resumeRequired() { return this.deps.resumeRequired(); }
  private get runtimeKind() { return this.deps.runtimeKind(); }
  private get userMode() { return this.state.userMode; }
  private classSpawnEnabled(...args: Parameters<Manager["classSpawnEnabled"]>): ReturnType<Manager["classSpawnEnabled"]> { return this.deps.classSpawnEnabled(...args); }
  private epAdminReach(...args: Parameters<Manager["epAdminReach"]>): ReturnType<Manager["epAdminReach"]> { return this.deps.epAdminReach(...args); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private forkProvenance(...args: Parameters<Manager["forkProvenance"]>): ReturnType<Manager["forkProvenance"]> { return this.deps.forkProvenance(...args); }
  private isProcessBoundSeat(...args: Parameters<Manager["isProcessBoundSeat"]>): ReturnType<Manager["isProcessBoundSeat"]> { return this.deps.isProcessBoundSeat(...args); }
  private resolveConnector(...args: Parameters<Manager["resolveConnector"]>): ReturnType<Manager["resolveConnector"]> { return this.deps.resolveConnector(...args); }
  private staticReconciliationStatus(...args: Parameters<Manager["staticReconciliationStatus"]>): ReturnType<Manager["staticReconciliationStatus"]> { return this.deps.staticReconciliationStatus(...args); }

  /** Return connector-provided model catalogs for selector UIs. Optional by connector: a host with no
   *  local model-list API reports `supported:false` rather than blocking the manager. A connector that
   *  fails to import shows an `error:` row (from manifest enumeration) and never blocks the others. */
  async opModels(args: Record<string, unknown>): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const requested = String(args.agent ?? "").trim();
    const refresh = args.refresh === true;
    // The spawn.env names a spawn would read now, so a catalog lists what a launch reaches. A config
    // that cannot be read fails the read, as it refuses a spawn.
    let envAllow: readonly string[] | undefined;
    try {
      envAllow = spawnEnvAllow(loadCotalConfig(this.config.workspaceRoot, isTrustedProject));
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    const one = async (connector: Connector): Promise<ConnectorModelCatalog> => {
      await this.parts.connectorInventory.refreshConnectors(connector.name, true);
      const harness = this.parts.harnessResolution.launchHarness(connector);
      if (!connector.listModels) return { agent: connector.name, supported: false, models: [] };
      if ("refusal" in harness) return { agent: connector.name, supported: true, models: [], error: harness.refusal };
      try {
        const catalog = await this.parts.harnessResolution.readCatalog(connector, harness.binaries, envAllow, refresh);
        return { agent: connector.name, supported: catalog.unavailable === undefined, ...catalog };
      } catch (e) {
        return { agent: connector.name, supported: true, models: [], error: rejectionText(e) };
      }
    };

    if (requested) {
      let connector: Connector;
      try {
        connector = await this.resolveConnector(requested);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      const result = await one(connector);
      return result.error ? { ok: false, error: result.error } : { ok: true, data: result };
    }

    // Enumerate from the manifest (published binary) so a connector that fails to import still gets
    // a row — `registry.all` can't list one that never registered. Each resolves lazily; an import
    // failure becomes an `error:` catalog row and never blocks the healthy ones.
    const catalogs = await Promise.all(
      this.parts.seatLaunch.connectorNames().map(async (name): Promise<ConnectorModelCatalog> => {
        let connector: Connector;
        try {
          connector = await this.resolveConnector(name);
        } catch (e) {
          return { agent: name, supported: false, models: [], error: rejectionText(e) };
        }
        return one(connector);
      }),
    );
    return { ok: true, data: catalogs };
  }

  /** The owner-domain bound on `ps`/`status` metadata: on a USER mesh, a privileged-tier caller
   *  sees only agents under its OWN subject-pinned owner. Two ways to see ALL owners: the admin
   *  TIER (operator), or a fresh ledger `admin` SCOPE on the caller's row — the SAME authority that
   *  lets `stop`/`attach` reach cross-owner agents ({@link authorizeNamedControl}). Without this the
   *  two surfaces disagree: an admin operator could cross-owner stop an agent it could not list.
   *  Read fresh so a revoked admin loses visibility on its next call; a read failure and an
   *  unparseable caller both fall closed (own-owner / matches-nothing). Static meshes are unbounded. */
  async psOwnerFilter(caller: EpCaller, admin: boolean): Promise<string | undefined> {
    if (!this.userMode || admin) return undefined;
    if (this.remoteAuthority) return (await this.epAdminReach(caller)) ? undefined : caller.owner;
    try {
      const scope = await resolveAuthProvider().actorScope({
        dir: userAuthStateDir(this.config.workspaceRoot, this.config.space),
        owner: caller.owner,
        actor: caller.actor,
      });
      if (scope?.includes("admin")) return undefined;
    } catch {
      /* unreadable ledger authorizes nothing extra: fall through to the own-owner bound */
    }
    return caller.owner;
  }

  /** Parent-local inventory read. It does not enter maintenance or change admission. */
  hostedSeatCount(): number {
    const runtime = this.config.execution === "runtime" ? this.requiredRuntime : undefined;
    return this.agents.size + (this.deps.sharedLaunchHoldCount?.() ?? 0) + (runtime instanceof SharedPtyRuntime ? runtime.sharedLaunchesInFlight : 0);
  }

  /** Public local-seat facts for the owning machine daemon. No mesh or secret reads. */
  hostedAgents(): { name: string; id: string; lifecycleUid: string; application: string; model?: string; cwd: string; startedAt: string; state: "running" | "exited" }[] {
    if (this.agents.size > 50) throw new Error("local agent inventory exceeds its bound");
    return [...this.agents.values()].map(a => ({
      name: a.name, id: a.id, lifecycleUid: a.lifecycleUid, application: a.agent, ...(a.launch.model ? { model: a.launch.model } : {}),
      cwd: a.launch.cwd, startedAt: new Date(a.startedAt).toISOString(), state: a.handle.status(),
    }));
  }

  /** The served manager-level health summary. Given an owner, `agentCount` counts only that owner's
   *  seats, as `ps` lists them ({@link psOwnerFilter}), so a person reading a shared Manager does not
   *  learn how many seats other owners hold on it. */
  managerStatusData(ownerFilter: string | undefined, setupClaude = false): ManagerStatus {
    this.parts.connectorInventory.refreshConnectors(undefined, setupClaude);
    const machine = hostMachine();
    return {
      instanceId: this.managerInstanceId,
      lifecycleUid: this.config.managerLifecycleUid,
      host: hostname(),
      ...(machine ? { machine } : {}),
      version: MANAGER_VERSION,
      execution: this.config.execution,
      runtime: this.runtimeKind,
      custody: this.config.execution === "none" ? "none" : this.requiredRuntime.kind === "pty" && this.requiredRuntime.supportsRelease === true ? "custodied" : "legacy",
      runHosting: this.config.execution !== "none" && (this.remoteAuthority ? this.remoteAuthority.runHosting !== undefined : !this.userMode && this.auth !== undefined),
      terminalSessions: this.config.execution !== "none",
      agentCount: ownerFilter === undefined ? this.agents.size : [...this.agents.values()].filter((a) => a.userOwner === ownerFilter).length,
      uptimeMs: Date.now() - this.config.startedAtMs,
      connectors: servedConnectorStatuses(this.parts.connectorInventory.connectorStatuses),
      classSpawn: this.classSpawnEnabled(),
      staticReconciliation: this.staticReconciliationStatus(),
      stopImpact: {
        agentScope: ownerFilter === undefined ? "manager" : "owner-filtered",
        observedAt: new Date().toISOString(),
        maintenance: this.maintenanceState,
        resumeRequired: this.resumeRequired,
        stopping: this.leaseStopping,
        ...this.deps.pendingWork(),
        agents: [...this.agents.values()]
          .filter((a) => ownerFilter === undefined || a.userOwner === ownerFilter)
          .map((a): ManagerStopImpact["agents"][number] => ({
            name: a.name,
            id: a.id,
            lifecycleUid: a.lifecycleUid,
            mode: a.handle.kind,
            defaultAction: this.maintenanceState !== "active" || this.resumeRequired
              ? "stop-retaining-state" : this.isProcessBoundSeat(a) ? "stop" : "release-custody",
            withAgentsAction: this.maintenanceState !== "active" || this.resumeRequired ? "stop-retaining-state" : "stop",
          })),
        // The same digest form `opResumePreserved` binds, so a preserved-exit stop and the later
        // resume name one inventory.
        ...(this.maintenanceState !== "active" && this.preservationAttemptId && this.preservationInventory
          ? { preservation: { attemptId: this.preservationAttemptId, inventorySha256: createHash("sha256").update(JSON.stringify(this.preservationInventory)).digest("hex") } }
          : {}),
      },
    };
  }

  /** Managed agents cross-referenced with live presence (the manager sees the roster).
   *
   *  `ownerFilter`: restrict to agents whose spawn-time stored `userOwner` equals it (the ps/status
   *  owner-domain bound); undefined = unbounded. {@link NO_OWNER_MATCHES} matches nothing. */
  list(ownerFilter?: string) {
    const records = this.ep.getRoster();
    const roster = new Map(records.map((p) => [p.card.name, p]));
    const observedAt = Date.now();
    // The roster is only evidence while THIS observer's presence watch is fresh. A stale view
    // (whole-bucket silence past TTL) or an unpopulated one (snapshot not yet replayed) cannot
    // support "offline" or "absent" for anyone: a live deployment on 2026-09-09 rendered every live seat as
    // one of those for hours after the presence stream was recreated under a still-open watch.
    // Carry the view state on the row so the renderer can say "unknown" instead of a verdict.
    // An endpoint that reports no view (test doubles built on `getRoster` alone) is read as
    // `current`: that is exactly what every row meant before the field existed.
    const view = typeof this.ep.presenceView === "function" ? this.ep.presenceView() : { state: "current" as const };
    return [...this.agents.values()].filter((a) => ownerFilter === undefined || a.userOwner === ownerFilter).map((a) => {
      // USER MODE: a detached agent's bearer-refresh death is silent everywhere except here — its
      // bearer command writes each attempt's outcome to the health file, and `ps` renders it
      // FAIL-CLOSED: a failed record is the failure + repair sentence; a missing/malformed or
      // stale record on a live agent is auth-unknown/auth-stale, NEVER silently healthy.
      const health = a.userOwner
        ? agentAuthState(a.secretPaths?.health ?? agentLifecycleSecretFilePaths(this.config.workspaceRoot, this.config.space, a.name, a.lifecycleUid).health)
        : undefined;
      // The connector-reported provider from presence (#785): the live roster card's `meta.provider`,
      // when it is a non-empty string. Absent when the connector reported none — never fabricated.
      // The seat's own record first: `set-name` may have given it another display name than its alias.
      const seen = records.find((p) => this.parts.seatStop.isOwnPresence(a, p)) ?? roster.get(a.name);
      const presenceIdentityVerified = this.parts.seatStop.isOwnPresence(a, seen);
      const providerMeta = seen?.card.meta?.provider;
      const provider = typeof providerMeta === "string" && providerMeta ? providerMeta : undefined;
      // The harness-reported condition beside the mesh status (#618): a turn that died upstream reads
      // `waiting` with `rate_limit` here, not a bare `waiting`. Absent when the connector reported none.
      // Projected field by field like `provider`: a malformed peer row must not fail this reply's schema.
      const reported = seen?.condition;
      const condition =
        reported && typeof reported.code === "string" && reported.code
          ? {
              code: reported.code,
              ...(typeof reported.source === "string" ? { source: reported.source } : {}),
              ...(typeof reported.message === "string" ? { message: reported.message } : {}),
              ...(typeof reported.since === "number" && Number.isFinite(reported.since) ? { since: reported.since } : {}),
            }
          : undefined;
      // The seat's last harness-reported work progress (#618). `ts` is only its heartbeat, so a turn
      // that stopped advancing reads as an old `activeAt` beside a live process. Absent when none was reported.
      const activeAtReported = seen?.activeAt;
      const activeAt = typeof activeAtReported === "number" && Number.isFinite(activeAtReported) ? activeAtReported : undefined;
      // How long an offline verdict has stood (#1208): the seat's last heartbeat before it went
      // offline. Only beside a verdict, since a stale or unpopulated view dates nothing, only from the
      // seat's own record, since `seen` falls back to a name match and a same-named foreign peer or an older
      // incarnation must not date this seat, and only when the seat's unvalidated `ts` fits the row
      // schema, so one odd record cannot fail the reply.
      const offlineSince = view.state === "current" && this.parts.seatStop.isOwnPresence(a, seen) && seen.status === "offline" && Number.isSafeInteger(seen.ts) && seen.ts >= 0
        ? seen.ts
        : undefined;
      return {
        name: a.name,
        // The spawned agent's id (nkey, or the user-mode principal) — lets an operator tool (e.g.
        // `cotal down -f`) match a ledger entry by name AND id before stopping, so it never stops a
        // same-named foreign agent.
        id: a.id,
        role: a.role,
        agent: a.agent,
        space: this.config.space,
        mode: a.handle.kind,
        status: a.handle.status(),
        uptimeMs: Date.now() - a.startedAt,
        mesh: seen?.status ?? "absent",
        ...(a.joinIssue ? { joinHealth: { state: "degraded" as const, reason: a.joinIssue } } : {}),
        ...(condition ? { condition } : {}),
        ...(a.startupNotice !== undefined ? { startupNotice: a.startupNotice } : {}),
        ...(activeAt !== undefined ? { activeAt } : {}),
        // `current` is the only state in which `mesh` is a verdict; the other two are the
        // observer's own condition and travel on the row (older CLIs ignore the field).
        meshView: view.state,
        presenceIdentityVerified,
        ...(view.state === "current" && presenceIdentityVerified ? { presenceObservedAt: observedAt } : {}),
        ...(offlineSince !== undefined ? { offlineSince } : {}),
        // The incarnation coordinate (SPEC 13.1) — with `id`, exactly what a v0.4 caller needs to
        // build a targeted (`despawn`/`attach`) request against THIS incarnation.
        lifecycleUid: a.lifecycleUid,
        // #651 enrichment: per-seat facts the manager ALREADY holds, carried on the row so `ps
        // --wide`/`--json` can surface them without a new collection path. All optional in the row
        // schema: a fact this backend did not record serializes absent, never fabricated (the
        // pid is absent on runtimes that do not own a real process; a launch may pin no model).
        model: a.launch.model,
        variant: a.launch.variant,
        ...(provider ? { provider } : {}),
        cwd: a.launch.cwd,
        pid: a.handle.pid,
        spawner: a.spawner,
        instanceId: this.managerInstanceId,
        host: hostname(),
        // #1500: the session a `--resume` seat forked, with its title and transcript hash once the
        // seat has recorded them.
        ...(a.launch.forkSource ? { resume: this.forkProvenance(a) ?? { source: a.launch.forkSource } } : {}),
        ...(health && health.state !== "ok" ? { authHealth: health.state, authReason: health.reason } : {}),
      };
    });
  }
}
