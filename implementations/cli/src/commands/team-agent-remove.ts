import { setTimeout as delay } from "node:timers/promises";
import * as prompts from "../lib/prompts.js";
import { DEV_OWNER, contractDigest } from "@cotal-ai/core";
import { acquireMaintenanceLock, canonicalRoot, CommandFailure, findMesh, oneLine, presentationOf, readMaintenanceJournal, releaseMaintenanceLock, writeResult, type Report } from "@cotal-ai/workspace";
import { askManager, managerFailure, resolveControlTarget } from "../lib/control.js";
import { listAdditiveTeamAttempts, type AdditiveAgentReceipt, type AdditiveTeamAttempt } from "../lib/team-additive-attempt.js";
import { writeAgentRemovalAttempt, writeAgentRemovalReceipt, writeAgentRemovalStep, type AgentRemovalAttempt, type AgentRemovalStep, type AgentRetirementObservation } from "../lib/team-agent-removal.js";
import { classifyAgent, type AgentSettlement, type SlotRow } from "../lib/team-removal-reconcile.js";
import { personaCatalog } from "../lib/persona-files.js";
import { canPrompt } from "./meshes-wizard.js";
import type { TeamValues } from "./team.js";

type Agent = AdditiveAgentReceipt["createdAgents"][number];
interface Slot {
  name: string; owner: string; actor: string; slotLifecycleUid: string; slotPhase: string;
  cleanupComplete?: boolean; slotRevision: number; headState?: string; headLifecycleUid?: string;
  headRevision?: number; live: boolean; managerInstanceId: string;
}
export interface AgentStop { name: string; id: string; lifecycleUid: string; requestId: string; acknowledged: boolean; notExecuted?: boolean }
export interface AgentRetirementRun { intentAttempted: boolean; returned: boolean; retired: AgentRetirementObservation[]; stops: AgentStop[]; failure?: CommandFailure }

/** The native retirement phase for an original static deployment, agent-only or mixed. Preparing it
 * reads the pinned original manager's slots; `execute` runs only under the caller's maintenance lock.
 * A stop acknowledgement never settles removal: every original UID must reach a native retired
 * slot/head with confirmed cleanup, and an unconfirmed outcome stops the sequence without replay. */
