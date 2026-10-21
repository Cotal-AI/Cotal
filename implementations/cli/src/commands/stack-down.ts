/** Controller-owned whole-stack shutdown over the exact members the stack journal records. The
 *  complete set, the manager's native agent impact and the broker binding are shown before any
 *  confirmation. Stops run manager, then delivery, then a user stack's auth service, then the
 *  broker, whose kernel-exit scope is
 *  recomputed only after every earlier member is confirmed gone. A member that is already gone is
 *  recorded as such under its definition's lock and is not stopped again, so a repeated stop is a
 *  no-op. Shared registry and credential cleanup follow only a complete confirmed stop. Nothing
 *  outside the recorded members is touched. The whole apply holds the root's maintenance lock. */
import * as prompts from "../lib/prompts.js";
import type { ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, canonicalRoot, deliveryCredsKey, isCommandFailure, oneLine, presentationOf,
  releaseMaintenanceLock, removeMeshesByRoot, recordPreparedSpace, renderReport, terminalWidth, workspaceSecretStore, writeResult,
  type MaintenanceLock, type Report, type ServiceAdapterKernelStopPlan, type ServiceAdapterStopPlan,
  recordOperationSpace,
} from "@cotal-ai/workspace";
import { canPrompt } from "./meshes-wizard.js";
import { kernelImpactView, nativeImpactView } from "./service-actions.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts, prepareKernelServiceStop, prepareNativeServiceStop, settleExitedInstance, stopProcessService } from "../lib/service-process.js";
import { acquireStackOperationLock, newStackOperation, previewStackSettlement, processGone, readStackJournal, refuseControllerCut, settleStackOperation, stackMaintenanceFence, stackOperationUnsettled, stackScopeRefusals, stackSettlementNotice, withSettledMembers, writeStackJournal, type StackJournal, type StackJournalSnapshot, type StackMember, type StackRole, type StackSettlement } from "../lib/stack-journal.js";

const STOP_ORDER: readonly StackRole[] = ["manager", "delivery", "auth", "broker"];

interface Member { role: StackRole; definition: ServiceDefinitionSnapshot; instance: ServiceInstanceSnapshot; live: boolean; native?: ServiceAdapterStopPlan }

/** The controller route applies whenever the root has a stack journal. */
export function controllerStackRecorded(root: string): boolean {
  return readStackJournal(canonicalRoot(root)) !== undefined;
}

export function validateStackDownArguments(root: string, values: ParsedArgs["values"]): void {
  const preserve = values["preserve-state"] === true;
  const allowed = new Set(preserve ? ["space", "yes", "json", "plain", "preserve-state", "store-dir", "session-store"] : ["space", "yes", "dry-run", "json", "plain", "with-agents"]);
  const unsupported = Object.keys(values).filter((name) => !allowed.has(name) && values[name] !== undefined && !(Array.isArray(values[name]) && (values[name] as unknown[]).length === 0));
  if (unsupported.length) throw new CommandFailure("refused", "USAGE_INVALID", preserve ? "a controller stack's preserve accepts only --space, --store-dir, --session-store, --yes and presentation flags; it is exclusive with --with-agents and --dry-run" : "a controller stack's bare down accepts only --space, --with-agents, --yes, --dry-run and presentation flags; no other option was ignored", { target: { options: unsupported } });
  if (values["dry-run"] === true && values.yes === true) throw new CommandFailure("refused", "USAGE_INVALID", "--yes acknowledges a guarded apply, not a read-only stack preview");
  if (preserve) refuseControllerCut(root, "down --preserve-state");
}

/** Each recorded member, read without writing. A live process is stopped by its own policy, whatever
 *  its readiness record says. A gone one, settled or crashed, is recorded and not stopped again. A
 *  retained stop request, or a process that is neither live nor proven gone, refuses. */
