import { EpEnvelopeError, principalKey, rejectionText, STANDING_RENEWABLE_TTL_SEC } from "@cotal-ai/core";
import type { CotalEndpoint } from "@cotal-ai/core";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { credRenewIntervalMs } from "./credential-renewal.js";
import { inlineSnapshotPath } from "./launch.js";
import { withTimeout } from "./manager-timeout.js";
import type { Manager, ManagerPreservationPlan, ManagerPreserveFailure, ManagerPreserveOptions, ManagerPreserveResult, ManagerResumeAgent, ManagerResumeInventory } from "./manager.js";
import { parseResumeControlArgs, readReleasedSeatReference, readSeatRecord, writeReleasedSeatReference, writeSeatRecord } from "./resume.js";
import { requireRuntimeReap } from "./runtime/index.js";
import type { AgentHandle } from "./runtime/index.js";
import type { ManagedAgent } from "./seat-types.js";

/** What {@link Preservation} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface PreservationDeps {
  agents: () => Manager["agents"];
  auth: () => Manager["auth"];
  credRenewTimer: () => Manager["credRenewTimer"];
  setCredRenewTimer: (value: Manager["credRenewTimer"]) => void;
  ep: () => Manager["ep"];
  execution: () => Manager["execution"];
  lifecycleInFlight: () => Manager["lifecycleInFlight"];
  maintenanceState: () => Manager["maintenanceState"];
  setMaintenanceState: (value: Manager["maintenanceState"]) => void;
  managerInstanceId: () => Manager["managerInstanceId"];
  meshMode: () => Manager["meshMode"];
  preservationAttemptId: () => Manager["preservationAttemptId"];
  setPreservationAttemptId: (value: Manager["preservationAttemptId"]) => void;
  preservationGeneration: () => Manager["preservationGeneration"];
  setPreservationGeneration: (value: Manager["preservationGeneration"]) => void;
  preservationInventory: () => Manager["preservationInventory"];
  setPreservationInventory: (value: Manager["preservationInventory"]) => void;
  preserveStopTimeoutMs: () => Manager["preserveStopTimeoutMs"];
  resumeCredRenewal: () => Manager["resumeCredRenewal"];
  space: () => Manager["space"];
  unverifiedStops: () => Manager["unverifiedStops"];
  setUnverifiedStops: (value: Manager["unverifiedStops"]) => void;
  userMode: () => Manager["userMode"];
  workspaceRoot: () => Manager["workspaceRoot"];
  awaitLifecycleDrain: (...args: Parameters<Manager["awaitLifecycleDrain"]>) => ReturnType<Manager["awaitLifecycleDrain"]>;
  deprovision: (...args: Parameters<Manager["deprovision"]>) => ReturnType<Manager["deprovision"]>;
  dropInlineSnapshot: (...args: Parameters<Manager["dropInlineSnapshot"]>) => ReturnType<Manager["dropInlineSnapshot"]>;
  dropSeatRecord: (...args: Parameters<Manager["dropSeatRecord"]>) => ReturnType<Manager["dropSeatRecord"]>;
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  fileDigest: (...args: Parameters<Manager["fileDigest"]>) => ReturnType<Manager["fileDigest"]>;
  logSeatReaped: (...args: Parameters<Manager["logSeatReaped"]>) => ReturnType<Manager["logSeatReaped"]>;
  onAgentExit: (...args: Parameters<Manager["onAgentExit"]>) => ReturnType<Manager["onAgentExit"]>;
  recordContinuityAtStop: (...args: Parameters<Manager["recordContinuityAtStop"]>) => ReturnType<Manager["recordContinuityAtStop"]>;
  renewDaemonCreds: (...args: Parameters<Manager["renewDaemonCreds"]>) => ReturnType<Manager["renewDaemonCreds"]>;
  resumeEntry: (...args: Parameters<Manager["resumeEntry"]>) => ReturnType<Manager["resumeEntry"]>;
  resumeEntryOf: (...args: Parameters<Manager["resumeEntryOf"]>) => ReturnType<Manager["resumeEntryOf"]>;
  runtimeFor: (...args: Parameters<Manager["runtimeFor"]>) => ReturnType<Manager["runtimeFor"]>;
  stopHandle: (...args: Parameters<Manager["stopHandle"]>) => ReturnType<Manager["stopHandle"]>;
  teardownTarget: (...args: Parameters<Manager["teardownTarget"]>) => ReturnType<Manager["teardownTarget"]>;
  validateRetainedAuthority: (...args: Parameters<Manager["validateRetainedAuthority"]>) => ReturnType<Manager["validateRetainedAuthority"]>;
  watchExit: (...args: Parameters<Manager["watchExit"]>) => ReturnType<Manager["watchExit"]>;
  withProvisioner: <T>(fn: (prov: CotalEndpoint) => Promise<T>) => Promise<T>;
}

/** Builds the {@link PreservationDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function preservationDeps(m: Manager): PreservationDeps {
  return {
    agents: () => m["agents"],
    auth: () => m["auth"],
    credRenewTimer: () => m["credRenewTimer"],
    setCredRenewTimer: (value) => { m["credRenewTimer"] = value; },
    ep: () => m["ep"],
    execution: () => m["execution"],
    lifecycleInFlight: () => m["lifecycleInFlight"],
    maintenanceState: () => m["maintenanceState"],
    setMaintenanceState: (value) => { m["maintenanceState"] = value; },
    managerInstanceId: () => m["managerInstanceId"],
    meshMode: () => m["meshMode"],
    preservationAttemptId: () => m["preservationAttemptId"],
    setPreservationAttemptId: (value) => { m["preservationAttemptId"] = value; },
    preservationGeneration: () => m["preservationGeneration"],
    setPreservationGeneration: (value) => { m["preservationGeneration"] = value; },
    preservationInventory: () => m["preservationInventory"],
    setPreservationInventory: (value) => { m["preservationInventory"] = value; },
    preserveStopTimeoutMs: () => m["preserveStopTimeoutMs"],
    resumeCredRenewal: () => m["resumeCredRenewal"],
    space: () => m["space"],
    unverifiedStops: () => m["unverifiedStops"],
    setUnverifiedStops: (value) => { m["unverifiedStops"] = value; },
    userMode: () => m["userMode"],
    workspaceRoot: () => m["workspaceRoot"],
    awaitLifecycleDrain: (...args) => m["awaitLifecycleDrain"](...args),
    deprovision: (...args) => m["deprovision"](...args),
    dropInlineSnapshot: (...args) => m["dropInlineSnapshot"](...args),
    dropSeatRecord: (...args) => m["dropSeatRecord"](...args),
    executionRefusal: (...args) => m["executionRefusal"](...args),
    fileDigest: (...args) => m["fileDigest"](...args),
    logSeatReaped: (...args) => m["logSeatReaped"](...args),
    onAgentExit: (...args) => m["onAgentExit"](...args),
    recordContinuityAtStop: (...args) => m["recordContinuityAtStop"](...args),
    renewDaemonCreds: (...args) => m["renewDaemonCreds"](...args),
    resumeEntry: (...args) => m["resumeEntry"](...args),
    resumeEntryOf: (...args) => m["resumeEntryOf"](...args),
    runtimeFor: (...args) => m["runtimeFor"](...args),
    stopHandle: (...args) => m["stopHandle"](...args),
    teardownTarget: (...args) => m["teardownTarget"](...args),
    validateRetainedAuthority: (...args) => m["validateRetainedAuthority"](...args),
    watchExit: (...args) => m["watchExit"](...args),
    withProvisioner: (fn) => m["withProvisioner"](fn),
  };
}

/** Preserving the manager for a restart: prepare, commit and abort, the cut that releases or tears down each seat, and adoption of released seats at the next start. */
export class Preservation {
  constructor(private readonly deps: PreservationDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.deps.auth(); }
  private get credRenewTimer() { return this.deps.credRenewTimer(); }
  private set credRenewTimer(value: Manager["credRenewTimer"]) { this.deps.setCredRenewTimer(value); }
  private get ep() { return this.deps.ep(); }
  private get execution() { return this.deps.execution(); }
  private get lifecycleInFlight() { return this.deps.lifecycleInFlight(); }
  private get maintenanceState() { return this.deps.maintenanceState(); }
  private set maintenanceState(value: Manager["maintenanceState"]) { this.deps.setMaintenanceState(value); }
  private get managerInstanceId() { return this.deps.managerInstanceId(); }
  private get meshMode() { return this.deps.meshMode(); }
  private get preservationAttemptId() { return this.deps.preservationAttemptId(); }
  private set preservationAttemptId(value: Manager["preservationAttemptId"]) { this.deps.setPreservationAttemptId(value); }
  private get preservationGeneration() { return this.deps.preservationGeneration(); }
  private set preservationGeneration(value: Manager["preservationGeneration"]) { this.deps.setPreservationGeneration(value); }
  private get preservationInventory() { return this.deps.preservationInventory(); }
  private set preservationInventory(value: Manager["preservationInventory"]) { this.deps.setPreservationInventory(value); }
  private get preserveStopTimeoutMs() { return this.deps.preserveStopTimeoutMs(); }
  private get resumeCredRenewal() { return this.deps.resumeCredRenewal(); }
  private get space() { return this.deps.space(); }
  private get unverifiedStops() { return this.deps.unverifiedStops(); }
  private set unverifiedStops(value: Manager["unverifiedStops"]) { this.deps.setUnverifiedStops(value); }
  private get userMode() { return this.deps.userMode(); }
  private get workspaceRoot() { return this.deps.workspaceRoot(); }
  private awaitLifecycleDrain(...args: Parameters<Manager["awaitLifecycleDrain"]>): ReturnType<Manager["awaitLifecycleDrain"]> { return this.deps.awaitLifecycleDrain(...args); }
  private deprovision(...args: Parameters<Manager["deprovision"]>): ReturnType<Manager["deprovision"]> { return this.deps.deprovision(...args); }
  private dropInlineSnapshot(...args: Parameters<Manager["dropInlineSnapshot"]>): ReturnType<Manager["dropInlineSnapshot"]> { return this.deps.dropInlineSnapshot(...args); }
  private dropSeatRecord(...args: Parameters<Manager["dropSeatRecord"]>): ReturnType<Manager["dropSeatRecord"]> { return this.deps.dropSeatRecord(...args); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private fileDigest(...args: Parameters<Manager["fileDigest"]>): ReturnType<Manager["fileDigest"]> { return this.deps.fileDigest(...args); }
  private logSeatReaped(...args: Parameters<Manager["logSeatReaped"]>): ReturnType<Manager["logSeatReaped"]> { return this.deps.logSeatReaped(...args); }
  private onAgentExit(...args: Parameters<Manager["onAgentExit"]>): ReturnType<Manager["onAgentExit"]> { return this.deps.onAgentExit(...args); }
  private recordContinuityAtStop(...args: Parameters<Manager["recordContinuityAtStop"]>): ReturnType<Manager["recordContinuityAtStop"]> { return this.deps.recordContinuityAtStop(...args); }
  private renewDaemonCreds(...args: Parameters<Manager["renewDaemonCreds"]>): ReturnType<Manager["renewDaemonCreds"]> { return this.deps.renewDaemonCreds(...args); }
  private resumeEntry(...args: Parameters<Manager["resumeEntry"]>): ReturnType<Manager["resumeEntry"]> { return this.deps.resumeEntry(...args); }
  private resumeEntryOf(...args: Parameters<Manager["resumeEntryOf"]>): ReturnType<Manager["resumeEntryOf"]> { return this.deps.resumeEntryOf(...args); }
  private runtimeFor(...args: Parameters<Manager["runtimeFor"]>): ReturnType<Manager["runtimeFor"]> { return this.deps.runtimeFor(...args); }
  private stopHandle(...args: Parameters<Manager["stopHandle"]>): ReturnType<Manager["stopHandle"]> { return this.deps.stopHandle(...args); }
  private teardownTarget(...args: Parameters<Manager["teardownTarget"]>): ReturnType<Manager["teardownTarget"]> { return this.deps.teardownTarget(...args); }
  private validateRetainedAuthority(...args: Parameters<Manager["validateRetainedAuthority"]>): ReturnType<Manager["validateRetainedAuthority"]> { return this.deps.validateRetainedAuthority(...args); }
  private watchExit(...args: Parameters<Manager["watchExit"]>): ReturnType<Manager["watchExit"]> { return this.deps.watchExit(...args); }
  private withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T> { return this.deps.withProvisioner(fn); }

  private preparationTask?: Promise<ManagerPreservationPlan>;
  private preservationFailures: ManagerPreserveFailure[] = [];
  private preservationTask?: Promise<ManagerPreserveResult>;
  private preservationStarted = false;

  /** The CHAT stream frontier at a preservation cut (issue #545), read through whichever local
   *  authority this mesh mode holds: open mode's own endpoint already has `$JS.API.STREAM.INFO`
   *  on the CHAT stream. Local and remote supervisor credentials also hold this metadata grant
   *  for transcript startup checks, but this preservation path retains its existing local-authority
   *  boundary. Static/user modes borrow the ephemeral `provisioner` profile the manager already
   *  mints per spawn. A remote-authority manager (`this.auth`
   *  undefined in static/user mode) has no local space authority to mint that provisioner with, so
   *  it prints one line and returns no floor — the inventory then carries none and resumed seats
   *  behave exactly as before this fix, not a silent partial degrade. */
  private async chatFrontierForPreservation(): Promise<number | undefined> {
    switch (this.meshMode) {
      case "open":
        return this.ep.chatFrontier();
      case "static":
      case "user":
        if (!this.auth) {
          console.error(
            "! preservation: this manager holds no local space authority to read the chat frontier; retained seats replay their channel windows on resume",
          );
          return undefined;
        }
        return this.withProvisioner((prov) => prov.chatFrontier());
    }
  }

  /** Fence and build the inventory without stopping a child. The coordinator must durably persist
   * this exact plan before calling commitPreservation with the same attempt id. */
  preparePreservation(attemptId: string): Promise<ManagerPreservationPlan> {
    if (this.execution === "none") return Promise.reject(new EpEnvelopeError("unimplemented", this.executionRefusal()));
    if (!attemptId.trim()) return Promise.reject(new Error("preservation attemptId is required"));
    if (this.preservationAttemptId && this.preservationAttemptId !== attemptId)
      return Promise.reject(new Error(`manager is fenced for preservation attempt ${this.preservationAttemptId}; refusing different attempt ${attemptId}`));
    if (this.maintenanceState === "preserved" && this.preservationInventory)
      return Promise.resolve({ ok: true, attemptId, state: "preserved", inventory: this.preservationInventory, failures: [] });
    if (this.preparationTask) return this.preparationTask;
    if (this.maintenanceState === "active") {
      // The fence lands before any await. Accepted work has already incremented lifecycleInFlight.
      this.maintenanceState = "preserving";
      this.preservationAttemptId = attemptId;
      this.preservationGeneration++;
      if (this.credRenewTimer) {
        clearInterval(this.credRenewTimer);
        this.credRenewTimer = undefined;
      }
    }
    const generation = this.preservationGeneration;
    const task = this.runPreparation(attemptId, generation);
    let wrapped!: Promise<ManagerPreservationPlan>;
    wrapped = task.finally(() => {
      if (this.preservationGeneration === generation && this.preparationTask === wrapped)
        this.preparationTask = undefined;
    });
    this.preparationTask = wrapped;
    return wrapped;
  }

  private assertPreservationGeneration(attemptId: string, generation: number): void {
    if (this.preservationAttemptId !== attemptId || this.preservationGeneration !== generation)
      throw new Error(`preservation attempt ${attemptId} was abandoned before preparation completed`);
  }

  async runPreparation(attemptId: string, generation: number): Promise<ManagerPreservationPlan> {
    await this.awaitLifecycleDrain();
    this.assertPreservationGeneration(attemptId, generation);
    // Read the chat frontier BEFORE any child stops (issue #545): a message posted between this
    // read and the child's stop is delivered live now and again as `historical` on resume, a
    // duplicate bounded to the cut window that the seat's own id dedup on `durable` channels
    // absorbs, whereas a read taken after the stops would instead skip messages the seat never
    // actually saw.
    const backfillFloor = await this.chatFrontierForPreservation();
    const inventory = this.preservationInventory ?? {
      version: "cotal-manager-resume/v2",
      space: this.space,
      createdAt: new Date().toISOString(),
      agents: [...this.agents.values()].map((a) => this.resumeEntry(a, backfillFloor)),
    } satisfies ManagerResumeInventory;
    const failures: ManagerPreserveFailure[] = [];
    for (const entry of inventory.agents) {
      const error = this.inventoryReferenceError(entry);
      if (error) failures.push({
        name: entry.name,
        id: entry.identity.mode === "user" ? principalKey(entry.identity.owner, entry.identity.actor).key : entry.identity.id,
        error,
      });
    }
    // A later manager does not resume a delegated seat, and its close runs only inside its
    // retirement, so a cut that holds one is refused before any child stops. A carried resume seat's
    // private home is removed when its slot is freed, so a later manager would find nothing to fork.
    for (const a of this.agents.values()) {
      if (a.handedOff) failures.push({ name: a.name, id: a.id, error: "a delegated seat is not resumed by a later manager; stop it before preserving" });
      if (a.seatHome) failures.push({ name: a.name, id: a.id, error: "a carried resume seat's private home is not kept for a later manager; stop it before preserving" });
      if (a.once) failures.push({ name: a.name, id: a.id, error: "a once seat runs its one task in this process, and a later manager would start it again; let its task end or stop it before preserving" });
    }
    const unverifiedStops = this.unverifiedStops.filter((stopped) => {
      try {
        if (!stopped.authoritative && stopped.handle.status() === "exited") return false;
      } catch { /* fail closed below */ }
      failures.push({
        name: stopped.name,
        id: stopped.id,
        error: stopped.error ?? `an earlier stop on runtime "${stopped.handle.kind}" cannot prove the child is gone`,
      });
      return true;
    });
    this.assertPreservationGeneration(attemptId, generation);
    // The prepared inventory must round-trip through the EXACT resume control parser (schema and
    // byte cap) NOW, before any child stops: a cut that cannot resume must fail at prepare time,
    // never after listener exposure.
    try {
      parseResumeControlArgs({ attemptId, inventory });
    } catch (e) {
      failures.push({ name: "<inventory>", id: attemptId, error: `prepared inventory would be rejected at resume: ${rejectionText(e)}` });
    }
    this.preservationInventory = inventory;
    this.preservationFailures = failures;
    this.unverifiedStops = unverifiedStops;
    return {
      ok: failures.length === 0,
      attemptId,
      state: "prepared",
      inventory,
      failures: [...failures],
    };
  }

  /** Stop children only after the coordinator has persisted the prepared inventory. Same-attempt
   * retries are idempotent; a different attempt is refused. */
  commitPreservation(attemptId: string): Promise<ManagerPreserveResult> {
    if (this.execution === "none") return Promise.reject(new EpEnvelopeError("unimplemented", this.executionRefusal()));
    if (!this.preservationAttemptId || this.preservationAttemptId !== attemptId)
      return Promise.reject(new Error(`preservation attempt ${attemptId} was not prepared by this manager`));
    if (!this.preservationInventory)
      return Promise.reject(new Error(`preservation attempt ${attemptId} has no prepared inventory`));
    if (this.preservationFailures.length)
      return Promise.resolve({
        ok: false,
        attemptId,
        state: "preserving",
        inventory: this.preservationInventory,
        failures: [...this.preservationFailures],
      });
    if (this.maintenanceState === "preserved")
      return Promise.resolve({ ok: true, attemptId, state: "preserved", inventory: this.preservationInventory, failures: [] });
    if (this.preservationTask) return this.preservationTask;
    this.preservationStarted = true;
    this.preservationTask = this.runPreservation(attemptId).finally(() => {
      this.preservationTask = undefined;
    });
    return this.preservationTask;
  }

  /** Recover an abandoned prepare before any child stop. Once commit begins, preservation is
   * irreversible and remains fenced until the coordinator records failure/recourse. */
  abortPreservation(attemptId: string): void {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.preservationAttemptId !== attemptId)
      throw new Error(`preservation attempt ${attemptId} is not the active manager attempt`);
    if (this.preparationTask || this.lifecycleInFlight > 0)
      throw new Error(`preservation attempt ${attemptId} is still preparing or draining accepted lifecycle work and cannot be aborted`);
    if (this.preservationStarted || this.preservationTask || this.maintenanceState === "preserved")
      throw new Error(`preservation attempt ${attemptId} has begun stopping children and cannot return to active mode`);
    this.preservationGeneration++;
    this.maintenanceState = "active";
    this.preservationAttemptId = undefined;
    this.preservationInventory = undefined;
    this.preservationFailures = [];
    if (this.auth && !this.credRenewTimer) {
      this.credRenewTimer = setInterval(() => { void this.renewDaemonCreds(); }, credRenewIntervalMs(STANDING_RENEWABLE_TTL_SEC));
      this.credRenewTimer.unref?.();
    }
    this.resumeCredRenewal?.();
    // Exit watchers were suppressed while the fence stood: reconcile every child that died during
    // preparation now, or its slot/credential footprint would linger unreaped after the abort.
    for (const agent of [...this.agents.values()]) {
      try {
        if (agent.handle.status() === "exited") this.onAgentExit(agent);
      } catch { /* status unavailable - the exit watcher fires again on real exit */ }
    }
  }

