import { copyPersonaEndpoints, DEV_OWNER, discardLaunchArtifacts, EpEnvelopeError, identityFromCreds, idFromCreds, loadCotalConfig, modelPolicyEnv, parsePrincipalKey, principalKey, rejectionText, resolveAuthProvider } from "@cotal-ai/core";
import type { Connector, ControlReply, LaunchOpts, LaunchSpec, MeshLaunchAgent, Presence, RuntimeReference, UserAuthLaunch } from "@cotal-ai/core";
import { agentCredsDir, agentLifecycleSecretFilePaths, agentSecretFilePaths, agentSecretKeyForFile, isTrustedProject, loadTrustCheckedPersona, manifestPersonaLaunchOptionsRefusal, userAuthStateDir } from "@cotal-ai/workspace";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { sameStrings } from "./credential-renewal.js";
import { launchSpecForRun } from "./launch.js";
import type { Manager, FreeSlotCause, ManagerResumeAgent, ManagerResumeIdentity, ManagerResumeInventory, ManagerResumeResult, SupervisedRestart } from "./manager.js";
import { MAX_AGENTS, parseResumeCommitArgs, parseResumeControlArgs, parseResumeFinalizeArgs } from "./resume.js";
import { requireRuntimeReap } from "./runtime/index.js";
import type { CustodialRuntime } from "./runtime/index.js";
import type { ManagerParts } from "./manager-parts.js";
import { optInLaunchFields } from "./harness-resolution.js";
import { foreignEventChannels } from "./seat-launch.js";
import type { ManagedAgent } from "./seat-types.js";
import { ownedBySibling } from "./static-lifecycle.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";

/** Scope written by local user-mode provisioning from the persona capabilities. */
export function localUserAgentScope(capabilities: readonly string[] = []): string[] {
  return capabilities.filter((c) => c === "spawn" || c === "run" || c === "admin" || /^role:[A-Za-z0-9_-]+$/.test(c));
}

/** How often a resumed seat whose readiness was uncertain is checked for a join its predecessor's
 *  presence row hides (see {@link Manager.watchResumeAdoption}). The wait has no end of its own, so
 *  it asks less often than the readiness fence's 50 ms poll. */
const LATE_JOIN_POLL_MS = 1_000;

/** How long a resume waits for a reaped orphan's principal to leave presence. Presence rows age
 * out after their 6s TTL, so three TTLs covers a killed seat that never published its leave. */
const ORPHAN_PRESENCE_CLEAR_MS = 20_000;

/** The owner a retained seat resumes under: its inventory identity's, which is the same value the
 *  adopted seat records as `userOwner`, so a resumed seat is counted against the owner that held
 *  it before the restart ({@link NamesCapacity.ownerSeats}) and not against the mesh's default one. */
function resumeOwner(entry: ManagerResumeAgent): string {
  return entry.identity.mode === "user" ? entry.identity.owner : DEV_OWNER;
}

/** The start of every agent's bearer command: node, its loader flags and this manager's entry,
 *  resolved through every symlink. The agent runs that command for each renewal for as long as it
 *  lives, and an install can replace the bin link meanwhile: get.cotal.ai writes a shell launcher
 *  over `~/.local/bin/cotal`, which `npm i -g` had made a link to `dist/cotal.js`. */
export function bearerEntryArgv(): string[] {
  return [process.execPath, ...process.execArgv, realpathSync(process.argv[1]!)];
}

interface PreparedResume {
  spec: LaunchSpec;
  /** The retained manifest declaration says `continuity: exact`. */
  exact?: boolean;
  /** Set once the spec is handed to runtime.spawn, which owns its launch artifacts from then on. A
   *  spec never handed over is the batch's to discard. */
  spawned?: boolean;
  launchOpts: LaunchOpts;
  id?: string;
  creds?: string;
  userAuth?: UserAuthLaunch;
}