function readMembers(journal: StackJournal): Member[] {
  const members: Member[] = [];
  for (const row of journal.members) {
    if (row.instanceId === null) continue;
    const definition = serviceDefinitionStore(journal.space).read(row.definition);
    if (!definition) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "a recorded stack member's definition is missing; no member was stopped and no absence was inferred", { target: { space: journal.space, definition: row.definition, instanceId: row.instanceId } });
    const instance = serviceInstanceStore(journal.space).read(row.instanceId);
    if (!instance || instance.record.value.definition !== row.definition) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "a recorded stack member's exact instance record is missing or belongs to another definition; no member was stopped", { target: { space: journal.space, definition: row.definition, instanceId: row.instanceId } });
    const state = observeServiceProcess(instance.record.value);
    const inspect = `inspect it with cotal service status ${row.definition} --instance ${row.instanceId} --space ${journal.space}`;
    if (!processGone(state) && state !== "running") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a recorded stack member is foreign, unreadable or has an unresolved launch; no member was stopped", { target: instanceProjection(instance), remedy: inspect });
    if (instance.record.value.state === "stopping") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a recorded stack member retains an unconfirmed stop request; it was not resubmitted and no member was stopped", { target: instanceProjection(instance), remedy: inspect });
    assertNoServiceUnitAttempts(journal.space, row.definition);
    members.push({ role: row.role, definition, instance, live: state === "running" });
  }
  return members.sort((a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role));
}

/** A live manager's agent impact is read through the broker on an authenticated stack. When the
 *  stack's broker is gone that read cannot succeed, so the refusal names the command that brings
 *  the broker back while keeping the live manager. */
async function managerImpact(journal: StackJournal, members: readonly Member[], manager: Member, withAgents: boolean): Promise<ServiceAdapterStopPlan | undefined> {
  try { return await prepareNativeServiceStop(manager.definition, manager.instance, withAgents); }
  catch (error) {
    if (members.some((member) => member.role === "broker" && member.live) || !isCommandFailure(error)) throw error;
    throw new CommandFailure("refused", error.code, "the stack's broker is not running, so the live manager's agent impact cannot be read; no member was stopped", { target: { root: journal.root, space: journal.space, manager: manager.instance.name }, native: { code: error.code, outcome: error.outcome, detail: error.message }, remedy: `run cotal up --space ${journal.space} to restart the broker from its recorded inputs while the manager keeps running, then run cotal down` });
  }
}

/** Everything outside the recorded members that would be cut off refuses before the first signal.
 *  Returns a settled active restore of this stack that was admitted, for the result to name. */
function scopeRefusals(journal: StackJournal): string | undefined {
  const maintenance = stackMaintenanceFence(journal.root, journal);
  if (maintenance.fenced) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance attempt; the controller stack was not stopped under it", { target: { root: journal.root } });
  stackScopeRefusals(journal, "bare cotal down");
  return maintenance.admittedRestore;
}

/** The retained active restore an admitted stop names. */
function restoreNotice(attemptId: string | undefined): Report["sections"] {
  return attemptId ? [{ title: "Retained restore journal", blocks: [{ kind: "lines", lines: [`Active restore ${attemptId} stays in this root's maintenance journal. It was read and not changed.`] }] }] : [];
}