  /** In-process convenience that preserves the crash barrier by awaiting durable persistence between
   * prepare and commit. Wire callers use the explicit two-phase admin operations. */
  async preserveState(opts: ManagerPreserveOptions): Promise<ManagerPreserveResult> {
    const plan = await this.preparePreservation(opts.attemptId);
    if (!plan.ok)
      return { ok: false, attemptId: opts.attemptId, state: "preserving", inventory: plan.inventory, failures: plan.failures };
    await opts.persistInventory(plan.inventory);
    return this.commitPreservation(opts.attemptId);
  }

  private async runPreservation(attemptId: string): Promise<ManagerPreserveResult> {
    const failures: ManagerPreserveFailure[] = [];
    for (const a of [...this.agents.values()]) a.suppressCleanup = true;
    await Promise.all(
      [...this.agents.values()].map(async (a) => {
        try {
          // A preservation cut must not run the connector's logical leave/cleanup hooks.
          a.handle.stop({ graceful: false });
        } catch (e) {
          failures.push({ name: a.name, id: a.id, error: `stop failed: ${rejectionText(e)}` });
          return;
        }
        try {
          await this.awaitHandleExit(a.handle);
          if (this.agents.get(a.name) === a) this.agents.delete(a.name);
        } catch (e) {
          failures.push({ name: a.name, id: a.id, error: rejectionText(e) });
        }
      }),
    );

    if (failures.length === 0) this.maintenanceState = "preserved";
    return {
      ok: failures.length === 0,
      attemptId,
      state: this.maintenanceState === "preserved" ? "preserved" : "preserving",
      inventory: this.preservationInventory!,
      failures,
    };
  }

