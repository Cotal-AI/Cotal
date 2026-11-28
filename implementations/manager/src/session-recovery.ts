import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discardLaunchArtifacts, EpEnvelopeError, loadCotalConfig, modelPolicyEnv, rejectionText,
  type AttachSession, type Connector, type CotalEndpoint, type LaunchOpts, type LaunchSpec, type RuntimeReference,
} from "@cotal-ai/core";
import type { ControlEndpoint } from "@cotal-ai/core";
import { isTrustedProject } from "@cotal-ai/workspace";
import type { ForkProvenance, FreeSlotCause, ManagedAgent, ManagerResumeAgent } from "./manager.js";
import type { AgentHandle, Runtime } from "./runtime/index.js";
import { writeContinuityAssignment } from "./launch.js";
import { controlSession } from "./control-session.js";
import { RESTART_WORK_EXIT_MS, withTimeout } from "./manager-timeout.js";
import type { Manager } from "./manager.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerParts } from "./manager-parts.js";
import type { ManagerStartState } from "./manager-start-state.js";

const SESSION_RESTART_LIMIT = 3;
const SESSION_RESTART_WINDOW_MS = 120_000;

type Readiness = { ok: true; operator?: string } | { ok: false; uncertain?: boolean; running?: boolean; deliberate?: boolean; detail: string };

/** Lifecycle and runtime operations used to prove and recover one managed host session. */
export interface SessionRecoveryDeps {
  executionRefusal: () => string;
  endpoint: () => CotalEndpoint;
  beginLifecycle: () => (() => void) | undefined;
  freeSlot: (agent: ManagedAgent, floor: boolean, cause: FreeSlotCause) => void;
  reapChildrenOf: (principal: string) => void;
  managedPrincipal: (agent: ManagedAgent) => string;
  inlineSnapshotChange: (agent: ManagedAgent) => string | undefined;
  agentFor: (name: string) => ManagedAgent | undefined;
  maintenanceState: () => "active" | "preserving" | "preserved";
  resolveConnector: (name: string) => Promise<Connector>;
  runtimeFor: (kind?: string) => Runtime;
  reserveCustody: (runtime: Runtime) => RuntimeReference | undefined;
  recordSlotCustody: (agent: { name: string; id: string; lifecycleUid: string }, reference: RuntimeReference) => Promise<void>;
  spawnCustodied: (runtime: Runtime, name: string, spec: LaunchSpec, cwd: string, reserved: RuntimeReference | undefined) => Promise<AgentHandle>;
  awaitReadiness: (agent: ManagedAgent, timeoutMs: number, opts: { reapOnExit?: boolean; joinedAfter?: number }) => Promise<Readiness>;
  recordSlotRuntime: (agent: ManagedAgent) => Promise<void>;
  refreshSeatRecord: (agent: ManagedAgent) => void;
  watchExit: (agent: ManagedAgent) => void;
  tail: (session: AttachSession) => Promise<string>;
  stopHandle: (agent: ManagedAgent, graceful: boolean, cause: FreeSlotCause) => void;
}