function planView(journal: StackJournal, members: readonly Member[], withAgents: boolean, settlement?: StackSettlement): Report {
  // The order names only members with a recorded instance; a member never started is not planned.
  const order = STOP_ORDER.filter((role) => members.some((member) => member.role === role));
  return { space: journal.space, sections: [{ title: "Whole-stack stop plan", blocks: [
    { kind: "fields", rows: [["Space", journal.space], ["Root", journal.root], ["Broker", journal.server], ["Agent policy", withAgents ? "stop and deprovision every managed agent" : "manager's native default"], ["Mode", journal.mode === "open" ? "open, no delivery member" : journal.mode === "user" ? "user auth" : "static auth"], ["Order", order.length ? order.map((role) => role === "auth" ? "auth service" : role).join(", ") : "none"]] },
    members.length ? { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Process" }], rows: members.map((member) => ({ role: member.role, definition: member.definition.name, instance: member.instance.name, state: member.live ? "running" : "already gone" })) }
      : { kind: "lines", lines: ["No member has a recorded instance, so there is nothing to stop."] },
    { kind: "lines", lines: [
      ...(settlement ? [`The earlier ${settlement.operation.kind} ${settlement.operation.id} has no recorded outcome. The stop first records it as failed from these members' processes.`] : []),
      "Only these recorded instances are controlled. Services outside the stack and remote managers are not touched. A member already gone is recorded as stopped without a signal. The broker's exact scope is rechecked after the manager and delivery are confirmed stopped; a change there stops the sequence with the broker still running.",
    ] },
  ] }] };
}

export async function stackDown(rootInput: string, values: ParsedArgs["values"]): Promise<void> {
  // It refuses --preserve-state on a controller root, so only a bare stop continues.
  validateStackDownArguments(rootInput, values);
  const presentation = presentationOf(values), interactive = canPrompt() && presentation !== "json";
  const withAgents = values["with-agents"] === true;
  const root = canonicalRoot(rootInput);
  // The preview reads without the lock and writes nothing. The real stop holds the root's
  // maintenance lock from its first read to its last write, so no other whole-stack operation runs.
  if (values["dry-run"] === true) return previewStackStop(root, values, presentation, withAgents);
  const lock = acquireStackOperationLock(root);
  try { await applyStackStop(root, values, presentation, interactive, withAgents, lock); }
  finally { releaseMaintenanceLock(lock); }
}

/** The recorded stack this stop targets, with every refusal that needs no lock or write. An earlier
 *  preserve or resume with no outcome is decided by its own maintenance attempt; an earlier up or
 *  down with none is classified read-only from its members, and refuses if any is unresolved. */
function stopTarget(root: string, values: ParsedArgs["values"]) {
  const previous = readStackJournal(root);
  if (!previous) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this root has no controller stack journal", { target: { root } });
  const journal0 = previous.journal;
  recordOperationSpace(journal0.space);
  if (values.space !== undefined && values.space !== journal0.space) throw new CommandFailure("refused", "CONFLICT", "the selected space differs from this root's recorded controller stack; no member was stopped", { target: { root, selectedSpace: values.space, recordedSpace: journal0.space } });
  if (stackOperationUnsettled(journal0) && journal0.operation.kind !== "up" && journal0.operation.kind !== "down")
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier preserve or resume on this root has no settled outcome; it is decided by its own maintenance attempt and no member was stopped", { target: { root, operation: journal0.operation }, remedy: `inspect the root's maintenance attempt and the stack's members with cotal service --space ${journal0.space}` });
  const settlement = previewStackSettlement(journal0);
  // The members and the scope check include each member the settlement found, so a member whose
  // start was cut off before its instance was recorded is stopped as a member.
  const scoped = withSettledMembers(journal0, settlement);
  const members = readMembers(scoped);
  return { previous, journal0: scoped, settlement, members, target: { root, space: journal0.space, server: journal0.server } };
}

function previewStackStop(root: string, values: ParsedArgs["values"], presentation: ReturnType<typeof presentationOf>, withAgents: boolean): void {
  const { journal0, settlement, members, target } = stopTarget(root, values);
  // A preview reports what would refuse the real stop instead of refusing itself.
  let blocked: CommandFailure | undefined, restore: string | undefined;
  try { restore = scopeRefusals(journal0); }
  catch (error) { if (!isCommandFailure(error)) throw error; blocked = error; }
  const warnings = blocked ? [{ code: blocked.code, target: blocked.target, message: `the real stop would refuse: ${blocked.message}${blocked.remedy ? `; ${blocked.remedy}` : ""}` }] : [];
  // A preview that changes nothing succeeds. It is partial only in what it read: no provider and
  // no manager impact, which the real stop reads and confirms before any signal.
  writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop-preview", ...target, withAgents, members: members.map((member) => ({ role: member.role, definition: member.definition.name, instanceId: member.instance.name, process: member.live ? "running" : "gone" })), settlesOperation: settlement ?? null, blockedBy: blocked?.detail() ?? null, nativeImpactChecked: false, dryRun: true, signalled: false, admittedRestore: restore ?? null }, completeness: "partial", warnings }, () => {
    const view = planView(journal0, members, withAgents, settlement);
    return { ...view, sections: [...view.sections, ...restoreNotice(restore), { title: "Preview", blocks: [{ kind: "lines", lines: ["Nothing was stopped or written. The preview reads recorded members only; it loads no provider and queries no manager impact. The real stop reads and confirms that impact before any signal."] }] }] };
  });
}