/** What {@link PreservedResume} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface PreservedResumeDeps {
  agents: () => Manager["agents"];
  ep: () => Manager["ep"];
  namesCapacity: () => Manager["namesCapacity"];
  resumeDurableCommitToken: () => Manager["resumeDurableCommitToken"];
  setResumeDurableCommitToken: (value: Manager["resumeDurableCommitToken"]) => void;
  resumeRequired: () => Manager["resumeRequired"];
  setResumeRequired: (value: Manager["resumeRequired"]) => void;
  retirement: () => Manager["retirement"];
  abortPreservation: (...args: Parameters<Manager["abortPreservation"]>) => ReturnType<Manager["abortPreservation"]>;
  armSessionRecovery: (...args: Parameters<Manager["armSessionRecovery"]>) => ReturnType<Manager["armSessionRecovery"]>;
  awaitHandleExit: (...args: Parameters<Manager["awaitHandleExit"]>) => ReturnType<Manager["awaitHandleExit"]>;
  awaitReadiness: (...args: Parameters<Manager["awaitReadiness"]>) => ReturnType<Manager["awaitReadiness"]>;
  beginLifecycle: (...args: Parameters<Manager["beginLifecycle"]>) => ReturnType<Manager["beginLifecycle"]>;
  capabilityRefusal: (...args: Parameters<Manager["capabilityRefusal"]>) => ReturnType<Manager["capabilityRefusal"]>;
  commitPreservation: (...args: Parameters<Manager["commitPreservation"]>) => ReturnType<Manager["commitPreservation"]>;
  deprovision: (...args: Parameters<Manager["deprovision"]>) => ReturnType<Manager["deprovision"]>;
  eventsRefusal: (...args: Parameters<Manager["eventsRefusal"]>) => ReturnType<Manager["eventsRefusal"]>;
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  forkProvenance: (...args: Parameters<Manager["forkProvenance"]>) => ReturnType<Manager["forkProvenance"]>;
  freeSlot: (...args: Parameters<Manager["freeSlot"]>) => ReturnType<Manager["freeSlot"]>;
  hostLaunchFields: (...args: Parameters<Manager["hostLaunchFields"]>) => ReturnType<Manager["hostLaunchFields"]>;
  inventoryReferenceError: (...args: Parameters<Manager["inventoryReferenceError"]>) => ReturnType<Manager["inventoryReferenceError"]>;
  loadSeatRuntime: (...args: Parameters<Manager["loadSeatRuntime"]>) => ReturnType<Manager["loadSeatRuntime"]>;
  maintenanceError: (...args: Parameters<Manager["maintenanceError"]>) => ReturnType<Manager["maintenanceError"]>;
  managedPrincipal: (...args: Parameters<Manager["managedPrincipal"]>) => ReturnType<Manager["managedPrincipal"]>;
  nameError: (...args: Parameters<Manager["nameError"]>) => ReturnType<Manager["nameError"]>;
  occupancy: (...args: Parameters<Manager["occupancy"]>) => ReturnType<Manager["occupancy"]>;
  preparePreservation: (...args: Parameters<Manager["preparePreservation"]>) => ReturnType<Manager["preparePreservation"]>;
  probeStaticCredential: (...args: Parameters<Manager["probeStaticCredential"]>) => ReturnType<Manager["probeStaticCredential"]>;
  readManagedSession: (...args: Parameters<Manager["readManagedSession"]>) => ReturnType<Manager["readManagedSession"]>;
  readStaticReconcileSlot: (...args: Parameters<Manager["readStaticReconcileSlot"]>) => ReturnType<Manager["readStaticReconcileSlot"]>;
  readerRemedy: (...args: Parameters<Manager["readerRemedy"]>) => ReturnType<Manager["readerRemedy"]>;
  reconcileStaticLifecycles: (...args: Parameters<Manager["reconcileStaticLifecycles"]>) => ReturnType<Manager["reconcileStaticLifecycles"]>;
  recordContinuity: (...args: Parameters<Manager["recordContinuity"]>) => ReturnType<Manager["recordContinuity"]>;
  recordContinuityAtStop: (...args: Parameters<Manager["recordContinuityAtStop"]>) => ReturnType<Manager["recordContinuityAtStop"]>;
  recordSlotCustody: (...args: Parameters<Manager["recordSlotCustody"]>) => ReturnType<Manager["recordSlotCustody"]>;
  recordSlotRuntime: (...args: Parameters<Manager["recordSlotRuntime"]>) => ReturnType<Manager["recordSlotRuntime"]>;
  refreshSeatRecord: (...args: Parameters<Manager["refreshSeatRecord"]>) => ReturnType<Manager["refreshSeatRecord"]>;
  reserveCustody: (...args: Parameters<Manager["reserveCustody"]>) => ReturnType<Manager["reserveCustody"]>;
  resolveConnector: (...args: Parameters<Manager["resolveConnector"]>) => ReturnType<Manager["resolveConnector"]>;
  retainedSessionId: (...args: Parameters<Manager["retainedSessionId"]>) => ReturnType<Manager["retainedSessionId"]>;
  runtimeFor: (...args: Parameters<Manager["runtimeFor"]>) => ReturnType<Manager["runtimeFor"]>;
  spawnCustodied: (...args: Parameters<Manager["spawnCustodied"]>) => ReturnType<Manager["spawnCustodied"]>;
  stopHandle: (...args: Parameters<Manager["stopHandle"]>) => ReturnType<Manager["stopHandle"]>;
  watchExit: (...args: Parameters<Manager["watchExit"]>) => ReturnType<Manager["watchExit"]>;
}

/** Builds the {@link PreservedResumeDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function preservedResumeDeps(m: Manager): PreservedResumeDeps {
  return {
    agents: () => m["agents"],
    ep: () => m["ep"],
    namesCapacity: () => m["namesCapacity"],
    resumeDurableCommitToken: () => m["resumeDurableCommitToken"],
    setResumeDurableCommitToken: (value) => { m["resumeDurableCommitToken"] = value; },
    resumeRequired: () => m["resumeRequired"],
    setResumeRequired: (value) => { m["resumeRequired"] = value; },
    retirement: () => m["retirement"],
    abortPreservation: (...args) => m["abortPreservation"](...args),
    armSessionRecovery: (...args) => m["armSessionRecovery"](...args),
    awaitHandleExit: (...args) => m["awaitHandleExit"](...args),
    awaitReadiness: (...args) => m["awaitReadiness"](...args),
    beginLifecycle: (...args) => m["beginLifecycle"](...args),
    capabilityRefusal: (...args) => m["capabilityRefusal"](...args),
    commitPreservation: (...args) => m["commitPreservation"](...args),
    deprovision: (...args) => m["deprovision"](...args),
    eventsRefusal: (...args) => m["eventsRefusal"](...args),
    executionRefusal: (...args) => m["executionRefusal"](...args),
    forkProvenance: (...args) => m["forkProvenance"](...args),
    freeSlot: (...args) => m["freeSlot"](...args),
    hostLaunchFields: (...args) => m["hostLaunchFields"](...args),
    inventoryReferenceError: (...args) => m["inventoryReferenceError"](...args),
    loadSeatRuntime: (...args) => m["loadSeatRuntime"](...args),
    maintenanceError: (...args) => m["maintenanceError"](...args),
    managedPrincipal: (...args) => m["managedPrincipal"](...args),
    nameError: (...args) => m["nameError"](...args),
    occupancy: (...args) => m["occupancy"](...args),
    preparePreservation: (...args) => m["preparePreservation"](...args),
    probeStaticCredential: (...args) => m["probeStaticCredential"](...args),
    readManagedSession: (...args) => m["readManagedSession"](...args),
    readStaticReconcileSlot: (...args) => m["readStaticReconcileSlot"](...args),
    readerRemedy: (...args) => m["readerRemedy"](...args),
    reconcileStaticLifecycles: (...args) => m["reconcileStaticLifecycles"](...args),
    recordContinuity: (...args) => m["recordContinuity"](...args),
    recordContinuityAtStop: (...args) => m["recordContinuityAtStop"](...args),
    recordSlotCustody: (...args) => m["recordSlotCustody"](...args),
    recordSlotRuntime: (...args) => m["recordSlotRuntime"](...args),
    refreshSeatRecord: (...args) => m["refreshSeatRecord"](...args),
    reserveCustody: (...args) => m["reserveCustody"](...args),
    resolveConnector: (...args) => m["resolveConnector"](...args),
    retainedSessionId: (...args) => m["retainedSessionId"](...args),
    runtimeFor: (...args) => m["runtimeFor"](...args),
    spawnCustodied: (...args) => m["spawnCustodied"](...args),
    stopHandle: (...args) => m["stopHandle"](...args),
    watchExit: (...args) => m["watchExit"](...args),
  };
}

/** Resuming a preserved manager: the bound inventory, validating each retained seat's authority, relaunching or adopting it, and the commit and finalize doors. */
export class PreservedResume {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: PreservedResumeDeps, private readonly parts: Pick<ManagerParts, "connectorInventory" | "harnessResolution" | "namesCapacity" | "preservation">, private readonly state: ManagerStartState) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.state.auth; }
  private get ep() { return this.deps.ep(); }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get namesCapacity() { return this.deps.namesCapacity(); }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private get resumeDurableCommitToken() { return this.deps.resumeDurableCommitToken(); }
  private set resumeDurableCommitToken(value: Manager["resumeDurableCommitToken"]) { this.deps.setResumeDurableCommitToken(value); }
  private get resumeRequired() { return this.deps.resumeRequired(); }
  private set resumeRequired(value: Manager["resumeRequired"]) { this.deps.setResumeRequired(value); }
  private get retirement() { return this.deps.retirement(); }
  private get userMode() { return this.state.userMode; }
  private abortPreservation(...args: Parameters<Manager["abortPreservation"]>): ReturnType<Manager["abortPreservation"]> { return this.deps.abortPreservation(...args); }
  private armSessionRecovery(...args: Parameters<Manager["armSessionRecovery"]>): ReturnType<Manager["armSessionRecovery"]> { return this.deps.armSessionRecovery(...args); }
  private awaitHandleExit(...args: Parameters<Manager["awaitHandleExit"]>): ReturnType<Manager["awaitHandleExit"]> { return this.deps.awaitHandleExit(...args); }
  private awaitReadiness(...args: Parameters<Manager["awaitReadiness"]>): ReturnType<Manager["awaitReadiness"]> { return this.deps.awaitReadiness(...args); }
  private beginLifecycle(...args: Parameters<Manager["beginLifecycle"]>): ReturnType<Manager["beginLifecycle"]> { return this.deps.beginLifecycle(...args); }
  private capabilityRefusal(...args: Parameters<Manager["capabilityRefusal"]>): ReturnType<Manager["capabilityRefusal"]> { return this.deps.capabilityRefusal(...args); }
  private commitPreservation(...args: Parameters<Manager["commitPreservation"]>): ReturnType<Manager["commitPreservation"]> { return this.deps.commitPreservation(...args); }
  private deprovision(...args: Parameters<Manager["deprovision"]>): ReturnType<Manager["deprovision"]> { return this.deps.deprovision(...args); }
  private eventsRefusal(...args: Parameters<Manager["eventsRefusal"]>): ReturnType<Manager["eventsRefusal"]> { return this.deps.eventsRefusal(...args); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private forkProvenance(...args: Parameters<Manager["forkProvenance"]>): ReturnType<Manager["forkProvenance"]> { return this.deps.forkProvenance(...args); }
  private freeSlot(...args: Parameters<Manager["freeSlot"]>): ReturnType<Manager["freeSlot"]> { return this.deps.freeSlot(...args); }
  private hostLaunchFields(...args: Parameters<Manager["hostLaunchFields"]>): ReturnType<Manager["hostLaunchFields"]> { return this.deps.hostLaunchFields(...args); }
  private inventoryReferenceError(...args: Parameters<Manager["inventoryReferenceError"]>): ReturnType<Manager["inventoryReferenceError"]> { return this.deps.inventoryReferenceError(...args); }
  private loadSeatRuntime(...args: Parameters<Manager["loadSeatRuntime"]>): ReturnType<Manager["loadSeatRuntime"]> { return this.deps.loadSeatRuntime(...args); }
  private maintenanceError(...args: Parameters<Manager["maintenanceError"]>): ReturnType<Manager["maintenanceError"]> { return this.deps.maintenanceError(...args); }
  private managedPrincipal(...args: Parameters<Manager["managedPrincipal"]>): ReturnType<Manager["managedPrincipal"]> { return this.deps.managedPrincipal(...args); }
  private nameError(...args: Parameters<Manager["nameError"]>): ReturnType<Manager["nameError"]> { return this.deps.nameError(...args); }
  private occupancy(...args: Parameters<Manager["occupancy"]>): ReturnType<Manager["occupancy"]> { return this.deps.occupancy(...args); }
  private preparePreservation(...args: Parameters<Manager["preparePreservation"]>): ReturnType<Manager["preparePreservation"]> { return this.deps.preparePreservation(...args); }
  private probeStaticCredential(...args: Parameters<Manager["probeStaticCredential"]>): ReturnType<Manager["probeStaticCredential"]> { return this.deps.probeStaticCredential(...args); }
  private readManagedSession(...args: Parameters<Manager["readManagedSession"]>): ReturnType<Manager["readManagedSession"]> { return this.deps.readManagedSession(...args); }
  private readStaticReconcileSlot(...args: Parameters<Manager["readStaticReconcileSlot"]>): ReturnType<Manager["readStaticReconcileSlot"]> { return this.deps.readStaticReconcileSlot(...args); }
  private readerRemedy(...args: Parameters<Manager["readerRemedy"]>): ReturnType<Manager["readerRemedy"]> { return this.deps.readerRemedy(...args); }
  private reconcileStaticLifecycles(...args: Parameters<Manager["reconcileStaticLifecycles"]>): ReturnType<Manager["reconcileStaticLifecycles"]> { return this.deps.reconcileStaticLifecycles(...args); }
  private recordContinuity(...args: Parameters<Manager["recordContinuity"]>): ReturnType<Manager["recordContinuity"]> { return this.deps.recordContinuity(...args); }
  private recordContinuityAtStop(...args: Parameters<Manager["recordContinuityAtStop"]>): ReturnType<Manager["recordContinuityAtStop"]> { return this.deps.recordContinuityAtStop(...args); }
  private recordSlotCustody(...args: Parameters<Manager["recordSlotCustody"]>): ReturnType<Manager["recordSlotCustody"]> { return this.deps.recordSlotCustody(...args); }
  private recordSlotRuntime(...args: Parameters<Manager["recordSlotRuntime"]>): ReturnType<Manager["recordSlotRuntime"]> { return this.deps.recordSlotRuntime(...args); }
  private refreshSeatRecord(...args: Parameters<Manager["refreshSeatRecord"]>): ReturnType<Manager["refreshSeatRecord"]> { return this.deps.refreshSeatRecord(...args); }
  private reserveCustody(...args: Parameters<Manager["reserveCustody"]>): ReturnType<Manager["reserveCustody"]> { return this.deps.reserveCustody(...args); }
  private resolveConnector(...args: Parameters<Manager["resolveConnector"]>): ReturnType<Manager["resolveConnector"]> { return this.deps.resolveConnector(...args); }
  private retainedSessionId(...args: Parameters<Manager["retainedSessionId"]>): ReturnType<Manager["retainedSessionId"]> { return this.deps.retainedSessionId(...args); }
  private runtimeFor(...args: Parameters<Manager["runtimeFor"]>): ReturnType<Manager["runtimeFor"]> { return this.deps.runtimeFor(...args); }
  private spawnCustodied(...args: Parameters<Manager["spawnCustodied"]>): ReturnType<Manager["spawnCustodied"]> { return this.deps.spawnCustodied(...args); }
  private stopHandle(...args: Parameters<Manager["stopHandle"]>): ReturnType<Manager["stopHandle"]> { return this.deps.stopHandle(...args); }
  private watchExit(...args: Parameters<Manager["watchExit"]>): ReturnType<Manager["watchExit"]> { return this.deps.watchExit(...args); }

  private resumeCommitted = false;
  private resumeFinalized = false;
  private resumeInventory?: ManagerResumeInventory;
  private resumeCommitTask?: Promise<ControlReply>;
  private resumeInventoryDigest?: string;
  private resumeTask?: Promise<ManagerResumeResult>;
  private resumeResult?: ManagerResumeResult;
  private readonly resumedAgentNames = new Set<string>();
  private resumeAwaitingCommit = false;

  resumeEntry(a: ManagedAgent, backfillFloor?: number): ManagerResumeAgent {
    // A preservation cut is a stop boundary too, so a manifest launch after it reopens what a resume would.
    this.recordContinuityAtStop(a, "preservation");
    return this.resumeEntryOf(a, backfillFloor);
  }

  /** The resume entry of one live seat, with no side effect: a preservation cut and a supervised
   *  seat's record both build it. The entry is its own copy, so a caller's write to the plan it was
   *  handed cannot change the launch the manager keeps supervising (#3241). */
  resumeEntryOf(a: ManagedAgent, backfillFloor?: number): ManagerResumeAgent {
    const principal = a.userOwner
      ? parsePrincipalKey(a.id)
      : { owner: DEV_OWNER, actor: a.id };
    if (!principal) throw new Error(`managed agent ${a.name} has an invalid principal ${a.id}`);
    // The RECORDED secret-family paths (set at spawn or adoption) — never a re-derivation by name:
    // under mixed generations (a name-keyed pre-split incarnation adopted by this manager) the
    // recorded path is the only truth, and re-deriving would preserve a family that isn't there.
    const files = a.secretPaths;
    const identity: ManagerResumeIdentity = a.userOwner
      ? (() => {
          if (!files?.actorToken || !files.sentinelCreds || !files.health)
            throw new Error(`managed agent ${a.name} is user-mode but its secret-family paths were not recorded`);
          return {
            mode: "user" as const,
            owner: principal.owner,
            actor: principal.actor,
            lifecycleUid: a.lifecycleUid,
            actorToken: { kind: "file" as const, path: files.actorToken, sha256: this.parts.preservation.fileDigestOrEmpty(files.actorToken) },
            sentinelCredential: { kind: "file" as const, path: files.sentinelCreds, sha256: this.parts.preservation.fileDigestOrEmpty(files.sentinelCreds) },
            health: { kind: "file" as const, path: files.health },
          };
        })()
      : this.auth
        ? (() => {
            if (!files?.creds)
              throw new Error(`managed agent ${a.name} is static-auth but its credential path was not recorded`);
            return { mode: "static" as const, id: principal.actor, lifecycleUid: a.lifecycleUid, credential: { kind: "file" as const, path: files.creds, sha256: this.parts.preservation.fileDigestOrEmpty(files.creds) }, ...(a.issued ? { issued: a.issued } : {}) };
          })()
        : { mode: "open", id: principal.actor, lifecycleUid: a.lifecycleUid };
    const dependencies = [a.launch.source.configPath];
    if (a.launch.source.kind === "manifest" && a.launch.source.runId)
      dependencies.unshift(join(this.config.workspaceRoot, ".cotal", "run", `${a.launch.source.runId}.json`));
    return structuredClone({
      space: this.config.space,
      name: a.name,
      ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
      role: a.role,
      identity,
      launch: {
        connector: a.agent,
        runtime: a.handle.kind,
        cwd: a.launch.cwd,
        source: a.launch.source,
        model: a.launch.model,
        variant: a.launch.variant,
        ...(a.launch.modes ? { modes: a.launch.modes } : {}),
        subscribe: a.launch.subscribe,
        allowSubscribe: a.launch.allowSubscribe,
        allowPublish: a.launch.allowPublish,
        capabilities: a.launch.capabilities,
        ...(a.launch.endpoints?.length ? { endpoints: copyPersonaEndpoints(a.launch.endpoints) } : {}),
        events: a.launch.events,
        eventPayloads: a.launch.eventPayloads,
        ...optInLaunchFields(a.launch),
        shareTools: a.launch.shareTools,
        forkSource: a.launch.forkSource,
        ...(this.forkProvenance(a) ? { resumed: this.forkProvenance(a) } : {}),
        // A supervised seat whose connector keeps no session state is armed with no state file to read.
        sessionId: a.restart?.armed && a.restart.sessionStatePath ? this.readManagedSession(a) : a.launch.sessionId,
        // Additive and only when the connector supplied one. A seat with no pointer records no
        // field, which is what keeps an older inventory and a fresh one the same document shape.
        ...(a.restart?.sessionStatePath ? { sessionStatePath: a.restart.sessionStatePath } : {}),
        unresolvedLaunchOptionKeys: a.launch.unresolvedLaunchOptionKeys,
      },
      dependencies,
      spawner: a.spawner,
      authorityParent: a.authorityParent,
      startedAt: new Date(a.startedAt).toISOString(),
      ...(backfillFloor !== undefined ? { backfillFloor } : {}),
    });
  }

  async opFinalizeResume(rawArgs: unknown): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    {
      let args: { attemptId: string; durableCommitToken: string };
      try {
        args = parseResumeFinalizeArgs(rawArgs);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      if (!this.config.resumeAttemptId || this.config.resumeAttemptId !== args.attemptId)
        return { ok: false, error: `manager expects resume attempt ${this.config.resumeAttemptId ?? "<none>"}, not ${args.attemptId}` };
      if (!this.resumeCommitted || !this.resumeDurableCommitToken)
        return { ok: false, error: `resume attempt ${args.attemptId} has no successful commit to finalize` };
      if (this.resumeDurableCommitToken !== args.durableCommitToken)
        return { ok: false, error: `resume attempt ${args.attemptId} durable commit token does not match` };
      if (this.resumeFinalized) return { ok: true, data: { attemptId: args.attemptId, state: "active" } };
      const inventory = this.resumeInventory;
      if (!inventory)
        return { ok: false, error: `resume attempt ${args.attemptId} has no bound inventory` };
      let inactive: string[];
      try {
        inactive = this.resumeLivenessErrors(inventory, this.ep.getRoster());
      } catch (e) {
        return { ok: false, error: `resume attempt ${args.attemptId} cannot verify live principals at finalize: ${rejectionText(e)}` };
      }
      if (inactive.length)
        return { ok: false, error: `resume attempt ${args.attemptId} is not live at finalize: ${inactive.join("; ")}` };
      for (const entry of this.resumeInventory?.agents ?? []) {
        const managed = this.agents.get(entry.name);
        if (managed) managed.suppressCleanup = false;
      }
      // distsys/security CONDITIONAL @ 9e13648: the boot sweep DEFERRED every active
      // slot while a resume was pending (it could not know which would be adopted). Now adoption
      // is complete and `this.agents` is EXACTLY the adopted set, so re-sweep to terminalize any
      // active slot the resume did NOT claim — a durable ACTIVE ORPHAN (crashed after slot->active
      // before agents.set, then not in the resumed inventory). This runs while `resumeRequired` is
      // still true, so no ordinary spawn can race it (beginLifecycle refuses non-resume ops), and
      // it closes both the alias wedge AND the membership-gate gap (the orphan's principal enters
      // retiredPrincipals, so a copied JWT is refused). Best-effort + loud: a sweep failure must
      // not fail the finalize (the next non-resume boot re-drives it), but it is never swallowed.
      if (this.auth && !this.userMode)
        await this.reconcileStaticLifecycles(true).catch((e) => console.error(`! post-resume static reconcile: ${rejectionText(e)} - no per-alias retry could be planned; a later manager start re-reads unfinished durable terminals`));
      this.resumeFinalized = true;
      this.resumeRequired = false;
      return { ok: true, data: { attemptId: args.attemptId, state: "active" } };
    }
  }

  async opCommitResume(rawArgs: unknown): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    {
      let attemptId: string;
      try {
        attemptId = parseResumeCommitArgs(rawArgs).attemptId;
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      if (!this.config.resumeAttemptId || this.config.resumeAttemptId !== attemptId)
        return { ok: false, error: `manager expects resume attempt ${this.config.resumeAttemptId ?? "<none>"}, not ${attemptId}` };
      if (this.resumeCommitted)
        return {
          ok: true,
          data: {
            attemptId,
            state: this.resumeFinalized ? "active" : "awaitingFinalize",
            durableCommitToken: this.resumeDurableCommitToken,
          },
        };
      if (this.resumeCommitTask) return this.resumeCommitTask;
      const task = this.commitResumeActivation(attemptId);
      this.resumeCommitTask = task;
      try {
        return await task;
      } finally {
        if (this.resumeCommitTask === task) this.resumeCommitTask = undefined;
      }
    }
  }

  async opResumePreserved(rawArgs: unknown): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    {
      try {
        const args = parseResumeControlArgs(rawArgs);
        const inventoryDigest = createHash("sha256").update(JSON.stringify(args.inventory)).digest("hex");
        if (!this.config.resumeAttemptId)
          return { ok: false, error: "resumePreserved requires a manager started with --resume-attempt" };
        if (this.config.resumeAttemptId !== args.attemptId)
          return { ok: false, error: `manager expects resume attempt ${this.config.resumeAttemptId}, not ${args.attemptId}` };
        if (this.resumeInventoryDigest && this.resumeInventoryDigest !== inventoryDigest)
          return { ok: false, error: `resume attempt ${args.attemptId} is already bound to a different inventory` };
        if (!this.resumeInventoryDigest) {
          this.resumeInventoryDigest = inventoryDigest;
          this.resumeInventory = args.inventory;
        }
        if (!this.resumeTask && !this.resumeResult) {
          this.resumeTask = this.resumePreserved(args.inventory).then((result) => {
            if (result.ok || this.resumedAgentNames.size > 0) this.resumeResult = result;
            return result;
          }).finally(() => {
            this.resumeTask = undefined;
          });
        }
        const result = this.resumeResult ?? await this.resumeTask!;
        const data = { attemptId: args.attemptId, state: result.ok ? "awaitingCommit" : "degraded", ...result };
        return result.ok
          ? { ok: true, data }
          : { ok: false, data, error: result.error ?? "retained-agent resume failed" };
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
  }

  async opPreservationCtl(op: string, rawArgs: unknown): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.resumeRequired) return { ok: false, error: this.maintenanceError() };
    const attemptId = String((rawArgs as Record<string, unknown> | undefined)?.attemptId ?? "").trim();
    if (!attemptId) return { ok: false, error: `${op} requires attemptId` };
    try {
      if (op === "abortPreservation") {
        this.abortPreservation(attemptId);
        return { ok: true, data: { attemptId, state: "active" } };
      }
      const result = op === "preparePreservation"
        ? await this.preparePreservation(attemptId)
        : await this.commitPreservation(attemptId);
      return result.ok
        ? { ok: true, data: result }
        : {
            ok: false,
            data: result,
            error: `preservation incomplete: ${result.failures.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
          };
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
  }

  private async commitResumeActivation(attemptId: string): Promise<ControlReply> {
    if (!this.resumeAwaitingCommit || !this.resumeResult?.ok)
      return { ok: false, error: `resume attempt ${attemptId} has no successful activation to commit` };
    const inventory = this.resumeInventory;
    if (!inventory)
      return { ok: false, error: `resume attempt ${attemptId} has no bound inventory` };
    const authority = await Promise.all(inventory.agents.map(async (entry) => {
      try {
        await this.validateRetainedAuthority(entry);
        return undefined;
      } catch (e) {
        return `${entry.name}: ${rejectionText(e)}`;
      }
    }));
    const drift = authority.filter((error): error is string => error !== undefined);
    if (drift.length)
      return { ok: false, error: `resume attempt ${attemptId} retained authority changed before commit: ${drift.join("; ")}` };
    let inactive: string[];
    try {
      inactive = this.resumeLivenessErrors(inventory, this.ep.getRoster());
    } catch (e) {
      return { ok: false, error: `resume attempt ${attemptId} cannot verify live principals: ${rejectionText(e)}` };
    }
    if (inactive.length)
      return { ok: false, error: `resume attempt ${attemptId} is not live at commit: ${inactive.join("; ")}` };
    this.resumeAwaitingCommit = false;
    this.resumeCommitted = true;
    this.resumeDurableCommitToken ??= randomBytes(32).toString("hex");
    return {
      ok: true,
      data: { attemptId, state: "awaitingFinalize", durableCommitToken: this.resumeDurableCommitToken },
    };
  }

  private resumeLivenessErrors(inventory: ManagerResumeInventory, roster: Presence[]): string[] {
    const inactive: string[] = [];
    const expectedNames = new Set(inventory.agents.map((entry) => entry.name));
    for (const name of this.resumedAgentNames)
      if (!expectedNames.has(name)) inactive.push(`${name} is not part of the bound inventory`);
    for (const entry of inventory.agents) {
      const managed = this.agents.get(entry.name);
      if (!managed) {
        inactive.push(`${entry.name} is no longer managed`);
        continue;
      }
      const expectedId = entry.identity.mode === "user"
        ? principalKey(entry.identity.owner, entry.identity.actor).key
        : entry.identity.id;
      const expectedPrincipal = entry.identity.mode === "user"
        ? expectedId
        : principalKey(DEV_OWNER, entry.identity.id).key;
      if (managed.id !== expectedId || this.managedPrincipal(managed) !== expectedPrincipal) {
        inactive.push(`${entry.name} no longer holds retained principal ${expectedPrincipal}`);
        continue;
      }
      // The late paths (commit/finalize) must prove the SAME incarnation the incarnation-exact
      // readiness fence proved (§13.1): a principal-only match lets a wrong/absent-uid presence under
      // the reused alias satisfy commit/finalize after a readiness timeout, undoing the fence.
      if (managed.lifecycleUid !== entry.identity.lifecycleUid) {
        inactive.push(`${entry.name} manager metadata incarnation ${managed.lifecycleUid} drifted from the inventory's ${entry.identity.lifecycleUid}`);
        continue;
      }
      if (managed.handle.name !== entry.name || managed.handle.kind !== entry.launch.runtime) {
        inactive.push(`${entry.name} is not attached to its exact retained ${entry.launch.runtime} handle`);
        continue;
      }
      try {
        if (managed.handle.status() !== "running") {
          inactive.push(`${entry.name} runtime is not running`);
          continue;
        }
      } catch (e) {
        inactive.push(`${entry.name} runtime status failed: ${rejectionText(e)}`);
        continue;
      }
      // The principal and lifecycle name the incarnation. `card.name` is display data that `set-name`
      // changes, so it proves nothing here.
      if (!roster.some((presence) =>
        presence.card.id === expectedPrincipal && presence.status !== "offline" &&
        presence.lifecycleUid === entry.identity.lifecycleUid))
        inactive.push(`${entry.name} incarnation ${entry.identity.lifecycleUid} (principal ${expectedPrincipal}) is not exactly present`);
    }
    return inactive;
  }

  /** Preflight the whole inventory before launching its first process, then adopt each exact retained
   * principal without provisioning. A later runtime launch failure is reported per-agent, but malformed
   * or missing inventory material can never produce a partially resumed set. */
  async resumePreserved(
    inventory: ManagerResumeInventory,
  ): Promise<ManagerResumeResult> {
    if (this.config.execution === "none")
      return { ok: false, agents: [], error: this.executionRefusal() };
    const release = this.beginLifecycle(true);
    if (!release) return { ok: false, agents: [], error: this.maintenanceError() };
    const batchReservations: string[] = [];
    const prepared = new Map<string, PreparedResume>();
    try {
      if (inventory.version !== "cotal-manager-resume/v2")
        return { ok: false, agents: [], error: `unsupported manager resume inventory version ${String(inventory.version)}` };
      if (inventory.space !== this.config.space)
        return { ok: false, agents: [], error: `resume inventory belongs to space "${inventory.space}", not "${this.config.space}"` };
      // The caller keeps its inventory, so it is copied before the first await: a later write to it
      // cannot change what a resumed seat launches with or what the next preservation retains.
      const entries = structuredClone(inventory.agents);
      const seen = new Set<string>();
      const principals = new Set<string>();
      const orphans: Array<{ principal: string; reference: RuntimeReference }> = [];
      await this.ep.waitForPresenceSnapshot();
      const liveRoster = this.ep.getRoster().filter((presence) => presence.status !== "offline");
      const occupancy = this.occupancy();
      if (occupancy.used + entries.length > MAX_AGENTS)
        return { ok: false, agents: [], error: `resume inventory of ${entries.length} would exceed manager capacity (${this.parts.namesCapacity.occupancyText(occupancy)})` };
      for (const entry of entries) {
        if (seen.has(entry.name))
          return { ok: false, agents: [], error: `resume inventory contains duplicate agent name "${entry.name}"` };
        seen.add(entry.name);
        // A manager-local retirement hold is stronger and more precise than presence. The stopped
        // predecessor can remain roster-live until its TTL/offline update lands, but that stale row
        // must not hide the durable teardown state the manager already owns. Refuse and re-drive the
        // exact held lifecycle before consulting generic principal liveness. A confirmed terminal has
        // already removed the hold, so fresh-lifecycle resume still reaches the fail-closed roster gate.
        const held = this.retirement.held(entry.name);
        if (held) {
          void this.deprovision(held.target).catch(() => {});
          return {
            ok: false,
            agents: [],
            error: `retained agent "${entry.name}" is reserved pending retirement: its previous lifecycle ${held.target.lifecycleUid} still owns the alias${held.lastError ? ` (last attempt: ${held.lastError})` : ""}; retrying re-drives that exact teardown`,
          };
        }
        let principal: string;
        try {
          principal = entry.identity.mode === "user"
            ? principalKey(entry.identity.owner, entry.identity.actor).key
            : principalKey(DEV_OWNER, entry.identity.id).key;
        } catch (e) {
          return { ok: false, agents: [], error: `invalid retained principal for ${entry.name}: ${rejectionText(e)}` };
        }
        if (principals.has(principal))
          return { ok: false, agents: [], error: `resume inventory contains duplicate principal "${principal}"` };
        principals.add(principal);
        const confirmedPredecessor = this.retirement.predecessor(entry.name);
        const principalIsLive = liveRoster.some((presence) => {
          if (presence.card.id !== principal) return false;
          return confirmedPredecessor === undefined ||
            confirmedPredecessor.principal !== principal ||
            confirmedPredecessor.lifecycleUid !== presence.lifecycleUid ||
            entry.identity.lifecycleUid === confirmedPredecessor.lifecycleUid;
        });
        if (principalIsLive) {
          const orphan = await this.orphanedResumeSeat(entry, principal, liveRoster);
          if (!orphan)
            return { ok: false, agents: [], error: `retained principal "${principal}" is already live and this runtime cannot authoritatively adopt it` };
          orphans.push({ principal, reference: orphan });
        }
        if (this.agents.has(entry.name) || this.namesCapacity.isReserved(entry.name))
          return { ok: false, agents: [], error: `retained agent "${entry.name}" is already managed or reserved` };
      }
      for (const entry of entries) {
        this.namesCapacity.reserve(entry.name, resumeOwner(entry));
        batchReservations.push(entry.name);
      }
      const preflight: Array<{ name: string; reply: ControlReply }> = [];
      for (const entry of entries) {
        const reply = await this.resumePreservedAgent(entry, true, true, prepared);
        preflight.push({ name: entry.name, reply });
      }
      const preflightFailures = preflight.filter(({ reply }) => !reply.ok);
      if (preflightFailures.length)
        return {
          ok: false,
          agents: preflight,
          error: `${preflightFailures.length} retained agent${preflightFailures.length === 1 ? "" : "s"} failed preflight: ${preflightFailures.map(({ name, reply }) => `${name}: ${reply.error ?? "preflight failed"}`).join("; ")}`,
        };
      // Only now, with the whole inventory through preflight, is an orphan reaped: a refused batch
      // leaves every seat as it found it.
      for (const { principal, reference } of orphans) {
        const refusal = await this.reapOrphanedResumeSeat(principal, reference);
        if (refusal) return { ok: false, agents: [], error: refusal };
      }
      const agents: Array<{ name: string; reply: ControlReply }> = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const reply = await this.resumePreservedAgent(entry, false, true, prepared);
        agents.push({ name: entry.name, reply });
        if (!reply.ok) {
          for (const skipped of entries.slice(i + 1))
            agents.push({ name: skipped.name, reply: { ok: false, error: `not launched because ${entry.name} failed` } });
          return { ok: false, agents, error: reply.error };
        }
      }
      if (this.config.resumeAttemptId) this.resumeAwaitingCommit = true;
      return { ok: true, agents };
    } finally {
      for (const name of batchReservations) {
        this.namesCapacity.release(name);
      }
      // Preflight builds every launch before any child starts, so a refused batch, a failed launch,
      // or the agents skipped after it leave built specs no runtime ever received.
      for (const { spec, spawned } of prepared.values()) {
        if (spawned) continue;
        try {
          discardLaunchArtifacts(spec.artifacts);
        } catch (e) {
          console.error(`! resume: ${rejectionText(e)}`);
        }
      }
      release();
    }
  }

  /** Re-read every retained identity input and its current authority without provisioning. This runs
   * during whole-inventory preflight, immediately before each individual spawn, and at commit. */
  async validateRetainedAuthority(
    entry: ManagerResumeAgent,
  ): Promise<Pick<PreparedResume, "id" | "creds" | "userAuth">> {
    const referenceError = this.inventoryReferenceError(entry);
    if (referenceError) throw new Error(`retained agent ${entry.name}: ${referenceError}`);
    // THE OWN-CHANNEL RULE, ON THE RESUME DOOR, and it belongs here rather than beside the launch
    // because BOTH resume paths funnel through this function and neither may skip it.
    //
    // A resume document is admin-supplied JSON. It carries the ACLs the managed row is re-armed
    // from, and `renewManagedStaticCred` re-mints the credential out of that row at half TTL, so a
    // foreign event channel written into an inventory becomes a minted read on another agent's tool
    // inputs and outputs one renewal later. In static mode nothing else stops it: the checks below
    // pin the credential's PATH, its IDENTITY and the broker's acceptance of it, and say nothing at
    // all about its ACL. User mode compares the adopted authority's ACL against the inventory's, so
    // it refuses a divergence on both fields already, but it refuses it as DRIFT rather than as this
    // rule, and an inventory whose record and credential agree with each other and disagree with
    // this rule is exactly the document an operator would not notice.
    //
    // Refuses rather than strips. Silently narrowing an admin document would leave the operator
    // holding a record that says one thing and a mesh that does another, and the whole reason this
    // is reachable is that nobody reads the record.
    {
      const owner = entry.identity.mode === "user" ? entry.identity.owner : DEV_OWNER;
      // The ACTOR HALF IS THE PRINCIPAL, never the display name. In user mode the row this
      // document re-arms is keyed by `identity.actor` (it is what the provider adopts below and
      // what every liveness check reads), and an inventory supplies `name` and `identity.actor`
      // independently, so judging the channel against `name` would judge it against the half that
      // does not own the plane.
      const actor = entry.identity.mode === "user" ? entry.identity.actor : entry.identity.id;
      const foreign = foreignEventChannels(
        [...(entry.launch.allowSubscribe ?? []), ...(entry.launch.allowPublish ?? [])],
        owner,
        actor,
      );
      if (foreign.length)
        throw new Error(
          `retained agent ${entry.name}: its record claims another agent's event channel ` +
            `(${foreign.join(", ")}). An agent may hold its OWN event plane and no other, because that ` +
            `plane carries the session's tool inputs and outputs. Remove it from the inventory and ` +
            `grant the reader out of band instead: ` +
            `${this.readerRemedy(owner, foreign[0]!)}`,
        );
    }
    if (entry.identity.mode === "open") {
      if (this.auth || this.userMode)
        throw new Error(`retained agent ${entry.name} is open-mode but the current manager is authenticated`);
      return { id: entry.identity.id };
    }
    if (entry.identity.mode === "static") {
      if (!this.auth || this.userMode)
        throw new Error(`retained agent ${entry.name} is static-auth but the current manager is not`);
      // CLOSED candidate set, not an open path: the lifecycle-keyed derivation (this generation's
      // layout) or the name-keyed one (a pre-split inventory being carried across the upgrade).
      // Anything else is a foreign path and refused exactly as before.
      const candidates = [
        resolve(agentLifecycleSecretFilePaths(this.config.workspaceRoot, this.config.space, entry.name, entry.identity.lifecycleUid).creds),
        resolve(agentSecretFilePaths(this.config.workspaceRoot, this.config.space, entry.name).creds),
      ];
      const expected = resolve(entry.identity.credential.path);
      if (!candidates.includes(expected))
        throw new Error(`retained credential reference for ${entry.name} is not a manager-owned path (expected ${candidates.join(" or ")})`);
      let credentialText: string;
      try {
        // The lstat guards the FS MATERIALIZATION the child will read at launch; the identity check
        // runs on the store's value — the source of truth (byte-identical here, the local FS
        // composition resolves the key to this same path).
        const st = lstatSync(expected);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular non-symlink file");
        const stored = await this.config.secrets.get(agentSecretKeyForFile(expected, this.config.space));
        if (stored === undefined) throw new Error("the credential is not in the secret store");
        credentialText = stored;
        const actual = idFromCreds(credentialText);
        if (actual !== entry.identity.id)
          throw new Error(`retained credential identity ${actual} does not match inventory principal ${entry.identity.id}`);
      } catch (e) {
        throw new Error(`retained credential for ${entry.name} is unusable: ${rejectionText(e)}`);
      }
      const accepted = await this.probeStaticCredential(credentialText);
      if (!accepted.ok)
        throw new Error(`retained credential for ${entry.name} is not accepted by the current broker (${accepted.reason})`);
      return { id: entry.identity.id, creds: expected };
    }
    if (!this.userMode)
      throw new Error(`retained agent ${entry.name} is user-auth but the current manager is not`);
    try {
      const provider = resolveAuthProvider();
      // Mirror the static branch's expected-path discipline, but pin the WHOLE secret FAMILY as ONE
      // unit: all three of {actorToken, sentinelCreds, health} must equal the lifecycle-keyed triple
      // (this generation) OR the name-keyed triple (a pre-split inventory carried across the upgrade).
      // A per-file OR-pin let a corrupt inventory MIX families (lifecycle token + legacy sentinel)
      // and, worse, left `health` UNPINNED entirely — an arbitrary recorded health path flowed into
      // the bearer argv and was `rmSync`'d at terminal teardown (inventory-as-delete-gadget). Pinning
      // the atomic family closes both: `health` is pinned by PATH EQUALITY (never by file existence,
      // so a transiently-absent health file still validates), and the store reads below key off the
      // RECORDED path, so a foreign path can neither pass the pin nor address a different row.
      // Both triples are derived under THIS manager's space, and the key builder is given
      // `this.config.space` rather than reading the segment out of the recorded path: an inventory row is
      // caller data, and a recorded path may not choose which tenant's material is addressed.
      const lifecycleFiles = agentLifecycleSecretFilePaths(this.config.workspaceRoot, this.config.space, entry.name, entry.identity.lifecycleUid);
      const legacyFiles = agentSecretFilePaths(this.config.workspaceRoot, this.config.space, entry.name);
      const recordedToken = resolve(entry.identity.actorToken.path);
      const recordedSentinel = resolve(entry.identity.sentinelCredential.path);
      const recordedHealth = resolve(entry.identity.health.path);
      const matchesFamily = (f: { actorToken: string; sentinelCreds: string; health: string }): boolean =>
        recordedToken === resolve(f.actorToken) && recordedSentinel === resolve(f.sentinelCreds) && recordedHealth === resolve(f.health);
      if (!matchesFamily(lifecycleFiles) && !matchesFamily(legacyFiles))
        throw new Error(`retained identity references for ${entry.name} are not one manager-owned secret family: all of actor-token, sentinel, and health must be the lifecycle-<uid> triple or the legacy name-keyed triple under ${agentCredsDir(this.config.workspaceRoot, this.config.space)} (no mixed families, no foreign health path)`);
      const secrets = this.config.secrets;
      const actorToken = await secrets.get(agentSecretKeyForFile(recordedToken, this.config.space));
      const sentinelCreds = await secrets.get(agentSecretKeyForFile(recordedSentinel, this.config.space));
      if (actorToken === undefined || sentinelCreds === undefined)
        throw new Error("the retained actor token / sentinel credential is not in the secret store");
      const adopted = this.remoteAuthority
        ? await this.remoteAuthority.validateRetainedAgent({
            owner: entry.identity.owner,
            actor: entry.identity.actor,
            lifecycleUid: entry.identity.lifecycleUid,
            actorToken,
            sentinelCreds,
          })
        : await provider.validateRetainedAgent({
            store: secrets,
            dir: userAuthStateDir(this.config.workspaceRoot, this.config.space),
            space: this.config.space,
            owner: entry.identity.owner,
            actor: entry.identity.actor,
            actorToken,
            sentinelCreds,
          });
      if (adopted.owner !== entry.identity.owner || adopted.actor !== entry.identity.actor)
        throw new Error(`auth provider returned a replacement principal; expected ${entry.identity.owner}.${entry.identity.actor}`);
      // Bind the inventory's uid to the CURRENT authority row BEFORE any spawn: a corrupt or
      // admin-supplied inventory naming a different incarnation is refused at pre-effect validation,
      // never left to broker-fail after the child is already running (SPEC §13.1).
      if (adopted.lifecycleUid !== entry.identity.lifecycleUid)
        throw new Error(`retained user authority for ${entry.identity.owner}.${entry.identity.actor} is incarnation ${adopted.lifecycleUid}, not the inventory's ${entry.identity.lifecycleUid}; a resume binds the exact recovered uid before any spawn (SPEC 13.1)`);
      const capabilities = entry.launch.capabilities;
      // Local inventories carry persona capabilities, while the local ledger records only the
      // scope derived from them. Hosted authorities can grant the full capability list.
      const scopeMatches = sameStrings(adopted.scope, capabilities) ||
        (!this.remoteAuthority && sameStrings(adopted.scope, localUserAgentScope(capabilities)));
      if (!sameStrings(adopted.allowSubscribe, entry.launch.allowSubscribe) ||
          !sameStrings(adopted.allowPublish, entry.launch.allowPublish) ||
          !scopeMatches ||
          adopted.role !== entry.role || adopted.parent !== entry.authorityParent)
        throw new Error(`retained user authority for ${entry.identity.owner}.${entry.identity.actor} no longer matches the inventory`);
      return {
        userAuth: {
          owner: entry.identity.owner,
          actor: entry.identity.actor,
          sentinelCredsPath: entry.identity.sentinelCredential.path,
          bearerCmd: [
            ...bearerEntryArgv(),
            provider.agentBearerCommand,
            ...(this.remoteAuthority
              ? ["--exchange-url", this.remoteAuthority.agentBearerExchangeUrl]
              : ["--dir", userAuthStateDir(this.config.workspaceRoot, this.config.space)]),
            "--space", this.config.space,
            "--owner", entry.identity.owner,
            "--actor", entry.identity.actor,
            "--token-file", entry.identity.actorToken.path,
            "--health-file", entry.identity.health.path,
          ],
        },
      };
    } catch (e) {
      throw new Error(`retained user principal ${entry.identity.owner}.${entry.identity.actor} could not be reused: ${rejectionText(e)}`);
    }
  }

  /** The seat reference behind a live retained principal, when that seat is provably one a lost
   *  manager of this logical instance launched for this exact incarnation. The resume binds the
   *  launched handle's reference to the incarnation's active slot before it waits for readiness, and
   *  the coordinator journals `resume-active` only after that wait, so a coordinator crash between the
   *  two leaves `resume-intent` behind a live seat. Undefined for everything else, which stays refused:
   *  another incarnation's presence, a slot another instance owns, a runtime that cannot reap the
   *  reference, and user or open meshes, which keep no slot. */
  private async orphanedResumeSeat(entry: ManagerResumeAgent, principal: string, liveRoster: Presence[]): Promise<RuntimeReference | undefined> {
    if (!this.auth || this.userMode || entry.identity.mode !== "static") return undefined;
    const runtime = this.runtimeFor(entry.launch.runtime);
    if (typeof (runtime as Partial<CustodialRuntime>).reap !== "function") return undefined;
    if (liveRoster.some((p) => p.card.id === principal && p.lifecycleUid !== entry.identity.lifecycleUid)) return undefined;
    const slot = await this.readStaticReconcileSlot(entry.name);
    if (slot?.phase !== "active" || slot.actor !== entry.identity.id || slot.lifecycleUid !== entry.identity.lifecycleUid) return undefined;
    if (ownedBySibling(slot, this.managerInstanceId)) return undefined;
    return slot.runtime?.kind === runtime.kind ? slot.runtime : undefined;
  }

  /** Reap a seat {@link orphanedResumeSeat} found, then wait for its principal to leave presence so
   *  the relaunch's readiness cannot match the dead seat's row. Returns the refusal when the reap
   *  proves nothing or the principal stays live, which means another process holds it. */
  private async reapOrphanedResumeSeat(principal: string, reference: RuntimeReference): Promise<string | undefined> {
    try {
      const evidence = await requireRuntimeReap(this.runtimeFor(reference.kind), reference);
      console.error(`resume: reaped orphaned seat ${reference.kind}:${reference.id} of retained principal "${principal}" (${evidence.detail})`);
    } catch (e) {
      return `retained principal "${principal}" is already live and its recorded seat ${reference.kind}:${reference.id} could not be reaped: ${rejectionText(e)}`;
    }
    const deadline = Date.now() + ORPHAN_PRESENCE_CLEAR_MS;
    while (this.ep.getRoster().some((p) => p.card.id === principal && p.status !== "offline")) {
      if (Date.now() >= deadline)
        return `retained principal "${principal}" is still live after its recorded seat ${reference.kind}:${reference.id} was reaped, so another process holds it and this runtime cannot authoritatively adopt it`;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    return undefined;
  }

  /** Re-verify retained authority and connector executable availability before launching a prepared
   *  batch entry across earlier seats' sequential readiness waits. */
  private async recheckPreparedResume(entry: ManagerResumeAgent): Promise<string | undefined> {
    let connector: Connector;
    try {
      await this.validateRetainedAuthority(entry);
      connector = await this.resolveConnector(entry.launch.connector);
    } catch (e) {
      return rejectionText(e);
    }
    await this.parts.connectorInventory.refreshConnectors(connector.name, true);
    const harness = this.parts.harnessResolution.launchHarness(connector);
    return "refusal" in harness ? harness.refusal : undefined;
  }

  /** Validate/relaunch one retained inventory entry. Called through resumePreserved so all records
   * pass the same preflight before the first child is exposed, and through restartSupervisedSeat
   * with the one record a crashed manager left (`supervised`). */
  async resumePreservedAgent(
    entry: ManagerResumeAgent,
    preflightOnly = false,
    batchReserved = false,
    prepared?: Map<string, PreparedResume>,
    supervised?: SupervisedRestart,
  ): Promise<ControlReply> {
    if (this.config.execution === "none") return { ok: false, error: this.executionRefusal() };
    const release = this.beginLifecycle(batchReserved);
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      if (entry.space !== this.config.space)
        return { ok: false, error: `retained agent ${entry.name} belongs to space "${entry.space}", not "${this.config.space}"` };
      try {
        await this.loadSeatRuntime(entry.launch.runtime);
      } catch (e) {
        return { ok: false, error: `retained agent ${entry.name} requires runtime "${entry.launch.runtime}", which this manager cannot resolve: ${rejectionText(e)}` };
      }
      if (entry.launch.runtime !== this.runtimeFor(entry.launch.runtime).kind)
        return { ok: false, error: `retained agent ${entry.name} requires runtime "${entry.launch.runtime}", which this manager cannot resolve` };
      const nameErr = this.nameError(entry.name);
      if (nameErr) return { ok: false, error: nameErr };
      if (this.agents.has(entry.name) || (!batchReserved && this.namesCapacity.isReserved(entry.name)))
        return { ok: false, error: `retained agent "${entry.name}" is already managed or reserved; same-principal resume never auto-numbers` };
      const occupancy = batchReserved ? undefined : this.occupancy();
      if (occupancy && occupancy.used >= MAX_AGENTS)
        return { ok: false, error: `${this.parts.namesCapacity.capacityRefusal(occupancy)}; same-principal resume refused` };
      const cached = prepared?.get(entry.name);
      if (!preflightOnly && cached) {
        const refusal = await this.recheckPreparedResume(entry);
        if (refusal !== undefined) return { ok: false, error: refusal };
        return this.launchPreparedResume(entry, cached, batchReserved, supervised);
      }
      try {
        const cwd = lstatSync(entry.launch.cwd);
        if (!cwd.isDirectory() || cwd.isSymbolicLink())
          return { ok: false, error: `retained cwd is not a real directory: ${entry.launch.cwd}` };
      } catch (e) {
        return { ok: false, error: `retained cwd unavailable: ${entry.launch.cwd} (${rejectionText(e)})` };
      }

      let connector: Connector;
      try {
        // The SAME resolver the spawn path uses. A bare `registry.resolve` here made preserve→resume
        // fail for EVERY retained agent on the published binary: the resuming manager is a fresh
        // process whose registry is empty (its supervise child runs with the connector seed
        // skipped), so nothing is registered until something materializes it from the ext manifest.
        // That is precisely what `resolveConnector` does and what every spawn path already calls.
        // Resolving bare meant a preserved mesh could never come back — first-party connectors
        // included, since the asymmetry is about materialization, not about which connector it is.
        connector = await this.resolveConnector(entry.launch.connector);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      const unavailable = connector.launchUnavailable?.({ cwd: entry.launch.cwd, resume: entry.launch.forkSource });
      if (unavailable !== undefined) return { ok: false, error: unavailable };
      await this.parts.connectorInventory.refreshConnectors(connector.name, true);
      const harness = this.parts.harnessResolution.launchHarness(connector);
      if ("refusal" in harness) return { ok: false, error: harness.refusal };
      let retainedSession: string | undefined;
      try {
        retainedSession = this.retainedSessionId(entry, connector);
      } catch (error) {
        return { ok: false, error: rejectionText(error) };
      }
      if (entry.launch.forkSource && !retainedSession && !connector.supportsResume)
        return { ok: false, error: `${connector.name} connector does not support session fork (resume)` };
      if (retainedSession && !connector.supportsSessionContinuation)
        return { ok: false, error: `${connector.name} connector does not support exact-session continuation` };

      let launchOptions: Record<string, unknown> | undefined;
      let exact = false;
      if (entry.launch.source.kind === "manifest") {
        const launchSource = entry.launch.source;
        if (!launchSource.runId)
          return { ok: false, error: `retained manifest launch for ${entry.name} has no runId; refusing to guess a .cotal/run source` };
        let spec: MeshLaunchAgent | undefined;
        try {
          const source = launchSpecForRun(this.config.workspaceRoot, launchSource.runId);
          if (source.space !== this.config.space)
            return { ok: false, error: `retained launch spec space "${source.space}" does not match manager space "${this.config.space}"` };
          spec = source.agents.find((a) => a.name === launchSource.requested);
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
        if (!spec || spec.hash !== launchSource.hash)
          return { ok: false, error: `retained manifest agent ${launchSource.requested} is missing or its hash changed; refusing same-principal resume` };
        const refusal = manifestPersonaLaunchOptionsRefusal(spec.personaPath, spec.launchOptions);
        if (refusal) return { ok: false, error: refusal };
        launchOptions = spec.launchOptions;
        exact = spec.continuity === "exact";
      } else {
        try {
          const checked = loadTrustCheckedPersona(entry.launch.source.configPath, "agent");
          if (checked.refusal) return { ok: false, error: checked.refusal };
          launchOptions = checked.def.launchOptions;
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
      }
      // Asked once `exact` is known: an exact seat reopens its retained session or fails, like its
      // manifest launch, so the connector must honor reopenSession before the batch starts any child.
      const unsupported = this.capabilityRefusal(connector, { ...entry.launch, exact });
      if (unsupported) return { ok: false, error: unsupported };
      const eventsRefused = this.eventsRefusal(connector, entry.launch.events);
      if (eventsRefused) return { ok: false, error: eventsRefused };

      let authority: Pick<PreparedResume, "id" | "creds" | "userAuth">;
      try {
        authority = await this.validateRetainedAuthority(entry);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }

      try {
        const config = loadCotalConfig(this.config.workspaceRoot, isTrustedProject);
        const launchOpts: LaunchOpts = {
          ...this.hostLaunchFields(config, entry.launch.connector, entry.launch.shareTools, harness),
          name: entry.name,
          displayName: entry.displayName,
          role: entry.role,
          id: authority.id,
          creds: authority.creds,
          userAuth: authority.userAuth,
          // Recover the ORIGINAL incarnation uid (never a fresh mint on resume): the child endpoint
          // binds its lifecycle-keyed dm/dlv/chathist durables by this exact value, and its creds pin
          // the same names. Omitting it here (as the pre-fix resume path did) leaves the resumed child
          // with no COTAL_LIFECYCLE_UID: static/user fail the connector auth gate and open self-mints a
          // fresh uid that orphans the preserved durables and never matches the readiness fence.
          lifecycleUid: entry.identity.lifecycleUid,
          backfillFloor: entry.backfillFloor,
          acceptedToken: entry.identity.mode === "static" ? entry.identity.issued?.acceptedToken : undefined,
          configPath: entry.launch.source.configPath,
          model: entry.launch.model,
          variant: entry.launch.variant,
          modes: entry.launch.modes,
          launchOptions,
          resume: retainedSession ? undefined : entry.launch.forkSource,
          continueSession: exact ? undefined : retainedSession,
          reopenSession: exact ? retainedSession : undefined,
          subscribe: entry.launch.subscribe,
          allowSubscribe: entry.launch.allowSubscribe,
          allowPublish: entry.launch.allowPublish,
          capabilities: entry.launch.capabilities,
          endpoints: copyPersonaEndpoints(entry.launch.endpoints) ?? [],
          events: entry.launch.events,
          eventPayloads: this.config.eventPayloadsWithheld ? false : entry.launch.eventPayloads,
          ...optInLaunchFields(entry.launch),
          cwd: entry.launch.cwd,
        };
        const spec = connector.buildLaunch(launchOpts);
        spec.env = { ...spec.env, COTAL_MANAGER_INSTANCE: this.managerInstanceId, ...modelPolicyEnv(config, entry.role) };
        const value = { spec, launchOpts, ...authority, exact } satisfies PreparedResume;
        prepared?.set(entry.name, value);
        if (preflightOnly) return { ok: true, data: { name: entry.name, preflight: true } };
        return this.launchPreparedResume(entry, value, batchReserved, supervised);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    } finally {
      release();
    }
  }

  private async launchPreparedResume(
    entry: ManagerResumeAgent,
    prepared: PreparedResume,
    batchReserved: boolean,
    supervised?: SupervisedRestart,
  ): Promise<ControlReply> {
    if (!batchReserved) this.namesCapacity.reserve(entry.name, resumeOwner(entry));
    try {
      // Recover the STATIC identity's nkey seed from the adopted credential (the
      // creds file embeds it) so the manager stays this incarnation's RENEWAL OWNER across a
      // preserve/resume — without it the adopted cred would die loud at its TTL with no remint.
      let adoptedSeed: string | undefined;
      if (entry.identity.mode === "static") {
        const stored = await this.config.secrets.get(agentSecretKeyForFile(resolve(entry.identity.credential.path), this.config.space));
        // The core parser, which reads the creds format's six-dash END marker. A local pattern that
        // expected five matched no real file, so every resumed seat lost its renewal.
        try {
          adoptedSeed = stored === undefined ? undefined : identityFromCreds(stored).seed;
        } catch {
          adoptedSeed = undefined;
        }
        if (adoptedSeed === undefined)
          console.error(`! resume ${entry.name}: the adopted credential carries no readable nkey seed - the manager cannot renew it (it dies loud at its exp)`);
      }
      const connector = await this.resolveConnector(entry.launch.connector);
      const readinessTimeoutMs = connector.readinessTimeoutMs ?? this.config.readinessTimeoutMs;
      if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0)
        return { ok: false, error: `connector ${connector.name} declares invalid readinessTimeoutMs ${JSON.stringify(connector.readinessTimeoutMs)}; expected a positive safe integer` };
      const resumeId = entry.identity.mode === "user" ? principalKey(entry.identity.owner, entry.identity.actor).key : entry.identity.id;
      const runtime = this.runtimeFor(entry.launch.runtime);
      const custody = this.reserveCustody(runtime);
      if (custody) await this.recordSlotCustody({ name: entry.name, id: resumeId, lifecycleUid: entry.identity.lifecycleUid }, custody);
      prepared.spawned = true;
      const handle = await this.spawnCustodied(runtime, entry.name, prepared.spec, entry.launch.cwd, custody);
      const managed: ManagedAgent = {
        name: entry.name,
        ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
        role: entry.role,
        agent: entry.launch.connector,
        id: resumeId,
        seed: adoptedSeed,
        ...(entry.identity.mode === "static" && entry.identity.issued ? { issued: entry.identity.issued } : {}),
        // Recover the ORIGINAL incarnation uid the durables are keyed by (never a fresh mint on resume).
        lifecycleUid: entry.identity.lifecycleUid,
        // Adopt the INVENTORY's recorded family (possibly a pre-split name-keyed layout) — the
        // validated paths above, so this incarnation's later teardown addresses exactly what its
        // spawn materialized, never a re-derivation.
        secretPaths: entry.identity.mode === "user"
          ? { actorToken: entry.identity.actorToken.path, sentinelCreds: entry.identity.sentinelCredential.path, health: entry.identity.health.path }
          : entry.identity.mode === "static"
            ? { creds: entry.identity.credential.path }
            : undefined,
        userOwner: entry.identity.mode === "user" ? entry.identity.owner : undefined,
        spawner: entry.spawner,
        authorityParent: entry.authorityParent,
        startedAt: Date.now(),
        handle,
        control: prepared.spec.control,
        launch: {
          runtime: entry.launch.runtime,
          source: entry.launch.source,
          cwd: entry.launch.cwd,
          model: entry.launch.model,
          variant: connector.name === "claude" ? prepared.spec.env?.COTAL_VARIANT : entry.launch.variant,
          modes: entry.launch.modes,
          subscribe: entry.launch.subscribe,
          allowSubscribe: entry.launch.allowSubscribe,
          allowPublish: entry.launch.allowPublish,
          capabilities: entry.launch.capabilities,
          ...(entry.launch.endpoints?.length ? { endpoints: copyPersonaEndpoints(entry.launch.endpoints) } : {}),
          events: entry.launch.events,
          eventPayloads: this.config.eventPayloadsWithheld ? false : entry.launch.eventPayloads,
          ...optInLaunchFields(entry.launch),
          shareTools: entry.launch.shareTools,
          forkSource: entry.launch.forkSource,
          ...(entry.launch.resumed ? { resumed: entry.launch.resumed } : {}),
          ...(prepared.launchOpts.resume !== undefined && prepared.spec.resumeRecordPath ? { resumeRecordPath: prepared.spec.resumeRecordPath } : {}),
          sessionId: entry.launch.sessionId,
        },
        ...(supervised
          ? { restart: { opts: prepared.launchOpts, sessionStatePath: prepared.spec.sessionStatePath, crashes: supervised.crashes, recovering: false, armed: false, policy: supervised.policy } }
          : prepared.spec.sessionStatePath
            ? { restart: { opts: prepared.launchOpts, sessionStatePath: prepared.spec.sessionStatePath, crashes: [], recovering: false, armed: false } }
            : {}),
        suppressCleanup: true,
      };
      this.agents.set(entry.name, managed);
      this.namesCapacity.placed(entry.name);
      if (this.config.resumeAttemptId) this.resumedAgentNames.add(entry.name);
      try {
        await this.recordSlotRuntime(managed);
      } catch (error) {
        return await this.stopFailedResume(managed, "resume-custody-unrecorded", `${managed.name} resumed, but ${rejectionText(error)}`);
      }
      const readiness = await this.awaitReadiness(managed, readinessTimeoutMs, supervised ? { joinedAfter: supervised.joinedAfter } : {});
      if (!readiness.ok && !readiness.uncertain) return { ok: false, error: readiness.detail };
      if (!readiness.ok) {
        this.watchExit(managed);
        // The restart was counted when it launched, so the record carries that crash whether or not
        // the seat ever joins: a successor reads the record to decide whether another fits the budget.
        if (supervised) this.refreshSeatRecord(managed);
        this.watchResumeAdoption(managed, supervised?.joinedAfter, () => this.armLateResume(managed, connector, prepared, supervised));
        return { ok: false, error: readiness.detail };
      }
      const unbound = await this.armResumedSeat(managed, connector, prepared, supervised);
      if (unbound !== undefined) return await this.stopFailedResume(managed, "resume-session-rebind-failed", unbound);
      if (!this.config.resumeAttemptId) managed.suppressCleanup = false;
      if (supervised) this.refreshSeatRecord(managed);
      this.watchExit(managed);
      if (this.agents.get(managed.name) !== managed)
        return { ok: false, error: `${managed.name} exited immediately after same-principal readiness` };
      return {
        ok: true,
        data: { name: managed.name, role: managed.role, agent: managed.agent, id: managed.id, mode: handle.kind, resumed: true },
      };
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    } finally {
      if (!batchReserved) {
        this.namesCapacity.release(entry.name);
      }
    }
  }

  /** Arm a resumed seat's restart once it is ready, whether it joined inside the readiness window or
   *  after it (#4144). A supervised restart arms the way its spawn did: a connector with no session
   *  continuation is armed at readiness, one with it once its session is proved. Returns why the
   *  session could not be rebound, and the caller stops the seat. */
  private async armResumedSeat(managed: ManagedAgent, connector: Connector, prepared: PreparedResume, supervised: SupervisedRestart | undefined): Promise<string | undefined> {
    if (supervised && managed.restart && !connector.supportsSessionContinuation && !prepared.exact) {
      managed.restart.armed = true;
      return undefined;
    }
    if (!managed.restart && !prepared.exact) return undefined;
    try {
      await this.armSessionRecovery(managed);
      // As on a manifest launch, an exact seat is recorded only at the session it asked for,
      // proved over the connector's authenticated control endpoint.
      if (prepared.exact && !managed.restart?.armed)
        throw new Error("continuity: exact needs the connector to prove its session over an authenticated control endpoint, and it supplied none");
      managed.launch.sessionId = this.readManagedSession(managed);
      const asked = prepared.launchOpts.reopenSession;
      if (asked !== undefined && managed.launch.sessionId !== asked)
        throw new Error(`continuity: exact asked for session ${asked}, the connector bound ${managed.launch.sessionId}`);
      if (prepared.exact) {
        managed.continuity = { space: this.config.space, name: managed.name, connector: managed.agent, cwd: managed.launch.cwd };
        this.recordContinuity(managed, managed.launch.sessionId);
      }
      return undefined;
    } catch (error) {
      return `${managed.name} resumed, but its exact host session could not be rebound: ${rejectionText(error)}`;
    }
  }

  /** A resumed seat whose readiness was uncertain gets what a ready one gets once it joins: its
   *  restart is armed and its record rewritten. Without this, a supervised seat restarted after a
   *  manager crash that joined late was retired on its next exit instead of restarted. */
  private async armLateResume(managed: ManagedAgent, connector: Connector, prepared: PreparedResume, supervised: SupervisedRestart | undefined): Promise<void> {
    const current = (): boolean => this.agents.get(managed.name) === managed && !managed.terminalizing;
    if (!current()) return;
    const unbound = await this.armResumedSeat(managed, connector, prepared, supervised);
    if (!current()) return;
    if (unbound !== undefined) {
      const stopped = await this.stopFailedResume(managed, "resume-session-rebind-failed", unbound);
      if (!stopped.ok) console.error(`! ${stopped.error}`);
      return;
    }
    if (supervised) this.refreshSeatRecord(managed);
  }

  /** A resumed seat keeps its retained credentials, so freeing it runs no deprovision and nothing
   *  would reap it: it is freed only once its exit is proved, and otherwise stays managed until it
   *  exits or the manager stops it. */
  private async stopFailedResume(managed: ManagedAgent, cause: FreeSlotCause, detail: string): Promise<ControlReply> {
    const refused = this.stopHandle(managed, false, cause);
    const unproven = refused === undefined
      ? await this.awaitHandleExit(managed.handle).then(() => undefined, rejectionText)
      : `stop failed: ${refused}`;
    if (unproven !== undefined) {
      this.watchExit(managed);
      return { ok: false, error: `${detail}; it stays managed because its stop is unproven: ${unproven}` };
    }
    this.freeSlot(managed, true, cause, true);
    return { ok: false, error: detail };
  }

  /** An uncertain resume remains non-destructive until exact-principal AND exact-incarnation presence
   *  arrives later, and then `adopted` runs. Same predicate as the readiness fence: a principal-only
   *  match would let a wrong/absent-uid presence under the reused alias clear cleanup suppression on
   *  another incarnation. A supervised restart keeps its principal and uid, so it also carries the
   *  fence's `joinedAfter` bound: the row the dead seat left must not stand in for the new process.
   *  A heartbeat on that row moves only its time and emits no presence event, so the bound is polled. */
  private watchResumeAdoption(a: ManagedAgent, joinedAfter: number | undefined, adopted: () => Promise<void>): void {
    const wanted = this.managedPrincipal(a);
    let poll: ReturnType<typeof setInterval> | undefined;
    const done = (): void => {
      this.ep.off("presence", onPresence);
      if (poll !== undefined) clearInterval(poll);
    };
    const onPresence = (): void => {
      if (this.agents.get(a.name) !== a) {
        done();
        return;
      }
      if (!this.ep.getRoster().some((p) => p.card.id === wanted && p.status !== "offline" && p.lifecycleUid === a.lifecycleUid && (joinedAfter === undefined || p.ts >= joinedAfter))) return;
      if (!this.resumeRequired) a.suppressCleanup = false;
      done();
      adopted().catch((error) => console.error(`! ${a.name}: joined after its readiness window, but ${rejectionText(error)}`));
    };
    this.ep.on("presence", onPresence);
    if (joinedAfter !== undefined) {
      poll = setInterval(onPresence, LATE_JOIN_POLL_MS);
      poll.unref?.();
    }
    onPresence();
  }
}