  async awaitHandleExit(handle: AgentHandle): Promise<void> {
    if (!handle.waitForExit)
      throw new Error(`runtime "${handle.kind}" cannot prove child exit (AgentHandle.waitForExit is not implemented)`);
    await withTimeout(
      handle.waitForExit(),
      this.preserveStopTimeoutMs,
      `child did not exit within ${this.preserveStopTimeoutMs}ms`,
    );
    if (handle.status() !== "exited")
      throw new Error(`runtime "${handle.kind}" reported exit completion but status is still running`);
  }

  inventoryReferenceError(entry: ManagerResumeAgent): string | undefined {
    if (entry.launch.source.kind === "manifest" && !entry.launch.source.runId)
      return "resolved manifest launch has no retained runId";
    if (entry.launch.unresolvedLaunchOptionKeys?.length)
      return `imperative launch options have no non-secret durable source (${entry.launch.unresolvedLaunchOptionKeys.join(", ")})`;
    if (!entry.dependencies.some((path) => resolve(path) === resolve(entry.launch.source.configPath)))
      return `launch config is not declared as a retained dependency: ${entry.launch.source.configPath}`;
    if (entry.launch.source.kind === "inline" && resolve(entry.launch.source.configPath) !== resolve(inlineSnapshotPath(this.workspaceRoot, entry.identity.lifecycleUid)))
      return `inline persona snapshot ${entry.launch.source.configPath} is not this lifecycle's snapshot path`;
    if (entry.launch.source.kind === "manifest" && entry.launch.source.runId) {
      const specPath = join(this.workspaceRoot, ".cotal", "run", `${entry.launch.source.runId}.json`);
      if (!entry.dependencies.some((path) => resolve(path) === resolve(specPath)))
        return `manifest source is not declared as a retained dependency: ${specPath}`;
    }
    const required = [...entry.dependencies];
    if (entry.identity.mode === "static") required.push(entry.identity.credential.path);
    if (entry.identity.mode === "user") {
      required.push(entry.identity.actorToken.path, entry.identity.sentinelCredential.path);
    }
    for (const path of required) {
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink()) return `retained reference is not a regular non-symlink file: ${path}`;
      } catch (e) {
        return `retained reference unavailable: ${path} (${rejectionText(e)})`;
      }
    }
    if (process.platform !== "win32") {
      const secrets = entry.identity.mode === "static"
        ? [entry.identity.credential.path]
        : entry.identity.mode === "user"
          ? [entry.identity.actorToken.path, entry.identity.sentinelCredential.path]
          : [];
      for (const path of secrets)
        if ((lstatSync(path).mode & 0o077) !== 0) return `retained identity file is not private (expected 0600): ${path}`;
    }
    try {
      if (this.fileDigest(entry.launch.source.configPath) !== entry.launch.source.configSha256)
        return `launch config changed since it became effective: ${entry.launch.source.configPath}`;
      if (entry.identity.mode === "static" && this.fileDigest(entry.identity.credential.path) !== entry.identity.credential.sha256)
        return `retained credential changed after the cut: ${entry.identity.credential.path}`;
      if (entry.identity.mode === "user" &&
          (this.fileDigest(entry.identity.actorToken.path) !== entry.identity.actorToken.sha256 ||
           this.fileDigest(entry.identity.sentinelCredential.path) !== entry.identity.sentinelCredential.sha256))
        return `retained user identity files changed after the cut for ${entry.name}`;
      if (entry.launch.source.kind === "manifest" && entry.launch.source.runId) {
        const specPath = join(this.workspaceRoot, ".cotal", "run", `${entry.launch.source.runId}.json`);
        if (!entry.launch.source.manifestSha256 || this.fileDigest(specPath) !== entry.launch.source.manifestSha256)
          return `manifest source changed since it became effective: ${specPath}`;
      }
    } catch (e) {
      return `retained reference cannot be hashed: ${rejectionText(e)}`;
    }
    return undefined;
  }

  fileDigestOrEmpty(path: string): string {
    try { return this.fileDigest(path); } catch { return ""; }
  }

  /** Tear down every managed agent's footprint on an explicit destructive {@link stop}, or only the
   *  in-process seats a default stop cannot detach. A manager exit is
   *  a mass agent-exit, and without this its agents' footprints (creds files + `dm_`/`dlv_` durables + ACL
   *  rows) would orphan exactly as the per-agent exit path prevents. Stop each child gracefully, so its
   *  own shutdown runs before the runtime escalates, and AWAIT its deprovision — bounded per agent (`withTimeout`) and
   *  best-effort (`allSettled` + a loud log), so one slow/failed teardown can neither hang nor abort exit.
   *  The creds file is dropped even if the broker teardown fails (see {@link deprovision}). Deliberately
   *  touches NEITHER the lease NOR the endpoints — the caller owns those. */
  async teardownManagedAgents(managed = [...this.agents.values()]): Promise<void> {
    const failures: string[] = [];
    const stopped: ManagedAgent[] = [];
    for (const a of managed) {
      // Free the slot and stop each the way an operator stop does. `stopHandle` is best-effort (never
      // throws — see it), so one bad stop can't strand the rest, and every snapshot entry is
      // deprovisioned below regardless. A hard kill never runs the seat's shutdown, so a helper that
      // has left the process group keeps running after `cotal down`. The runtime still escalates to
      // SIGKILL after its grace.
      this.recordContinuityAtStop(a, "shutdown");
      if (process.platform !== "win32" || a.handle.kind !== "pty") {
        this.agents.delete(a.name);
        this.dropSeatRecord(a);
      }
      const refused = this.stopHandle(a, true, { kind: "stopped-shutdown" });
      if (refused === undefined) stopped.push(a);
      else failures.push(`${a.name}: stop failed: ${refused}`);
    }
    // A runtime stop request is not exit proof. Do not release the manager lease or registration
    // while any seat may still hold this instance's broker rails: that creates the exact orphan
    // window where a successor sees a dead manager but live predecessor authority. Every shipped
    // runtime now supplies waitForExit; absence or timeout is a failed shutdown, never a clean one.
    // The slot delete above bypasses freeSlot, which is where the reap line lives, so say it
    // here once this shutdown has proved the seat exited. A seat whose stop was refused, or
    // whose exit wait did not prove it gone, is named only by the shutdown error below (#1423, #3404).
    await Promise.all(stopped.map(async (a) => {
      try {
        await this.awaitHandleExit(a.handle);
        if (process.platform === "win32" && a.handle.kind === "pty") {
          this.agents.delete(a.name);
          this.dropSeatRecord(a);
        }
        this.logSeatReaped(a, { kind: "stopped-shutdown" });
      } catch (e) {
        failures.push(`${a.name}: ${rejectionText(e)}`);
      }
    }));
    // Deprovision EVERY snapshot entry regardless of whether its stop failed (allSettled + a loud log).
    await Promise.allSettled(
      managed.filter((a) => !a.suppressCleanup).map((a) => {
        // Retired here on every mesh, the open mesh included, which runs no teardown of its own.
        const settled = a.launch.source.kind !== "inline" || this.dropInlineSnapshot(a.name, a.lifecycleUid);
        return this.deprovision({ ...this.teardownTarget(a), ...(settled ? { snapshotSettled: true as const } : {}) }).catch((e) => console.error(`deprovision ${a.name} (${a.id}) on shutdown: ${rejectionText(e)}`));
      }),
    );
    if (failures.length)
      throw new Error(`manager shutdown could not prove every seat exited: ${failures.join("; ")}`);
  }

  isProcessBoundSeat(agent: ManagedAgent): boolean {
    return agent.handle.kind === "pty" && typeof agent.handle.release !== "function";
  }

  /** Drop local custody of every seat that can outlive this process, and leave it running. A seat
   *  with a runtime reference is recorded first, so the next manager on this workspace adopts it, or
   *  retires it once its runtime proves it gone. The stopping manager keeps no watch on a released
   *  seat: its endpoint is closing, and a retirement it drove afterwards would run over a dead
   *  connection and race the next manager's. `stop` is every seat left for the caller to stop and
   *  retire now: an in-process seat, a seat the runtime already reports gone, and a seat whose record
   *  could not be written, because a released seat nobody can find again is the leak this stop must
   *  not create. */
  releaseManagedAgents(): { failures: string[]; stop: ManagedAgent[] } {
    const failures: string[] = [];
    const stop: ManagedAgent[] = [];
    for (const a of [...this.agents.values()]) {
      if (this.isProcessBoundSeat(a)) {
        stop.push(a);
        continue;
      }
      let exited = false;
      try {
        exited = a.handle.status() === "exited";
      } catch {
        // Status is not proof either way; the seat is released as any running seat is.
      }
      if (exited) {
        stop.push(a);
        continue;
      }
      const reference = a.handle.reference;
      if (reference) {
        try {
          // A static manager records an adoptable seat at launch and keeps that record current. A
          // user-mode manager records nothing until here.
          if (this.userMode)
            writeSeatRecord(this.workspaceRoot, { version: "cotal-seat-record/v1", instanceId: this.managerInstanceId, crashes: a.restart?.crashes ?? [], agent: this.resumeEntryOf(a) });
          writeReleasedSeatReference(this.workspaceRoot, this.space, a.name, { version: "cotal-released-seat/v1", lifecycleUid: a.lifecycleUid, kind: reference.kind, id: reference.id });
        } catch (e) {
          console.error(`! ${a.name}: the released seat could not be recorded (${rejectionText(e)}); this stop retires it instead`);
          stop.push(a);
          continue;
        }
      }
      try {
        a.handle.release?.();
        a.suppressCleanup = true;
        this.agents.delete(a.name);
      } catch (e) {
        failures.push(`${a.name}: ${rejectionText(e)}`);
      }
    }
    return { failures, stop };
  }

  /** Take back user-mode seats a previous manager released while they were still running. A seat
   *  the runtime adopts is watched, and retired when that watch proves it gone. A seat the runtime
   *  has already reaped is retired now. Anything the runtime cannot prove is left recorded. */
  async adoptReleasedSeats(): Promise<void> {
    const dir = join(this.workspaceRoot, ".cotal", "seat-records", this.space);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".runtime-ref")) continue;
      const name = file.slice(0, -".runtime-ref".length);
      try {
        await this.adoptReleasedSeat(name);
      } catch (e) {
        console.error(`! ${name}: the released seat was not adopted: ${rejectionText(e)}`);
      }
    }
  }

  private async adoptReleasedSeat(name: string): Promise<void> {
    const reference = readReleasedSeatReference(this.workspaceRoot, this.space, name);
    const record = reference ? readSeatRecord(this.workspaceRoot, this.space, name) : undefined;
    const identity = record?.agent.identity;
    if (!reference || !record || identity?.mode !== "user" || identity.lifecycleUid !== reference.lifecycleUid) return;
    try {
      await this.validateRetainedAuthority(record.agent);
    } catch (e) {
      console.error(`! ${name}: the released seat's record was not adopted: ${rejectionText(e)}`);
      return;
    }
    const held = this.agents.get(name);
    if (held?.lifecycleUid === reference.lifecycleUid) return;
    if (held) return;
    const runtime = this.runtimeFor(reference.kind);
    if (typeof runtime.adopt !== "function" || reference.kind !== runtime.kind) return;
    let handle: AgentHandle;
    try {
      handle = runtime.adopt(reference);
    } catch (e) {
      try {
        await requireRuntimeReap(runtime, reference);
      } catch {
        // The runtime could not prove the seat gone. Leave the record for a later start.
        return;
      }
      console.error(`! ${name}: the released seat is gone (${rejectionText(e)}); retiring its lifecycle`);
      handle = {
        name,
        kind: runtime.kind,
        reference: { kind: runtime.kind, id: reference.id },
        status: () => "exited",
        stop: () => {},
        interrupt: () => {},
        waitForExit: () => Promise.resolve(),
        attach: () => { throw new Error(`released seat ${name} has exited`); },
      };
    }
    const launch = record.agent.launch;
    const agent: ManagedAgent = {
      name,
      role: record.agent.role,
      agent: launch.connector,
      id: principalKey(identity.owner, identity.actor).key,
      lifecycleUid: identity.lifecycleUid,
      userOwner: identity.owner,
      secretPaths: {
        actorToken: identity.actorToken.path,
        sentinelCreds: identity.sentinelCredential.path,
        health: identity.health.path,
      },
      spawner: record.agent.spawner,
      authorityParent: record.agent.authorityParent,
      startedAt: Date.parse(record.agent.startedAt) || Date.now(),
      handle,
      launch: {
        source: launch.source,
        runtime: launch.runtime,
        cwd: launch.cwd,
        model: launch.model,
        variant: launch.variant,
        subscribe: launch.subscribe,
        allowSubscribe: launch.allowSubscribe,
        allowPublish: launch.allowPublish,
        capabilities: launch.capabilities,
        events: launch.events,
        eventPayloads: launch.eventPayloads,
        shareTools: launch.shareTools,
        forkSource: launch.forkSource,
        sessionId: launch.sessionId,
        unresolvedLaunchOptionKeys: launch.unresolvedLaunchOptionKeys,
      },
    };
    this.agents.set(name, agent);
    this.watchExit(agent);
  }
}