async function applyStackStop(root: string, values: ParsedArgs["values"], presentation: ReturnType<typeof presentationOf>, interactive: boolean, withAgents: boolean, lock: MaintenanceLock): Promise<void> {
  const { previous, journal0, settlement, members, target } = stopTarget(root, values);
  const admittedRestore = scopeRefusals(journal0);
  if (!values.yes && !interactive) throw new CommandFailure("refused", "USAGE_INVALID", "stopping the whole controller stack requires --yes outside an interactive terminal", { target });
  // Complete native impact before confirmation. The broker's own kernel scope cannot be prepared
  // while its dependants run; it is recomputed after they stop and refuses on any change then.
  const manager = members.find((member) => member.role === "manager" && member.live);
  if (manager) {
    manager.native = await managerImpact(journal0, members, manager, withAgents);
    if (!manager.native) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the manager's native agent impact could not be established; no member was stopped", { target: instanceProjection(manager.instance) });
  } else if (withAgents) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--with-agents needs the stack's live manager and its native impact; no member was stopped", { target });
  if (presentation !== "json") {
    console.log(renderReport(planView(journal0, members, withAgents, settlement), presentation, terminalWidth(process.stdout)));
    if (manager?.native) console.log(renderReport(nativeImpactView(manager.native), presentation, terminalWidth(process.stdout)));
  }
  if (!values.yes) {
    const answer = await prompts.confirm({ message: `Stop every displayed member of ${oneLine(journal0.space)}'s controller stack with only the displayed native impact?`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop", ...target, cancelled: true, members: journal0.members }, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "no member was stopped" }] }, () => planView(journal0, members, withAgents, settlement));
      return;
    }
  }
  // An earlier operation with no outcome is recorded as failed from its members' evidence first.
  const { snapshot: settledSnapshot, settled } = settleStackOperation(lock, previous);
  let journal: StackJournal = { ...settledSnapshot.journal, operation: newStackOperation("down", withAgents), members: settledSnapshot.journal.members.map((row) => ({ ...row, state: row.instanceId === null ? "not-attempted" : "planned", code: undefined })), updatedAt: new Date().toISOString() };
  let snapshot: StackJournalSnapshot = writeStackJournal(root, settledSnapshot, journal);
  const mark = (role: StackRole, change: Partial<StackMember>) => {
    journal = { ...journal, members: journal.members.map((row) => row.role === role ? { ...row, ...change } : row), updatedAt: new Date().toISOString() };
    snapshot = writeStackJournal(root, snapshot, journal);
  };
  const settle = (phase: StackJournal["operation"]["phase"]) => {
    journal = { ...journal, operation: { ...journal.operation, phase }, updatedAt: new Date().toISOString() };
    snapshot = writeStackJournal(root, snapshot, journal);
  };
  settle("applying");
  const changed: unknown[] = [];
  let failure: CommandFailure | undefined;
  for (const member of members) {
    const role = member.role;
    const holds = serviceDefinitionStore(journal.space).pin(member.definition);
    try {
      const current = serviceInstanceStore(journal.space).read(member.instance.name);
      if (!current) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a recorded member's instance record disappeared during the stop; no absence was inferred");
      if (!member.live) {
        // Gone when planned: its exit is recorded under this lock. Nothing is signalled, and the
        // adapter and its credential paths are not resolved again, so a repeated stop is a no-op.
        const row = settleExitedInstance(current), value = row.record.value;
        if (!processGone(observeServiceProcess(value)) || !["stopped", "failed"].includes(value.state)) throw new CommandFailure("refused", "CONFLICT", "a member that was gone when the stop was planned changed before its turn; it was not signalled", { target: instanceProjection(row) });
        mark(role, { state: "already-stopped" });
        continue;
      }
      let kernel: ServiceAdapterKernelStopPlan | undefined;
      if (role === "broker") {
        // Recheck the whole scope now that earlier members are confirmed stopped.
        scopeRefusals(journal);
        kernel = await prepareKernelServiceStop(member.definition, current);
        if (kernel && presentation !== "json") console.log(renderReport(kernelImpactView(kernel), presentation, terminalWidth(process.stdout)));
      }
      const stopped = await stopProcessService(member.definition, current, holds, { plan: role === "manager" ? member.native : undefined, withAgents: role === "manager" && withAgents }, { plan: kernel });
      mark(role, { state: stopped.noOp ? "already-stopped" : "stopped" });
      if (!stopped.noOp) changed.push(instanceProjection(stopped.instance));
    } catch (error) {
      const classified = isCommandFailure(error) ? error : undefined;
      const uncertain = classified === undefined || classified.outcome === "unknown";
      mark(role, { state: uncertain ? "unknown" : classified!.outcome === "refused" ? "refused" : "failed", code: classified?.code ?? "OPERATION_UNKNOWN" });
      for (const later of STOP_ORDER.slice(STOP_ORDER.indexOf(role) + 1)) if (journal.members.find((row) => row.role === later)?.state === "planned") mark(later, { state: "not-attempted" });
      failure = new CommandFailure(uncertain ? "unknown" : changed.length ? "partial" : classified!.outcome, uncertain ? "OPERATION_UNKNOWN" : changed.length ? "OPERATION_PARTIAL" : classified!.code, `the ${role} did not confirm its stop${classified ? ` (${classified.message})` : ""}; later members were not attempted and completed stops were not rolled back`, { target: { ...target, operation: journal.operation.id, members: journal.members }, changed, ...(classified ? { native: { code: classified.code, outcome: classified.outcome, detail: classified.message } } : {}), remedy: classified?.remedy ?? `inspect the recorded members with cotal service --space ${journal.space} before another action; no failed or unknown stop was retried` });
      break;
    } finally {
      try { holds.release(); } catch { /* The reservation release is not confirmed; outcomes above stand. */ }
    }
  }
  if (!failure) {
    // Shared cleanup only after the whole recorded set is confirmed stopped. An open stack never
    // had a delivery credential, so none is removed or claimed removed. Each step is idempotent.
    try {
      if (journal.mode !== "open") await workspaceSecretStore(root).delete(deliveryCredsKey(journal.space, { injected: false, root }));
      removeMeshesByRoot(root);
      // The stopped stack stays a prepared local space at its own root, so the next bare up
      // restarts the same recorded members instead of needing a new registration.
      recordPreparedSpace({ space: journal.space, root, ts: new Date().toISOString() });
    } catch {
      failure = new CommandFailure("partial", "OPERATION_PARTIAL", journal.mode === "open" ? "every member stopped, but the mesh registration cleanup did not confirm" : "every member stopped, but the delivery credential or mesh registration cleanup did not confirm", { target, changed, remedy: journal.mode === "open" ? "inspect the root's registry entry; nothing was retried" : "inspect the root's delivery credential and registry entry; nothing was retried" });
    }
  }
  settle(failure ? (failure.outcome === "unknown" ? "unknown" : failure.outcome === "partial" ? "partial" : failure.outcome === "failed" ? "failed" : "refused") : "completed");
  writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop", ...target, operation: journal.operation, withAgents, members: journal.members, changed, managerImpact: manager?.native ?? null, atomic: false, cleanup: failure ? "not-confirmed" : journal.mode === "open" ? "registration-removed-no-delivery-credential" : "delivery-credential-and-registration-removed", admittedRestore: admittedRestore ?? null, settledOperation: settled ?? null }, ...(settled ? { warnings: [{ code: "OPERATION_SETTLED", target: { ...target, operation: settled.operation.id }, message: stackSettlementNotice(settled) }] } : {}), ...(failure ? { failure, completeness: "partial" as const } : changed.length ? {} : { noOp: true }) }, (result) => ({ sections: [...restoreNotice(admittedRestore), { title: failure ? "Controller stack stop incomplete" : changed.length ? "Controller stack stopped" : "Controller stack was not running; nothing was stopped", blocks: [
    { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Result" }], rows: result.members.filter((row) => row.instanceId !== null).map((row) => ({ role: row.role, instance: row.instanceId ?? "none", state: { text: row.state.replaceAll("-", " "), tone: ["stopped", "already-stopped"].includes(row.state) ? "ok" as const : ["refused", "failed"].includes(row.state) ? "failed" as const : "waiting" as const } })) },
    { kind: "lines", lines: ["A returned native manager stop and an observed broker exit are not proof of authority, lease, store or descendant cleanup. A member already gone was recorded without a signal. The stack journal and the saved definitions remain; the next bare cotal up reuses them."] },
  ] }] }));
}