/** Builds the {@link SessionRecoveryDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function sessionRecoveryDeps(m: Manager): SessionRecoveryDeps {
  return {
    executionRefusal: () => m["executionRefusal"](),
    endpoint: () => m["ep"],
    beginLifecycle: () => m["beginLifecycle"](),
    freeSlot: (agent, floor, cause) => m["freeSlot"](agent, floor, cause),
    reapChildrenOf: (principal) => m["reapChildrenOf"](principal),
    managedPrincipal: (agent) => m["managedPrincipal"](agent),
    inlineSnapshotChange: (agent) => m["inlineSnapshotChange"](agent),
    agentFor: (name) => m["agents"].get(name),
    maintenanceState: () => m["maintenanceState"],
    resolveConnector: (name) => m["resolveConnector"](name),
    runtimeFor: (kind) => m["runtimeFor"](kind),
    reserveCustody: (runtime) => m["reserveCustody"](runtime),
    recordSlotCustody: (agent, reference) => m["recordSlotCustody"](agent, reference),
    spawnCustodied: (runtime, name, spec, cwd, reserved) => m["spawnCustodied"](runtime, name, spec, cwd, reserved),
    awaitReadiness: (agent, timeoutMs, opts) => m["awaitReadiness"](agent, timeoutMs, opts),
    recordSlotRuntime: (agent) => m["recordSlotRuntime"](agent),
    refreshSeatRecord: (agent) => m["refreshSeatRecord"](agent),
    watchExit: (agent) => m["watchExit"](agent),
    tail: (session) => m["tail"](session),
    stopHandle: (agent, graceful, cause) => m["stopHandle"](agent, graceful, cause),
  };
}

/** Session-state proof, transcript provenance, continuity assignments and bounded crash recovery. */
export class SessionRecovery {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: SessionRecoveryDeps, private readonly state: ManagerStartState, private readonly parts: Pick<ManagerParts, "connectorInventory" | "harnessResolution" | "seatStop">) {}
  private get managerInstanceId(): string { return this.state.managerInstanceId!; }

  readSessionStatePath(path: string):
    | { sessionId: string; status: "running" | "quit" }
    | { connector: string; status: "prompt"; prompt: string; cwd: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`cannot read connector session state ${path}: ${rejectionText(error)}`);
    }
    const state = parsed as { version?: unknown; sessionId?: unknown; status?: unknown; connector?: unknown; prompt?: unknown; cwd?: unknown };
    if (state.version === 1 && typeof state.sessionId === "string" && state.sessionId.trim() && state.sessionId.length <= 4096 &&
        (state.status === "running" || state.status === "quit"))
      return { sessionId: state.sessionId, status: state.status };
    if (state.version === 2 && state.status === "prompt" && typeof state.connector === "string" && /^[a-z0-9-]{1,64}$/.test(state.connector) &&
        typeof state.prompt === "string" && state.prompt.trim() && state.prompt.length <= 1024 &&
        typeof state.cwd === "string" && state.cwd.trim() && state.cwd.length <= 4096)
      return { connector: state.connector, status: "prompt", prompt: state.prompt, cwd: state.cwd };
    throw new Error(`connector session state ${path} is malformed`);
  }

  readManagedSessionState(a: ManagedAgent):
    | { sessionId: string; status: "running" | "quit" }
    | { connector: string; status: "prompt"; prompt: string; cwd: string } {
    const path = a.restart?.sessionStatePath;
    if (!path) throw new Error("connector supplied no session state path");
    return this.readSessionStatePath(path);
  }

  /** Upgrade bridge: inventories written before sessionId existed can still resume exactly after
   *  the old Pi seat has loaded the new extension once and written its lifecycle-keyed state file. */
  retainedSessionId(entry: ManagerResumeAgent, connector: Connector): string | undefined {
    if (entry.launch.sessionId) return entry.launch.sessionId;
    if (!connector.supportsSessionContinuation) return undefined;
    const path = join(this.config.workspaceRoot, ".cotal", "pi-sessions", `${entry.name}-${entry.identity.lifecycleUid}.json`);
    try {
      const state = this.readSessionStatePath(path);
      if (state.status === "prompt")
        throw new Error(`${state.connector} is waiting at prompt ${JSON.stringify(state.prompt)} for directory ${JSON.stringify(state.cwd)}`);
      return state.sessionId;
    } catch (error) {
      throw new Error(
        `retained ${connector.name} agent ${entry.name} has no sessionId in its older inventory and no usable upgrade state at ${path} ` +
          `(${rejectionText(error)}). Reload the live Pi seat before the preservation cut; refusing to resume fresh and lose its context.`,
      );
    }
  }

  /** A resumed seat's fork provenance (#1500). The seat forks after it launches, so this reads the
   *  record its connector named once the seat has written it, and keeps it on the launch so the
   *  resume document carries it across a manager restart. Until the seat has written it, or when the
   *  record cannot be read or does not name this seat's source, it is absent: `ps` then shows the
   *  source id alone rather than failing the listing for every other seat. */
  forkProvenance(a: ManagedAgent): ForkProvenance | undefined {
    // A carried seat's provenance is set only by refuseCarriedFork, once its record names the claim.
    if (a.launch.resumed || a.launch.carried) return a.launch.resumed;
    a.launch.resumed = this.readForkRecord(a);
    return a.launch.resumed;
  }

  readForkRecord(a: ManagedAgent): ForkProvenance | undefined {
    if (!a.launch.resumeRecordPath || !a.launch.forkSource) return undefined;
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(a.launch.resumeRecordPath, "utf8"));
    } catch {
      return undefined;
    }
    const r = (typeof record === "object" && record !== null ? record : {}) as Record<string, unknown>;
    if (r.source !== a.launch.forkSource || typeof r.transcriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.transcriptSha256) ||
        !(r.title === undefined || r.title === null || (typeof r.title === "string" && r.title.length <= 1024)))
      return undefined;
    return { source: r.source, ...(typeof r.title === "string" && r.title ? { title: r.title } : {}), transcriptSha256: r.transcriptSha256 };
  }

  /** Design section 9: a carried seat must fork the bytes the operator carried. Wait for its fork
   *  record and hold it to the claim; on a match it becomes the seat's provenance, otherwise the
   *  refusal is returned. A seat that writes no record cannot be shown to have forked the claim. */
  async refuseCarriedFork(a: ManagedAgent, timeoutMs: number): Promise<string | undefined> {
    const claim = a.launch.carried!;
    const deadline = Date.now() + timeoutMs;
    let record: ForkProvenance | undefined;
    while (!(record = this.readForkRecord(a))) {
      if (a.terminalizing || a.handle.status() === "exited") return `${a.name} stopped before it wrote a fork record`;
      if (Date.now() >= deadline) return `${a.name} wrote no fork record within ${timeoutMs} ms, so it cannot be shown to have forked the carried transcript`;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (record.transcriptSha256 !== claim.transcriptSha256)
      return `${a.name} forked a transcript with sha256:${record.transcriptSha256}, not the carried sha256:${claim.transcriptSha256}`;
    a.launch.resumed = { ...record, host: claim.host, transferredAt: claim.transferredAt };
    return undefined;
  }

  /** A carried seat whose launch was uncertain is held to the claim once it joins, as a started one
   *  is; the wait ends when the seat stops or exits, which its exit watcher reaps. */
  async refuseLateCarriedFork(a: ManagedAgent, timeoutMs: number): Promise<void> {
    for (;;) {
      const late = await this.deps.awaitReadiness(a, timeoutMs, { reapOnExit: false });
      if (late.ok) break;
      if (!late.uncertain || a.terminalizing) return;
    }
    const refused = await this.refuseCarriedFork(a, timeoutMs);
    if (refused === undefined || a.terminalizing || a.handle.status() === "exited") return;
    console.error(`! ${refused}; stopping it`);
    this.deps.stopHandle(a, false, "carried-fork-refused");
    this.parts.seatStop.trackStoppedHandle(a, true, "carried-fork-refused");
  }

  readManagedSession(a: ManagedAgent): string {
    const state = this.readManagedSessionState(a);
    if (state.status === "prompt")
      throw new Error(`${state.connector} is waiting at prompt ${JSON.stringify(state.prompt)} for directory ${JSON.stringify(state.cwd)}`);
    return state.sessionId;
  }

  /** Re-record an exact seat's assignment at a proven session, so crash recovery, a preserved resume
   *  and the next manifest launch never pick different sessions. */
  recordContinuity(a: ManagedAgent, sessionId: string): void {
    if (a.continuity) writeContinuityAssignment(this.config.workspaceRoot, { ...a.continuity, sessionId });
  }

  /** At a stop boundary the connector's session record is the last proof of the session an exact
   *  seat ran, including one it switched to itself. A failed write is logged; the stop goes on. */
  recordContinuityAtStop(a: ManagedAgent, boundary: string): void {
    if (!a.continuity || !a.restart?.armed) return;
    try {
      this.recordContinuity(a, this.readManagedSession(a));
    } catch (error) {
      console.error(`! ${a.name}: continuity: exact assignment not updated at ${boundary}: ${rejectionText(error)}`);
    }
  }

  async awaitManagedSessionState(a: ManagedAgent): Promise<{ sessionId: string; status: "running" | "quit" }> {
    const deadline = Date.now() + 15_000;
    let last = "session state not written yet";
    let prompt: { connector: string; prompt: string; cwd: string } | undefined;
    const promptFailure = (): string | undefined => prompt
      ? `${prompt.connector} is waiting at prompt ${JSON.stringify(prompt.prompt)} for directory ${JSON.stringify(prompt.cwd)}`
      : undefined;
    while (Date.now() < deadline) {
      try {
        const state = this.readManagedSessionState(a);
        if (state.status === "prompt") prompt = state;
        else return state;
      } catch (error) {
        last = rejectionText(error);
      }
      if (a.handle.status() === "exited") throw new Error(promptFailure() ?? "process exited before writing session state");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(promptFailure() ?? `connector did not write session state (${last})`);
  }

  /** Bind a continuation-capable connector only after its process is ready. The file proves the
   *  latest in-process session (including Pi /resume); the authenticated socket proves this process
   *  owns that session now. Presence may lead session_start by milliseconds, so both proofs are
   *  awaited within a bounded readiness window rather than read once. */
  async armSessionRecovery(a: ManagedAgent): Promise<void> {
    if (!a.restart || !a.control) return;
    const state = await this.awaitManagedSessionState(a);
    if (state.status !== "running") throw new Error("connector reported a deliberate quit before readiness completed");
    await this.awaitRecoveredSession(a, state.sessionId);
    a.restart.armed = true;
  }

  async awaitRecoveredSession(
    a: ManagedAgent,
    expected: string,
    handle: AgentHandle = a.handle,
    control: ControlEndpoint | undefined = a.control,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    let last = "control endpoint not ready";
    while (Date.now() < deadline) {
      if (handle.status() === "exited") throw new Error("replacement process exited before reporting its session");
      if (control) {
        try {
          const reported = await controlSession(control);
          if (reported !== expected) throw new Error(`replacement reported session ${reported}, expected ${expected}`);
          return;
        } catch (error) {
          last = rejectionText(error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`replacement did not prove session ${expected} (${last})`);
  }

  /** Restart one managed process in place. Identity, lifecycle, credentials, durables, children,
   *  and the manager row remain owned; only the process handle/control endpoint change. Budget
   *  comes from `restart.policy` when spawn carried `supervise`; otherwise the Pi session-recovery
   *  constants. Spending the budget falls through to normal retirement. */
  recoverManagedSession(a: ManagedAgent): void {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.deps.executionRefusal());
    const restart = a.restart;
    if (!restart || !restart.armed || restart.recovering || a.terminalizing) return;
    const release = this.deps.beginLifecycle();
    if (!release) return; // preservation owns the cut once the lifecycle fence closes
    const now = Date.now();
    const limit = restart.policy?.restarts ?? SESSION_RESTART_LIMIT;
    const windowMs = restart.policy?.windowMs ?? SESSION_RESTART_WINDOW_MS;
    const supervised = restart.policy !== undefined;
    restart.crashes = restart.crashes.filter((at) => now - at < windowMs);
    restart.crashes.push(now);
    if (restart.crashes.length > limit) {
      console.error(`! ${a.name}: ${supervised ? "supervised" : "Pi"} crash loop (${restart.crashes.length} crashes in ${windowMs / 1000}s) - retiring the managed seat`);
      restart.armed = false;
      this.deps.freeSlot(a, true, supervised ? "supervise-crash-loop" : "pi-crash-loop");
      this.deps.reapChildrenOf(this.deps.managedPrincipal(a));
      release();
      return;
    }
    // An inline seat relaunches from its snapshot, so one that changed after launch, or a recorded
    // path that names another file, would start a session its spawn never accepted. Every in-place
    // restart passes here; the resume cut and a successor's restart make the same two checks in
    // inventoryReferenceError.
    const changed = this.deps.inlineSnapshotChange(a);
    if (changed) {
      console.error(`! ${a.name}: ${changed} - retiring the managed seat instead of restarting it`);
      restart.armed = false;
      this.deps.freeSlot(a, true, "inline-snapshot-changed");
      this.deps.reapChildrenOf(this.deps.managedPrincipal(a));
      release();
      return;
    }
    restart.recovering = true;
    void (async () => {
      let replacement: AgentHandle | undefined;
      try {
        // A dead PTY leader may have left tool processes in other sessions. Never build or launch
        // a replacement until the runtime proves the whole prior execution closed.
        if (!a.handle.waitForWorkExit)
          throw new Error(`runtime "${a.handle.kind}" cannot prove prior local work ended; automatic restart refused`);
        await withTimeout(a.handle.waitForWorkExit(), RESTART_WORK_EXIT_MS,
          `prior local work was not proved ended within ${RESTART_WORK_EXIT_MS}ms; automatic restart refused`);
        if (this.deps.agentFor(a.name) !== a || a.terminalizing || this.deps.maintenanceState() !== "active") return;
        const connector = await this.deps.resolveConnector(a.agent);
        if (this.deps.agentFor(a.name) !== a || a.terminalizing || this.deps.maintenanceState() !== "active") return;
        const unavailable = connector.launchUnavailable?.({ cwd: a.launch.cwd });
        if (unavailable !== undefined) throw new Error(unavailable);
        await this.parts.connectorInventory.refreshConnectors(connector.name, true);
        if (this.deps.agentFor(a.name) !== a || a.terminalizing || this.deps.maintenanceState() !== "active") return;
        const harness = this.parts.harnessResolution.launchHarness(connector);
        if ("refusal" in harness) throw new Error(harness.refusal);
        const continueSession = connector.supportsSessionContinuation ? this.readManagedSession(a) : undefined;
        // The seat starts again under the name it last showed, which `set-name` may have changed since
        // launch, and on the model it runs, which `set-model` may have switched. A seat labels itself
        // at its first launch only.
        const named = { ...restart.opts, ...(harness.binaries ? { resolvedBinaries: harness.binaries } : {}), displayName: a.displayName, model: a.launch.model, variant: a.launch.variant, resume: undefined, reopenSession: undefined, prompt: undefined, firstCommand: undefined, autoName: undefined };
        const opts: LaunchOpts = continueSession !== undefined ? { ...named, continueSession } : named;
        const policyEnv = modelPolicyEnv(loadCotalConfig(this.config.workspaceRoot, isTrustedProject), a.role);
        const spec = connector.buildLaunch(opts);
        spec.env = { ...spec.env, COTAL_MANAGER_INSTANCE: this.managerInstanceId, ...policyEnv };
        const wanted = this.deps.managedPrincipal(a);
        const joinedAfter = this.deps.endpoint().getRoster()
          .filter((p) => p.card.id === wanted && p.lifecycleUid === a.lifecycleUid)
          .reduce((max, p) => Math.max(max, p.ts), 0) + 1;
        // Same ordering as the spawn path: the replacement seat's reference is recorded on the
        // still-active slot before its processes exist, so a crash here never strands it.
        const runtime = this.deps.runtimeFor(a.launch.runtime);
        const custody = this.deps.reserveCustody(runtime);
        if (custody) await this.deps.recordSlotCustody(a, custody);
        if (this.deps.agentFor(a.name) !== a || a.terminalizing || this.deps.maintenanceState() !== "active") {
          discardLaunchArtifacts(spec.artifacts); // No spawn was attempted, so no child can use them.
          return;
        }
        const handle = await this.deps.spawnCustodied(runtime, a.name, spec, a.launch.cwd, custody);
        replacement = handle;
        restart.sessionStatePath = spec.sessionStatePath ?? restart.sessionStatePath;
        if (continueSession !== undefined) {
          await this.awaitRecoveredSession(a, continueSession, handle, spec.control);
          this.recordContinuity(a, continueSession);
        } else {
          const previousHandle = a.handle;
          const previousControl = a.control;
          a.handle = handle;
          a.control = spec.control;
          try {
            const readiness = await this.deps.awaitReadiness(a, connector.readinessTimeoutMs ?? this.config.readinessTimeoutMs, {
              reapOnExit: false,
              joinedAfter,
            });
            if (!readiness.ok) throw new Error(readiness.detail);
          } catch (error) {
            a.handle = previousHandle;
            a.control = previousControl;
            throw error;
          }
        }
        if (this.deps.agentFor(a.name) !== a || a.terminalizing) {
          try { handle.stop({ graceful: false }); } catch { /* terminal path owns cleanup */ }
          return;
        }
        a.handle = handle;
        a.control = spec.control;
        await this.deps.recordSlotRuntime(a);
        replacement = undefined;
        restart.opts = opts;
        restart.recovering = false;
        this.deps.refreshSeatRecord(a);
        if (continueSession !== undefined)
          console.error(`! ${a.name}: recovered Pi session ${continueSession} after crash (${restart.crashes.length}/${limit})`);
        else
          console.error(`! ${a.name}: restarted under the same lifecycle after crash (${restart.crashes.length}/${limit})`);
        this.deps.watchExit(a);
      } catch (error) {
        restart.recovering = false;
        restart.armed = false;
        let tail = "";
        try { tail = await this.deps.tail((replacement ?? a.handle).attach()); }
        catch (error) { console.error(`! ${a.name}: last output unavailable: ${rejectionText(error)}`); }
        console.error(`! ${a.name}: ${supervised ? "supervised restart" : "Pi session recovery"} failed: ${rejectionText(error)}${tail ? ` - last output: ${tail}` : ""} - retiring the managed seat`);
        // The replacement may be alive but unable to prove readiness. Stop it BEFORE
        // retiring credentials/durables; otherwise an untracked process survives under torn auth.
        try { replacement?.stop({ graceful: false }); } catch { /* terminal cleanup continues */ }
        this.deps.freeSlot(a, true, supervised ? "supervise-recovery-failed" : "pi-recovery-failed");
        this.deps.reapChildrenOf(this.deps.managedPrincipal(a));
      } finally {
        release();
      }
    })();
  }
}
