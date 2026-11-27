import { resolve } from "node:path";
import {
  copyPersonaEndpoints, DEV_OWNER, identityFromCreds, inspectCredHealth, principalKey, rejectionText,
  type CotalEndpoint, type LaunchSpec, type LifecycleStateTransport, type StaticManagedSlotRow,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, agentSecretKeyForFile, retainConnectorSeat } from "@cotal-ai/workspace";
import { isCustodialRuntime, requireRuntimeReap, RuntimeReapUnproven, watchProvedExit, type AgentHandle, type Runtime } from "./runtime/index.js";
import { SharedPtyRuntime } from "./runtime/shared-pty.js";
import type { RuntimeReference } from "@cotal-ai/core";
import type { ManagedAgent, ManagerResumeAgent, SupervisedRestart } from "./manager.js";
import { readSeatRecord, removeReleasedSeatReference, removeSeatRecord, writeSeatRecord, type SeatRecord } from "./resume.js";
import { optInLaunchFields } from "./harness-resolution.js";
import { casStaticSlot, readStaticSlot } from "./static-lifecycle.js";
import { RESTART_WORK_EXIT_MS, withTimeout } from "./manager-timeout.js";
import type { Manager } from "./manager.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";

/** Keep launch provenance independent of status and runtime wire contracts. */
export function watchConnectorHolder(handle: AgentHandle, holder: ReturnType<typeof retainConnectorSeat>): void {
  if (!holder.active) return;
  holder.launched(handle.pid);
  // A released handle may outlive its Manager. Only an authoritative exit removes
  // identity-less holders, never a release or a failed stop request.
  watchProvedExit(handle, () => holder.ended(), () => true);
}

/** Manager-owned authority and lifecycle operations used while recording and recovering seats. */
export interface SeatCustodyDeps {
  staticAuth: () => boolean;
  endpoint: () => CotalEndpoint;
  runtimeFor: (kind: string) => Runtime;
  requiredRuntime: () => Runtime;
  withLifecycleExecutor: <T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>) => Promise<T>;
  watchConnectorHolder: (handle: AgentHandle, holder: ReturnType<typeof retainConnectorSeat>) => void;
  resumeEntryOf: (agent: ManagedAgent) => ManagerResumeAgent;
  inventoryReferenceError: (entry: ManagerResumeAgent) => string | undefined;
  registerAgent: (name: string, agent: ManagedAgent) => void;
  agentFor: (name: string) => ManagedAgent | undefined;
  watchExit: (agent: ManagedAgent) => void;
  bindOnceSeat: (agent: ManagedAgent) => Promise<void>;
  renewManagedStaticCred: (agent: ManagedAgent) => Promise<void>;
  resumeSupervisedAgent: (entry: ManagerResumeAgent, supervised: SupervisedRestart) => Promise<import("@cotal-ai/core").ControlReply>;
}