export async function prepareAgentRetirement(input: { root: string; space: string; deploymentId: string; original: AdditiveTeamAttempt; receipt: AdditiveAgentReceipt }) {
  const { root, space, deploymentId, original, receipt } = input, target = { root, space, deploymentId };
  if (original.authMode !== "auth" || !original.managerInstanceId) throw new CommandFailure("refused", "UNSUPPORTED", "native agent retirement needs a static-auth deployment with its recorded manager", { target });
  const manager = original.managerInstanceId, digest = contractDigest(receipt);
  const selected = findMesh(space);
  if (!selected || selected.mode !== "auth" || canonicalRoot(selected.root) !== root || selected.server !== original.server || (selected.tlsRequired === true) !== original.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the registered root, broker, auth mode or transport differs from the original deployment", { target });
  const control = await resolveControlTarget({ space }, "control-caller-admin", manager, { onRefusal: "throw" });
  if (!control.root || canonicalRoot(control.root) !== root || control.server !== selected.server || control.mode !== "auth" || (control.auth.tls === true) !== original.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the original manager's scoped caller resolved another target; no stop was submitted", { target });
  const unchanged = () => {
    if (JSON.stringify(findMesh(space)) !== JSON.stringify(selected)) throw new CommandFailure("refused", "CONFLICT", "the selected registration changed; no later stop was submitted", { target });
    const current = listAdditiveTeamAttempts(root);
    const now = current.returned.find((row) => row.deploymentId === deploymentId);
    if (current.refused.length || !now || contractDigest(now) !== digest || JSON.stringify(current.valid.find((row) => row.deploymentId === deploymentId)) !== JSON.stringify(original)) throw new CommandFailure("refused", "CONFLICT", "the original intent, returned receipt or removal records changed; no later stop was submitted", { target });
  };
  const readSlots = async (agents: readonly Agent[]) => {
    const answer = await askManager(space, control.server, "slots", { names: agents.map((row) => row.name), includeRetired: true }, control.auth, "any", 2_000, { instanceId: manager });
    if (!answer.ok) throw managerFailure(answer, "native retirement inspection", target);
    const rows = answer.data as Slot[];
    if (answer.managerInstanceId !== manager || !Number.isSafeInteger(answer.managerEpoch) || !Array.isArray(rows) || rows.length > agents.length || new Set(rows.map((row) => row.name)).size !== rows.length || rows.some((row) => !agents.some((agent) => agent.name === row.name))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the original manager did not return a bounded attributed slot query", { target });
    return agents.map((agent) => {
      const row = rows.find((row) => row.name === agent.name);
      if (!row || row.owner !== DEV_OWNER || row.actor !== agent.id || row.slotLifecycleUid !== agent.lifecycleUid || row.managerInstanceId !== manager) throw new CommandFailure("refused", "CONFLICT", "an original static slot is absent, foreign or now names a successor incarnation; no name-based stop was substituted", { target: { ...target, agent: agent.name, expectedId: agent.id, expectedLifecycleUid: agent.lifecycleUid } });
      const retired: AgentRetirementObservation | null = row.slotPhase === "retired" && row.cleanupComplete === true && row.headState === "retired" && row.headLifecycleUid === agent.lifecycleUid && row.live === false && Number.isSafeInteger(row.slotRevision) && row.slotRevision > 0 && Number.isSafeInteger(row.headRevision) && row.headRevision! > 0 ? { name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid, managerInstanceId: manager, managerEpoch: answer.managerEpoch!, slotRevision: row.slotRevision, headRevision: row.headRevision!, cleanupComplete: true, slotPhase: "retired", headState: "retired", observedAt: new Date().toISOString() } : null;
      return { agent, slot: row, retired };
    });
  };
  unchanged();
  const impact = await readSlots(receipt.createdAgents);
  if (impact.some((row) => !row.retired && (row.slot.slotPhase !== "active" || !row.slot.live))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an original incarnation is already transitioning or its process/cleanup state is unconfirmed; no stop was repeated", { target });
  const agents = impact.map((row) => ({ name: row.agent.name, id: row.agent.id, lifecycleUid: row.agent.lifecycleUid, slotPhase: row.slot.slotPhase, cleanupComplete: row.slot.cleanupComplete ?? null, observedState: row.retired ? "native-retired-and-cleaned" : "exact-live-incarnation" }));
  return { manager, agents, async execute(signal: AbortSignal): Promise<AgentRetirementRun> {
    let intent: AgentRemovalAttempt | undefined, intentAttempted = false, returned = false, failure: CommandFailure | undefined;
    const retired: AgentRetirementObservation[] = [], stops: AgentStop[] = [];
    try {
      unchanged();
      const current = listAdditiveTeamAttempts(root);
      if (readMaintenanceJournal(root) || current.removal?.attempts.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "maintenance or another removal attempt appeared before intent publication; no stop was submitted", { target });
      await readSlots(receipt.createdAgents);
      if (signal.aborted) throw new CommandFailure("refused", "OPERATION_FAILED", "removal was interrupted before its intent; no stop was submitted", { target });
      intentAttempted = true;
      intent = writeAgentRemovalAttempt(root, original, receipt);
      for (const [ordinal, agent] of receipt.createdAgents.entries()) {
        unchanged();
        if (signal.aborted) throw new Error("removal observation interrupted");
        let state = (await readSlots([agent]))[0]!;
        let requestId: string | undefined;
        if (!state.retired) {
          if (state.slot.slotPhase !== "active" || !state.slot.live) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the original incarnation changed before stop submission; no replacement was stopped", { target: { ...target, agent: agent.name } });
          const stopped = await askManager(space, control.server, "stop", { name: agent.name }, control.auth, "any", 10_000, { instanceId: manager, expectedTarget: { id: agent.id, lifecycleUid: agent.lifecycleUid }, journal: {
            beforeSubmit(request) {
              unchanged();
              if (signal.aborted) throw new Error("removal interrupted before stop");
              requestId = request.requestId;
              writeAgentRemovalStep(root, intent!, ordinal, { phase: "submitted", requestId });
              stops.push({ name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid, requestId, acknowledged: false });
            },
            accepted() { throw new Error("a stop unexpectedly returned a launch allocation"); },
          } });
          if (!stopped.ok) {
            const request = stops.find((row) => row.requestId === requestId);
            if (request && stopped.nativeOutcome === "not-executed") request.notExecuted = true;
            throw managerFailure(stopped, "guarded agent stop", { ...target, agent: agent.name });
          }
          const result = stopped.data as { name?: unknown; stopped?: unknown } | undefined;
          if (!requestId || result?.name !== agent.name || result.stopped !== true || stopped.managerInstanceId !== manager) throw new Error("the stop acknowledgement was not attributed to the original request");
          stops[stops.length - 1]!.acknowledged = true;
          const deadline = Date.now() + 30_000;
          do {
            if (signal.aborted) throw new Error("removal observation interrupted");
            state = (await readSlots([agent]))[0]!;
            if (state.retired) break;
            if (Date.now() >= deadline) throw new Error("native retirement and cleanup did not confirm within the observation window");
            await delay(200, undefined, { signal });
          } while (!state.retired);
        }
        const proof = state.retired;
        if (!proof) throw new Error("native retirement did not return a terminal proof");
        retired.push(proof);
        writeAgentRemovalStep(root, intent, ordinal, { phase: "retired", ...(requestId ? { requestId } : {}), observation: proof });
      }
      writeAgentRemovalReceipt(root, intent, retired);
      if (!listAdditiveTeamAttempts(root).removal?.returned.some((row) => row.deploymentId === deploymentId)) throw new Error("the complete native retirement receipt did not read back");
      returned = true;
    } catch (error) {
      failure = error instanceof CommandFailure ? error : new CommandFailure(intentAttempted ? "unknown" : "refused", intentAttempted ? "OPERATION_UNKNOWN" : "TARGET_UNAVAILABLE", intentAttempted ? "not every native retirement and durable receipt was confirmed; no stop was replayed and later agents were not attempted" : "removal preflight did not confirm an unchanged target; no stop was submitted", { target });
      if (intentAttempted && failure.outcome !== "unknown") {
        const unresolvedStop = stops.some((row) => !row.notExecuted && !retired.some((proof) => proof.lifecycleUid === row.lifecycleUid));
        failure = new CommandFailure(unresolvedStop ? "unknown" : retired.length ? "partial" : "refused", unresolvedStop ? "OPERATION_UNKNOWN" : retired.length ? "OPERATION_PARTIAL" : failure.code, "the removal sequence stopped before completing every original incarnation; acknowledged stops are not retirement receipts", { target, native: { code: failure.code, outcome: failure.outcome }, changed: [...retired, ...stops] });
      }
    }
    return { intentAttempted, returned, retired, stops, ...(failure ? { failure } : {}) };
  } };
}

/** One row per original incarnation: its native retirement, stop or unattempted state. */
export function agentOutcomeRows(receipt: AdditiveAgentReceipt, run: Pick<AgentRetirementRun, "retired" | "stops">) {
  return receipt.createdAgents.map((agent) => ({ name: agent.name, uid: agent.lifecycleUid, state: run.retired.some((row) => row.lifecycleUid === agent.lifecycleUid) ? "native retired and cleaned" : run.stops.find((row) => row.lifecycleUid === agent.lifecycleUid)?.notExecuted ? "stop refused; not executed" : run.stops.find((row) => row.lifecycleUid === agent.lifecycleUid)?.acknowledged ? "stop acknowledged; retirement unconfirmed" : run.stops.some((row) => row.lifecycleUid === agent.lifecycleUid) ? "stop outcome unknown" : "not attempted" }));
}

export interface AgentReconcileRun { recorded: AgentSettlement[]; settlements: AgentSettlement[]; returned: boolean; failure?: CommandFailure }

/** Reconcile the retirement phase of an unsettled static intent from the original manager's durable
 * slot and head only. The read uses the privileged control instrument, which holds no stop or
 * attach rows, and calls only `slots`: no stop, retry or name-based
 * target. An unconfirmed stop settles only when the original UID's slot and head are retired with
 * cleanup complete. A live original, a successor under the alias, or an in-flight terminal stays
 * open. Never-submitted incarnations are reported unattempted and are not continued. */
export async function prepareAgentReconcile(input: { root: string; space: string; deploymentId: string; original: AdditiveTeamAttempt; receipt: AdditiveAgentReceipt; intent: AgentRemovalAttempt }) {
  const { root, space, deploymentId, original, receipt, intent } = input, target = { root, space, deploymentId };
  if (original.authMode !== "auth" || !original.managerInstanceId) throw new CommandFailure("refused", "UNSUPPORTED", "retirement reconciliation needs a static-auth deployment with its recorded manager; open and user-auth managers keep no durable slot projection", { target });
  const manager = original.managerInstanceId, digest = contractDigest(receipt);
  if (intent.managerInstanceId !== manager || intent.originalReceiptDigest !== digest || intent.root !== original.root || intent.space !== original.space) throw new CommandFailure("refused", "CONFLICT", "the removal intent is not bound to the original deployment and manager; nothing was reconciled", { target });
  const selected = findMesh(space);
  if (!selected || selected.mode !== "auth" || canonicalRoot(selected.root) !== root || selected.server !== original.server || (selected.tlsRequired === true) !== original.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the registered root, broker, auth mode or transport differs from the original deployment", { target });
  const control = await resolveControlTarget({ space }, "control-caller-privileged", manager, { onRefusal: "throw" });
  if (!control.root || canonicalRoot(control.root) !== root || control.server !== selected.server || control.mode !== "auth" || (control.auth.tls === true) !== original.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the original manager's slot-read caller resolved another target; nothing was reconciled", { target });
  const intentText = JSON.stringify(intent);
  const unchanged = () => {
    if (JSON.stringify(findMesh(space)) !== JSON.stringify(selected)) throw new CommandFailure("refused", "CONFLICT", "the selected registration changed; nothing further was recorded", { target });
    const current = listAdditiveTeamAttempts(root), now = current.returned.find((row) => row.deploymentId === deploymentId);
    if (current.refused.length || !now || contractDigest(now) !== digest || JSON.stringify(current.valid.find((row) => row.deploymentId === deploymentId)) !== JSON.stringify(original) || JSON.stringify(current.removal?.attempts.find((row) => row.deploymentId === deploymentId)) !== intentText || current.removal?.returned.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "CONFLICT", "the original deployment, its removal intent or its removal records changed; nothing further was recorded", { target });
    return current.removal!.steps.filter((row) => row.deploymentId === deploymentId);
  };
  const classify = async (steps: readonly AgentRemovalStep[]): Promise<AgentSettlement[]> => {
    const submittedOpen = receipt.createdAgents.filter((_, ordinal) => steps.some((row) => row.ordinal === ordinal && row.phase === "submitted") && !steps.some((row) => row.ordinal === ordinal && row.phase === "retired"));
    let rows: SlotRow[] = [], epoch = 0;
    if (submittedOpen.length) {
      const answer = await askManager(space, control.server, "slots", { names: submittedOpen.map((row) => row.name), includeRetired: true }, control.auth, "any", 2_000, { instanceId: manager });
      if (!answer.ok) throw managerFailure(answer, "retirement reconciliation read", target);
      const data = answer.data as SlotRow[];
      if (answer.managerInstanceId !== manager || !Number.isSafeInteger(answer.managerEpoch) || !Array.isArray(data) || data.length > submittedOpen.length || new Set(data.map((row) => row.name)).size !== data.length || data.some((row) => !submittedOpen.some((agent) => agent.name === row.name))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the original manager did not return a bounded attributed slot read; nothing was reconciled", { target });
      rows = data; epoch = answer.managerEpoch!;
    }
    const observedAt = new Date().toISOString();
    return receipt.createdAgents.map((agent, ordinal) => classifyAgent({ ordinal, agent: { name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid }, owner: DEV_OWNER, manager, managerEpoch: epoch, steps, deploymentId, slot: rows.find((row) => row.name === agent.name), observedAt }));
  };
  const settlements = await classify(unchanged());
  return { manager, settlements, async execute(): Promise<AgentReconcileRun> {
    const recorded: AgentSettlement[] = [];
    let returned = false, failure: CommandFailure | undefined, current = settlements;
    try {
      if (readMaintenanceJournal(root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a maintenance operation is recorded; nothing was reconciled", { target });
      // Re-observe under the lock, so the recorded facts are the ones this holder saw.
      current = await classify(unchanged());
      const contradiction = current.find((row) => row.state === "contradiction");
      if (contradiction) throw new CommandFailure("refused", "CONFLICT", `agent ${contradiction.agent.name}: ${contradiction.state === "contradiction" ? contradiction.reason : ""}; nothing was recorded`, { target: { ...target, agent: contradiction.agent.name } });
      for (const row of current) {
        if (row.state !== "record") continue;
        unchanged();
        writeAgentRemovalStep(root, intent, row.ordinal, { phase: "retired", requestId: row.requestId, observation: row.observation });
        recorded.push(row);
      }
      const steps = unchanged();
      const proofs = receipt.createdAgents.map((_, ordinal) => steps.find((row): row is Extract<AgentRemovalStep, { phase: "retired" }> => row.ordinal === ordinal && row.phase === "retired")?.observation);
      current = current.map((row) => row.state === "record" ? { ordinal: row.ordinal, agent: row.agent, state: "settled" as const } : row);
      if (proofs.every((row) => row !== undefined)) {
        writeAgentRemovalReceipt(root, intent, proofs as AgentRetirementObservation[]);
        if (!listAdditiveTeamAttempts(root).removal?.returned.some((row) => row.deploymentId === deploymentId)) throw new Error("the reconciled retirement receipt did not read back");
        returned = true;
      }
    } catch (error) {
      failure = error instanceof CommandFailure ? error : new CommandFailure(recorded.length ? "partial" : "unknown", recorded.length ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "not every reconciliation record was confirmed; no stop was attempted", { target, changed: recorded.map((row) => row.agent.name) });
    }
    return { recorded, settlements: current, returned, ...(failure ? { failure } : {}) };
  } };
}

/** One row per original incarnation for a reconciliation preview or result. */
export function agentSettlementRows(settlements: readonly AgentSettlement[]) {
  return settlements.map((row) => ({ name: row.agent.name, uid: row.agent.lifecycleUid, state: row.state === "settled" ? "recorded: native retired and cleaned" : row.state === "record" ? `observed now: retired and cleaned (slot ${row.observation.slotRevision}, head ${row.observation.headRevision})` : row.state === "in-progress" ? `terminal in progress (${row.slotPhase}${row.headState ? `, head ${row.headState}` : ""}); re-observe later` : row.state === "unknown" ? `stop outcome unknown; ${row.reason === "alias-names-a-successor" ? "the alias now names a successor" : row.reason === "original-incarnation-still-live" ? "the original incarnation is still live" : row.reason === "retired-without-cleanup-proof" ? "the slot is retired without cleanup or head proof" : "the slot is active with no live process, which settles nothing"}` : row.state === "unattempted" ? "never submitted; not attempted" : `contradiction: ${row.reason}` }));
}

export const AGENT_RECONCILE_NOTE = "Reconciliation records only the original manager's durable retired slot and head for the original lifecycle UID, with cleanup complete. Process absence settles nothing. No stop was sent or retried, and never-submitted incarnations stay unattempted. An unsettled intent stays blocking.";

/** Settle an unsettled static agent-only retirement intent from native slot observation. */
async function reconcileAgentTeam(input: { root: string; space: string; deploymentId: string; original: AdditiveTeamAttempt; receipt: AdditiveAgentReceipt; intent: AgentRemovalAttempt; values: TeamValues }): Promise<void> {
  const { root, space, deploymentId, original, receipt, intent, values } = input, target = { root, space, deploymentId };
  const phase = await prepareAgentReconcile({ root, space, deploymentId, original, receipt, intent });
  const preview = { kind: "agent-team-removal-reconcile-preview" as const, deploymentId, managerInstanceId: phase.manager, agents: phase.settlements, recordable: phase.settlements.filter((row) => row.state === "record").length, effectAttempted: false as const, continuationOffered: false as const };
  const view = (data: typeof preview): Report => ({ sections: [{ title: "Unsettled agent retirement", blocks: [
    { kind: "fields", rows: [["Deployment", deploymentId], ["Manager", data.managerInstanceId], ["Would record", String(data.recordable)]] },
    { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Original lifecycle" }, { key: "state", label: "Observation" }], rows: agentSettlementRows(data.agents) },
    { kind: "lines", lines: [AGENT_RECONCILE_NOTE] },
  ] }] });
  if (values["dry-run"]) { writeResult(presentationOf(values), { command: "team remove", target, result: preview, completeness: "partial", partial: { message: "The original manager's slots were read in order, not atomically. Nothing was recorded or stopped." } }, view); return; }
  if (!values.yes) {
    if (!canPrompt() || values.json) throw new CommandFailure("refused", "USAGE_INVALID", "scripted reconciliation needs --yes after reviewing which observations it records", { target });
    const answer = await prompts.confirm({ message: `Record ${preview.recordable} observed retirement(s) for this unsettled removal? No stop is sent.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) { writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "agent-team-removal-reconcile", recorded: 0 }, noOp: true }, () => ({ sections: [{ title: "Nothing recorded", blocks: [{ kind: "lines", lines: ["The unsettled intent is unchanged."] }] }] })); return; }
  }
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); } catch { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the root maintenance lock could not be acquired; nothing was reconciled", { target }); }
  let run: AgentReconcileRun, lockFailure: CommandFailure | undefined;
  try { run = await phase.execute(); }
  finally { try { releaseMaintenanceLock(lock); } catch { lockFailure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "the root maintenance lock release did not confirm; recorded observations stand", { target }); } }
  const open = run.settlements.filter((row) => row.state !== "settled");
  const failure = run.failure ?? lockFailure ?? (run.returned ? undefined : new CommandFailure(run.recorded.length ? "partial" : "refused", run.recorded.length ? "OPERATION_PARTIAL" : "LIFECYCLE_BLOCKED", "the removal stays unsettled: some original incarnations are unknown, in progress or unattempted; no stop was sent", { target: { ...target, openAgents: open.map((row) => ({ name: row.agent.name, state: row.state })) } }));
  writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "agent-team-removal-reconcile", deploymentId, managerInstanceId: phase.manager, returnedReceipt: run.returned, recorded: run.recorded.map((row) => row.agent.name), agents: run.settlements, effectAttempted: false, retryAuthorized: false }, ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [{ title: data.returnedReceipt ? "Agent retirement settled" : "Agent retirement still unsettled", blocks: [
    { kind: "fields", rows: [["Deployment", deploymentId], ["Manager", phase.manager], ["Recorded now", String(data.recorded.length)], ["Full removal receipt", data.returnedReceipt ? "recorded" : "not recorded"]] },
    { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Original lifecycle" }, { key: "state", label: "Outcome" }], rows: agentSettlementRows(data.agents) },
    { kind: "lines", lines: [AGENT_RECONCILE_NOTE] },
  ] }] }));
}

/** Run under an interrupt guard that only stops later steps; no observed effect is reversed. */
export async function withInterruptGuard<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; signal: "SIGINT" | "SIGTERM" | undefined }> {
  const interrupted = new AbortController();
  let signal: "SIGINT" | "SIGTERM" | undefined;
  const interrupt = () => { signal = "SIGINT"; interrupted.abort(); }, terminate = () => { signal = "SIGTERM"; interrupted.abort(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try { return { value: await fn(interrupted.signal), signal }; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}

/** Remove only a returned static agent-only deployment. */
export async function removeAgentTeam(deploymentId: string, values: TeamValues): Promise<void> {
  const catalog = personaCatalog(values), root = canonicalRoot(catalog.root), space = catalog.space;
  const target = { root, space, deploymentId };
  const inventory = listAdditiveTeamAttempts(root), original = inventory.valid.find((row) => row.deploymentId === deploymentId);
  const receipt = inventory.returned.find((row) => row.deploymentId === deploymentId);
  if (inventory.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "unreadable deployment or removal records remain; no stop target was inferred", { target });
  if (!original || !receipt || receipt.kind !== "additive-agent-receipt" || original.authMode !== "auth" || receipt.createdChannels.length || original.declaredChannels.length || !original.managerInstanceId || receipt.createdAgents.length > 100) throw new CommandFailure("refused", "UNSUPPORTED", "guarded removal currently needs a full static agent-only returned receipt; mixed/channel, open/user-auth, legacy and unsettled deployments were not routed through a weaker stop", { target });
  if (original.space !== space || canonicalRoot(original.root) !== root) throw new CommandFailure("refused", "CONFLICT", "the deployment belongs to another selected root or space; no identity was rebound", { target });
  const manager = original.managerInstanceId;
  const prior = inventory.removal?.returned.find((row) => row.deploymentId === deploymentId);
  if (prior) {
    writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "agent-team-removal", recordedState: "retirements-returned", noOp: true, removal: prior, currentAliasState: "not-rechecked" }, noOp: true }, (data): Report => ({ sections: [{ title: "Agent removal already recorded", blocks: [{ kind: "fields", rows: [["Deployment", deploymentId], ["Manager", manager], ["Retired lifecycle receipts", String(data.removal.retiredAgents.length)], ["Current aliases", "not rechecked"]] }, { kind: "lines", lines: ["The original incarnations have a complete historical removal receipt. No stop was repeated and no current name holder was selected."] }] }] }));
    return;
  }
  const unsettled = inventory.removal?.attempts.find((row) => row.deploymentId === deploymentId);
  if (unsettled) return reconcileAgentTeam({ root, space, deploymentId, original, receipt, intent: unsettled, values });
  const phase = await prepareAgentRetirement({ root, space, deploymentId, original, receipt });
  const preview = { kind: "agent-team-removal-preview", deploymentId, managerInstanceId: manager, agents: phase.agents, channels: 0, dryRun: true, effectAttempted: false, atomicSnapshot: false };
  const view = (data: typeof preview): Report => ({ sections: [{ title: "Agent team removal impact", blocks: [{ kind: "fields", rows: [["Deployment", deploymentId], ["Manager", manager], ["Original incarnations", String(data.agents.length)], ["Channels", "none"], ["Read consistency", "ordered, not atomic"]] }, { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "id", label: "Identity" }, { key: "uid", label: "Lifecycle" }, { key: "state", label: "Native observation" }], rows: data.agents.map((row) => ({ name: row.name, id: row.id, uid: row.lifecycleUid, state: row.observedState })) }, { kind: "lines", lines: ["Apply rechecks each original incarnation, requests each necessary stop once, and waits for native retirement and cleanup evidence. Missing rows and stop acknowledgements are not completion. No channel, service, broker or successor agent is in scope."] }] }] });
  if (values["dry-run"]) { writeResult(presentationOf(values), { command: "team remove", target, result: preview }, view); return; }
  if (!values.yes) {
    if (!canPrompt() || values.json) throw new CommandFailure("refused", "USAGE_INVALID", "scripted agent-team removal needs --yes after reviewing its native impact", { target });
    const answer = await prompts.confirm({ message: `Retire ${receipt.createdAgents.length} recorded agent incarnation(s) from ${oneLine(space)}? No channels or services will be removed.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) { writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "agent-team-removal", removed: false }, noOp: true }, () => ({ sections: [{ title: "Team kept", blocks: [{ kind: "lines", lines: ["No removal intent or stop was submitted."] }] }] })); return; }
  }
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); } catch { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the root maintenance lock could not be acquired; no removal intent or stop was submitted", { target }); }
  let run: AgentRetirementRun, signal: "SIGINT" | "SIGTERM" | undefined, lockReleaseFailed = false;
  try { ({ value: run, signal } = await withInterruptGuard((abort) => phase.execute(abort))); }
  finally {
    try { releaseMaintenanceLock(lock); } catch { lockReleaseFailed = true; }
  }
  const failure = run.failure ?? (lockReleaseFailed ? new CommandFailure(run.returned ? "partial" : "unknown", run.returned ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "the root maintenance lock release did not confirm; no native effect was repeated", { target }) : undefined);
  writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "agent-team-removal", deploymentId, managerInstanceId: manager, returnedReceipt: run.returned, retiredAgents: run.retired, stopRequests: run.stops, retainedIntent: run.intentAttempted, channelsRemoved: 0, retryAuthorized: false }, ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [{ title: data.returnedReceipt ? "Agent team retirement returned" : "Agent team removal incomplete", blocks: [
    { kind: "fields", rows: [["Deployment", deploymentId], ["Manager", manager], ["Native retired/cleaned receipts", `${data.retiredAgents.length} of ${receipt.createdAgents.length}`], ["Full removal receipt", data.returnedReceipt ? "recorded" : "not confirmed"], ["Channels removed", "none"]] },
    { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Original lifecycle" }, { key: "state", label: "Observed outcome" }], rows: agentOutcomeRows(receipt, run) },
    { kind: "lines", lines: ["The original UID, slot/head terminal and cleanup must all match. Stops were not replayed, no successor name holder was targeted, and no channel, service or broker was removed. An unsettled intent stays blocking; a complete removal receipt releases only this deployment's known additive blocker."] },
  ] }] }));
  if (signal) process.exitCode = signal === "SIGINT" ? 130 : 143;
}