/** Builds the {@link SeatCustodyDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function seatCustodyDeps(m: Manager): SeatCustodyDeps {
  return {
    staticAuth: () => !!m["auth"] && !m["userMode"],
    endpoint: () => m["ep"],
    runtimeFor: (kind) => m["runtimeFor"](kind),
    requiredRuntime: () => m["requiredRuntime"],
    withLifecycleExecutor: (pin, fn) => m["withLifecycleExecutor"](pin, fn),
    watchConnectorHolder: (handle, holder) => m["watchConnectorHolder"](handle, holder),
    resumeEntryOf: (agent) => m["resumeEntryOf"](agent),
    inventoryReferenceError: (entry) => m["inventoryReferenceError"](entry),
    registerAgent: (name, agent) => { m["agents"].set(name, agent); },
    agentFor: (name) => m["agents"].get(name),
    watchExit: (agent) => m["watchExit"](agent),
    bindOnceSeat: (agent) => m["bindOnceSeat"](agent),
    renewManagedStaticCred: (agent) => m["renewManagedStaticCred"](agent),
    resumeSupervisedAgent: (entry, supervised) => m["resumePreservedAgent"](entry, false, false, undefined, supervised),
  };
}

/** Seat custody references, successor records, and identity-checked recovery for one manager. */
export class SeatCustody {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: SeatCustodyDeps, private readonly state: ManagerStartState) {}
  private get managerInstanceId(): string { return this.state.managerInstanceId!; }

  /** Re-record the custody reference of a managed agent's CURRENT handle on its active slot: a
   *  same-lifecycle restart or a resume binds a new custody under the old uid, and the successor's
   *  reap must address the live one. Static auth only; a runtime without durable custody records
   *  nothing (there is nothing to reap by reference). */
  async recordSlotRuntime(a: ManagedAgent): Promise<void> {
    if (a.handle.reference === undefined) return;
    await this.recordSlotCustody(a, a.handle.reference);
  }

  /** Record one custody reference on an agent's ACTIVE slot. Split from {@link recordSlotRuntime}
   *  so a restart or a resume can record the reference it RESERVED before spawning, while no
   *  handle exists yet. Static auth only; a runtime without durable custody reserves nothing.
   *  Throws when the slot does not take the reference: a slot left on the previous one reaps that
   *  seat, already gone, so a successor would retire the lifecycle over the new one. */
  async recordSlotCustody(a: { name: string; id: string; lifecycleUid: string }, runtime: RuntimeReference): Promise<void> {
    if (!this.deps.staticAuth()) return;
    try {
      await this.deps.withLifecycleExecutor({ owner: DEV_OWNER, actor: a.id, lifecycleUid: a.lifecycleUid, alias: a.name }, async (t) => {
        const slot = await readStaticSlot(t, DEV_OWNER, a.name);
        if (slot === undefined || slot.row.lifecycleUid !== a.lifecycleUid || slot.row.phase !== "active")
          throw new Error(`the slot is ${slot === undefined ? "absent" : `${slot.row.phase} at uid ${slot.row.lifecycleUid}`}`);
        if (slot.row.runtime?.kind === runtime.kind && slot.row.runtime.id === runtime.id) return;
        await casStaticSlot(t, { ...slot.row, runtime }, slot.revision);
      });
    } catch (e) {
      throw new Error(`could not record the custody reference ${runtime.kind}:${runtime.id} on the static slot of "${a.name}": ${rejectionText(e)}`);
    }
  }

  /** Mint the custody reference for a seat this manager is about to spawn, BEFORE the processes
   *  exist. Absent for a runtime with no durable custody (there is nothing a successor could reap
   *  by reference), which is the only case that still spawns unreserved. */
  reserveCustody(runtime: Runtime): RuntimeReference | undefined {
    return isCustodialRuntime(runtime) ? runtime.reserve() : undefined;
  }

  /** Spawn under a reserved reference and prove the runtime honoured it. A runtime that minted its
   *  own id instead would leave every durable record addressing a seat that does not exist, so the
   *  mismatch tears the new seat down and throws rather than returning an unaddressable handle. */
  async spawnCustodied(runtime: Runtime, name: string, spec: LaunchSpec, cwd: string, reserved: RuntimeReference | undefined): Promise<AgentHandle> {
    const shared = runtime instanceof SharedPtyRuntime && reserved === undefined;
    const holder = retainConnectorSeat(this.managerInstanceId, name, shared);
    const handle = shared && holder.sharedEligible
      ? await runtime.spawnShared(name, spec, cwd, child => holder.bindSharedChild(child))
      : runtime.spawn(name, spec, cwd, reserved);
    this.deps.watchConnectorHolder(handle, holder);
    if (reserved === undefined) return handle;
    const got = handle.reference;
    if (got?.kind === reserved.kind && got.id === reserved.id) return handle;
    // A live seat now exists under a reference no durable row names, and the rollback will reap the
    // RESERVED one, which addresses nothing. `handle.stop` cannot close this: it is fire-and-forget
    // over the seat socket and swallows its own errors, so it proves nothing about the process. Reap
    // the reference the runtime ACTUALLY used - that path verifies identity and proves the exit -
    // and carry what the proof said into the throw, so a mismatch never reports a disposal it did
    // not make.
    let disposal: string;
    if (got === undefined) {
      try { handle.stop({ graceful: false }); } catch { /* reported below */ }
      disposal = "the handle carries no reference, so nothing could reap it by identity and only a best-effort stop was issued";
    } else {
      try {
        const evidence = await requireRuntimeReap(runtime, got);
        disposal = `the spawned seat was reaped (${evidence.detail})`;
      } catch (e) {
        // Two unrelated failures used to share one sentence here, and the difference is the part the
        // reader has to act on. A runtime that cannot reap at all left nothing behind to find. An
        // UNPROVEN reap may have left a live seat under a reference no durable row names, which is
        // the one case where somebody has to go looking, so it says so and names what to look for.
        disposal =
          e instanceof RuntimeReapUnproven
            ? `the spawned seat was NOT proved gone and may still be running as ${e.reference.kind}:${e.reference.id} (${e.message})`
            : `the spawned seat could NOT be reaped: ${rejectionText(e)}`;
      }
    }
    throw new Error(
      `runtime "${runtime.kind}" reserved custody ${reserved.kind}:${reserved.id} for "${name}" but spawned ` +
        `${got ? `${got.kind}:${got.id}` : "a handle with no reference"}; the recorded reference would address no seat, so ${disposal}`,
    );
  }

  /** Persist what a successor needs to take this seat back if this process ends without stopping
   *  it: a supervised seat, which a successor restarts (#4094), and a seat on a runtime that can adopt
   *  it by reference, which a successor adopts while it still runs (#4095). Static meshes only: a
   *  successor finds the seat through its active slot row, and only a static mesh keeps one. Throws
   *  when a supervised seat's entry could not be resumed, because a policy this host cannot keep
   *  across a manager restart is one it cannot enforce. */
  recordSeat(a: ManagedAgent): void {
    if (!this.deps.staticAuth()) return;
    const policy = a.restart?.policy;
    const runtime = this.deps.runtimeFor(a.handle.kind);
    const adoptable = a.handle.reference !== undefined && typeof runtime.adopt === "function";
    if (!policy && !adoptable) return;
    const agent = this.deps.resumeEntryOf(a);
    if (policy) {
      const unresumable = this.deps.inventoryReferenceError(agent);
      if (unresumable) throw new Error(`a successor manager could not restart it: ${unresumable}`);
    }
    writeSeatRecord(this.config.workspaceRoot, { version: "cotal-seat-record/v1", instanceId: this.managerInstanceId, ...(policy ? { supervise: policy } : {}), crashes: a.restart?.crashes ?? [], agent });
  }

  /** Bring a running seat's record up to date after its credential or restart count changed. A
   *  record that cannot be rewritten is removed, so a successor retires the seat rather than taking
   *  it back from a stale one. */
  refreshSeatRecord(a: ManagedAgent): void {
    try {
      this.recordSeat(a);
    } catch (error) {
      console.error(`! ${a.name}: its seat record could not be updated (${rejectionText(error)}); a manager restart now retires it`);
      this.dropSeatRecord(a);
    }
  }

  dropSeatRecord(a: { name: string; lifecycleUid: string }): void {
    try {
      removeSeatRecord(this.config.workspaceRoot, this.config.space, a.name, a.lifecycleUid);
      removeReleasedSeatReference(this.config.workspaceRoot, this.config.space, a.name, a.lifecycleUid);
    } catch (error) {
      console.error(`! ${a.name}: its seat record could not be removed: ${rejectionText(error)}`);
    }
  }

  /** The seat record behind one active slot this instance owns, when it describes that exact
   *  incarnation on this runtime. Anything else is left to the ordinary terminal. */
  seatRecordFor(row: StaticManagedSlotRow): SeatRecord | undefined {
    let record: SeatRecord | undefined;
    try {
      record = readSeatRecord(this.config.workspaceRoot, this.config.space, row.alias);
    } catch (error) {
      console.error(`! ${row.alias}: ${rejectionText(error)}; the lifecycle is retired, not restarted`);
      return undefined;
    }
    if (record === undefined) return undefined;
    const identity = record.agent.identity;
    if (identity.mode !== "static" || identity.id !== row.actor || identity.lifecycleUid !== row.lifecycleUid) return undefined;
    if (record.instanceId !== this.managerInstanceId || record.agent.space !== this.config.space) return undefined;
    let runtimeMatches = record.agent.launch.runtime === row.runtime?.kind;
    if (row.runtime === undefined) {
      // Non-custodial backends such as pty record no slot reference. A custodial backend still
      // requires one, and an unavailable backend must refuse rather than select a replacement.
      const runtime = this.deps.runtimeFor(record.agent.launch.runtime);
      runtimeMatches = runtime.kind === record.agent.launch.runtime && !isCustodialRuntime(runtime);
    }
    if (!runtimeMatches) {
      console.error(`! ${row.alias}: its seat ran on runtime "${record.agent.launch.runtime}" and its slot names "${row.runtime?.kind ?? "none"}"; the lifecycle is retired, not restarted`);
      return undefined;
    }
    return record;
  }

  /** Take back a seat that outlived its manager (#4095): the runtime reattaches to the exact seat
   *  the slot names, and this manager holds it under the record's identity and launch, with no
   *  relaunch. Returns why it could not, and the caller then retires the lifecycle, which reaps the
   *  seat by the same reference. */
  async adoptSeat(row: StaticManagedSlotRow, record: SeatRecord): Promise<string | undefined> {
    const entry = record.agent;
    if (entry.identity.mode !== "static") return "its record is not a static identity";
    if (row.runtime === undefined) return "its slot names no seat";
    const runtime = this.deps.runtimeFor(row.runtime.kind);
    if (typeof runtime.adopt !== "function") return `runtime "${runtime.kind}" cannot adopt a seat`;
    // The credential is the manager's own lifecycle-keyed file, and its seed renews it.
    const credsPath = resolve(entry.identity.credential.path);
    if (credsPath !== resolve(agentLifecycleSecretFilePaths(this.config.workspaceRoot, this.config.space, entry.name, entry.identity.lifecycleUid).creds))
      return `its credential reference ${credsPath} is not this lifecycle's manager-owned path`;
    const stored = await this.config.secrets.get(agentSecretKeyForFile(credsPath, this.config.space));
    if (stored === undefined) return "its credential is not in the secret store";
    let seed: string;
    try {
      const identity = identityFromCreds(stored);
      if (identity.id !== entry.identity.id) return `its credential is identity ${identity.id}, not ${entry.identity.id}`;
      seed = identity.seed;
    } catch (error) {
      return `its credential is unreadable: ${rejectionText(error)}`;
    }
    let adopted: AgentHandle;
    try {
      adopted = runtime.adopt(row.runtime);
    } catch (error) {
      return `the seat ${row.runtime.kind}:${row.runtime.id} could not be adopted: ${rejectionText(error)}`;
    }
    const managed: ManagedAgent = {
      name: entry.name,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      role: entry.role,
      agent: entry.launch.connector,
      id: entry.identity.id,
      seed,
      ...(entry.identity.issued ? { issued: entry.identity.issued } : {}),
      lifecycleUid: entry.identity.lifecycleUid,
      secretPaths: { creds: entry.identity.credential.path },
      spawner: entry.spawner,
      authorityParent: entry.authorityParent,
      startedAt: Date.parse(entry.startedAt),
      // The runtime names an adopted handle by what it holds; the record names the seat.
      handle: { ...adopted, name: entry.name },
      launch: {
        runtime: entry.launch.runtime,
        source: entry.launch.source,
        cwd: entry.launch.cwd,
        model: entry.launch.model,
        variant: entry.launch.variant,
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
        sessionId: entry.launch.sessionId,
        unresolvedLaunchOptionKeys: entry.launch.unresolvedLaunchOptionKeys,
      },
    };
    this.deps.registerAgent(entry.name, managed);
    this.deps.watchExit(managed);
    console.error(`! ${entry.name}: adopted the seat its previous manager left (${row.runtime.kind}:${row.runtime.id})`);
    await this.deps.bindOnceSeat(managed);
    // A credential that came close to its expiry while no manager ran is renewed now, not at the
    // next pass.
    const health = inspectCredHealth(stored).state;
    if (health === "near-expiry" || health === "expired")
      await this.deps.renewManagedStaticCred(managed).catch((error) => console.error(`! managed cred renewal ${entry.name}: ${rejectionText(error)} - the agent dies loud at this cred's expiry unless it is reminted`));
    return undefined;
  }

  /** Restart a supervised seat whose manager ended without stopping it (#4094), as one restart of
   *  its own policy. It goes through the resume launch, so the seat comes back under the same name,
   *  lifecycle uid, credential, persona and cwd, and a pending turn addressed to it is served to it.
   *  Returns why it could not, and the caller then retires the lifecycle. */
  async restartSupervisedSeat(row: StaticManagedSlotRow, record: SeatRecord): Promise<string | undefined> {
    const policy = record.supervise;
    if (policy === undefined) return "its spawn carried no restart policy";
    const now = Date.now();
    const crashes = [...record.crashes.filter((at) => now - at < policy.windowMs), now];
    if (crashes.length > policy.restarts)
      return `its supervise restart budget is spent (${crashes.length} deaths in ${policy.windowMs / 1000}s, ${policy.restarts} allowed)`;
    // Ordinary reap proves only the runtime's seat process/window gone. A durable work-closure
    // proof must also cover detached tools. No reference means unknown, not an empty execution.
    if (row.runtime === undefined) return "prior local work has no durable custody reference; automatic restart refused";
    const runtime = this.deps.runtimeFor(row.runtime.kind);
    if (!runtime.reapWork) return `runtime "${runtime.kind}" cannot prove prior local work ended after a manager crash; automatic restart refused`;
    try {
      await withTimeout(runtime.reapWork(row.runtime), RESTART_WORK_EXIT_MS,
        `prior local work was not proved ended within ${RESTART_WORK_EXIT_MS}ms`);
    } catch (error) {
      return `prior local work could not be closed; automatic restart refused: ${rejectionText(error)}`;
    }
    await this.deps.endpoint().waitForPresenceSnapshot();
    // Readiness counts only a heartbeat newer than any the dead seat left, as an in-place restart does.
    const principal = principalKey(DEV_OWNER, row.actor).key;
    const joinedAfter = this.deps.endpoint().getRoster()
      .filter((p) => p.card.id === principal && p.lifecycleUid === row.lifecycleUid)
      .reduce((max, p) => Math.max(max, p.ts), 0) + 1;
    const reply = await this.deps.resumeSupervisedAgent(record.agent, { policy, crashes, joinedAfter });
    const live = this.deps.agentFor(row.alias);
    if (reply.ok) {
      console.error(`! ${row.alias}: restarted under the same lifecycle after its manager stopped (${crashes.length}/${policy.restarts})`);
      return undefined;
    }
    // An uncertain readiness keeps the seat managed and watched, as any launch does.
    if (live?.lifecycleUid === row.lifecycleUid) {
      console.error(`! ${row.alias}: restarted after its manager stopped, but readiness is uncertain: ${reply.error}`);
      return undefined;
    }
    return `its restart failed: ${reply.error}`;
  }

  /** The terminal's process step: an orphan (no live handle in THIS process) is reaped by the custody
   *  reference the slot recorded, before its footprint goes. A successor must never retire a
   *  lifecycle and free its alias while the predecessor's seat process is still running outside
   *  every manager. The runtime verifies the process identity against its own record and proves the
   *  exit; a runtime that cannot reap refuses by name and the lifecycle stays terminalizing. A row
   *  with no recorded reference has nothing this manager can address. */
  async reapOrphanSeat(a: { name: string; runtime?: RuntimeReference }): Promise<void> {
    if (a.runtime === undefined) {
      // No reference reached this terminal. Under a custodying runtime that is either a row written
      // before the reservation existed, or a caller that dropped the reference on the way here.
      // Do not name the slot row: the row may well hold a reference this caller never read, and
      // a diagnostic that guesses which is which sends the reader the wrong way.
      if (isCustodialRuntime(this.deps.requiredRuntime()))
        console.error(`static retirement ${a.name}: no custody reference reached this terminal, though runtime "${this.deps.requiredRuntime().kind}" custodies its seats; any seat it launched is not addressable from here`);
      return;
    }
    // An unproven reap throws from here rather than printing, so it propagates into
    // driveStaticRetirement's catch, which records the failure and HOLDS the name. That is the whole
    // point of refusing: the alias must not be freed while a seat nobody proved gone may still run.
    const runtime = this.deps.runtimeFor(a.runtime.kind);
    const evidence = await requireRuntimeReap(runtime, a.runtime);
    console.error(`static retirement ${a.name}: orphan seat process ${evidence.detail}`);
  }
}
