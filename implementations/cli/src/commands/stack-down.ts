/** Controller-owned whole-stack shutdown over the exact members the stack journal records. The
 *  complete set, the manager's native agent impact and the broker binding are shown before any
 *  confirmation. Stops run manager, then delivery, then a user stack's auth service, then the
 *  broker, whose kernel-exit scope is
 *  recomputed only after every earlier member is confirmed gone. Shared registry and credential cleanup follow
 *  only a complete confirmed stop. Nothing outside the recorded members is touched. */
import * as prompts from "../lib/prompts.js";
import { DEFAULT_SPACE, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, canonicalRoot, deliveryCredsKey, isCommandFailure, oneLine, presentationOf,
  removeMeshesByRoot, recordPreparedSpace, renderReport, terminalWidth, workspaceSecretStore, writeResult,
  type Presentation, type Report, type ServiceAdapterKernelStopPlan, type ServiceAdapterStopPlan,
  recordOperationSpace,
} from "@cotal-ai/workspace";
import { ConfirmationRequired } from "../lib/confirmation-required.js";
import { canPrompt } from "./meshes-wizard.js";
import { kernelImpactView, nativeImpactView } from "./service-actions.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances, serviceInstanceStore, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts, prepareKernelServiceStop, prepareNativeServiceStop, stopProcessService } from "../lib/service-process.js";
import { newStackOperation, processGone, readStackJournal, recordedProcessLine, recordedProcessesUnder, refuseControllerCut, stackMaintenanceFence, stackScopeRefusals, writeStackJournal, type StackJournal, type StackJournalSnapshot, type StackMember, type StackRole } from "../lib/stack-journal.js";

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

function readMembers(journal: StackJournal): Member[] {
  const members: Member[] = [];
  for (const row of journal.members) {
    if (row.instanceId === null) continue;
    const definition = serviceDefinitionStore(journal.space).read(row.definition);
    if (!definition) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "a recorded stack member's definition is missing; no member was stopped and no absence was inferred", { target: { space: journal.space, definition: row.definition, instanceId: row.instanceId } });
    const instance = serviceInstanceStore(journal.space).read(row.instanceId);
    if (!instance || instance.record.value.definition !== row.definition) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "a recorded stack member's exact instance record is missing or belongs to another definition; no member was stopped", { target: { space: journal.space, definition: row.definition, instanceId: row.instanceId } });
    const state = observeServiceProcess(instance.record.value);
    if (!processGone(state) && state !== "running") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a recorded stack member is foreign, unreadable or has an unresolved launch; no member was stopped", { target: instanceProjection(instance) });
    if (["starting", "stopping", "unknown"].includes(instance.record.value.state)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a recorded stack member retains an unsettled request; it was not resubmitted and no member was stopped", { target: instanceProjection(instance) });
    assertNoServiceUnitAttempts(journal.space, row.definition);
    members.push({ role: row.role, definition, instance, live: state === "running" });
  }
  return members;
}

/** Everything outside the recorded members that would be cut off refuses before the first signal.
 *  Returns a settled active restore of this stack that was admitted, for the result to name. */
function scopeRefusals(journal: StackJournal): string | undefined {
  const maintenance = stackMaintenanceFence(journal.root, journal);
  if (maintenance.fenced) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance attempt; the controller stack was not stopped under it", { target: { root: journal.root } });
  stackScopeRefusals(journal, "bare cotal down");
  return maintenance.admittedRestore;
}

/** A stack its own down stopped completely, with no recorded member and no other service instance of
 *  its space running since. Stopping it again would stop nothing. A stack that stopped any other way
 *  still takes the full stop, which also finishes its registration and credential cleanup. It reads
 *  service records under the Cotal home and no process record under the root: {@link nothingRunning}
 *  reads those, following no link, before it calls the stack stopped. */
function alreadyStopped(journal: StackJournal, members: readonly Member[]): boolean {
  if (journal.operation.kind !== "down" || journal.operation.phase !== "completed" || members.some((member) => member.live)) return false;
  const running = serviceInstances(journal.space).some((row) => !processGone(observeServiceProcess(row.record.value)) || ["starting", "stopping", "unknown"].includes(row.record.value.state));
  return !running;
}

/** A bare down of a stack that is not running stops nothing. It answers with a no-op and writes
 *  nothing, so it needs no --yes, and its preview shows the same. Before it says so it reads the
 *  root's process records: every descriptor's for this stack's space, and a `{space}` descriptor's
 *  for any space its records name. One that may still front a process refuses instead, naming each
 *  record and its pid in the message and the remedy, because no command shows another space's
 *  records; nothing is stopped, adopted or removed. A real --with-agents refuses too, because no
 *  running manager can stop the agents; its preview shows the no-op. The legacy route answers the
 *  same way. */
export function nothingRunning(presentation: Presentation, target: { root: string; space?: string; server?: string }, withAgents: boolean): void {
  // A root that names no space resolves to the default one, as `resolveSpace` answers.
  const remaining = recordedProcessesUnder(target.root, [target.space ?? DEFAULT_SPACE]);
  if (remaining.length) {
    const lines = remaining.map(recordedProcessLine);
    const checks = remaining.map((row) => row.pid === undefined ? row.path : `pid ${row.pid} at ${row.path}`);
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `recorded processes under this root may still run (${lines.join("; ")}), so bare down did not report the stack stopped; nothing was stopped, adopted or removed`, {
      target: { ...target, processes: lines },
      remedy: `check ${checks.join(", ")}; stop each process where it was started, or remove a record whose process is gone, then run \`cotal down\` again`,
    });
  }
  if (withAgents) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--with-agents needs the stack's running manager, and this folder's stack is not running; nothing was stopped", { target, remedy: "start it with `cotal up`, then run `cotal down --with-agents`" });
  writeResult(presentation, { command: "down", target, result: { kind: "stack-not-running", ...target }, noOp: true }, () => ({ sections: [
    { title: `The stack in ${target.root} is not running`, blocks: [{ kind: "lines", lines: ["Nothing was stopped."] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal up", description: "Start it" }] }] },
  ] }));
}

/** The retained active restore an admitted stop names. */
function restoreNotice(attemptId: string | undefined): Report["sections"] {
  return attemptId ? [{ title: "Retained restore journal", blocks: [{ kind: "lines", lines: [`Active restore ${attemptId} stays in this root's maintenance journal. It was read and not changed.`] }] }] : [];
}

function planView(journal: StackJournal, members: readonly Member[], withAgents: boolean): Report {
  // The order names only members with a recorded instance; a member never started is not planned.
  const order = STOP_ORDER.filter((role) => members.some((member) => member.role === role));
  return { space: journal.space, sections: [{ title: "Whole-stack stop plan", blocks: [
    { kind: "fields", rows: [["Space", journal.space], ["Root", journal.root], ["Broker", journal.server], ["Agent policy", withAgents ? "stop and deprovision every managed agent" : "manager's native default"], ["Mode", journal.mode === "open" ? "open, no delivery member" : journal.mode === "user" ? "user auth" : "static auth"], ["Order", order.length ? order.map((role) => role === "auth" ? "auth service" : role).join(", ") : "none"]] },
    members.length ? { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Process" }], rows: members.map((member) => ({ role: member.role, definition: member.definition.name, instance: member.instance.name, state: member.live ? "running" : "already gone" })) }
      : { kind: "lines", lines: ["No member has a recorded instance, so there is nothing to stop."] },
    { kind: "lines", lines: ["Only these recorded instances are controlled. Services outside the stack and remote managers are not touched. The broker's exact scope is rechecked after the manager and delivery are confirmed stopped; a change there stops the sequence with the broker still running."] },
  ] }] };
}

export async function stackDown(rootInput: string, values: ParsedArgs["values"]): Promise<void> {
  // It refuses --preserve-state on a controller root, so only a bare stop continues.
  validateStackDownArguments(rootInput, values);
  const presentation = presentationOf(values), interactive = canPrompt() && presentation !== "json";
  const withAgents = values["with-agents"] === true;
  const root = canonicalRoot(rootInput);
  const previous = readStackJournal(root);
  if (!previous) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this root has no controller stack journal", { target: { root } });
  if (["planned", "applying", "unknown"].includes(previous.journal.operation.phase)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "an earlier whole-stack operation on this root has no settled outcome; it was not retried", { target: { root, operation: previous.journal.operation }, remedy: `inspect the stack's members with cotal service --space ${previous.journal.space} before another whole-stack operation` });
  const journal0 = previous.journal;
  recordOperationSpace(journal0.space);
  if (values.space !== undefined && values.space !== journal0.space) throw new CommandFailure("refused", "CONFLICT", "the selected space differs from this root's recorded controller stack; no member was stopped", { target: { root, selectedSpace: values.space, recordedSpace: journal0.space } });
  const members = readMembers(journal0);
  const target = { root, space: journal0.space, server: journal0.server };
  if (alreadyStopped(journal0, members)) return nothingRunning(presentation, target, withAgents && values["dry-run"] !== true);
  if (values["dry-run"] === true) {
    // A preview reports what would refuse the real stop instead of refusing itself.
    let blocked: CommandFailure | undefined, restore: string | undefined;
    try { restore = scopeRefusals(journal0); }
    catch (error) { if (!isCommandFailure(error)) throw error; blocked = error; }
    const warnings = blocked ? [{ code: blocked.code, target: blocked.target, message: `the real stop would refuse: ${blocked.message}${blocked.remedy ? `; ${blocked.remedy}` : ""}` }] : [];
    writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop-preview", ...target, withAgents, members: members.map((member) => ({ role: member.role, definition: member.definition.name, instanceId: member.instance.name, process: member.live ? "running" : "gone" })), blockedBy: blocked?.detail() ?? null, nativeImpactChecked: false, dryRun: true, signalled: false, admittedRestore: restore ?? null }, completeness: "partial", warnings, partial: { message: "The preview reads recorded members only. It loads no provider and queries no manager impact; the real stop reads and confirms that impact before any signal." } }, () => { const view = planView(journal0, members, withAgents); return { ...view, sections: [...view.sections, ...restoreNotice(restore)] }; });
    return;
  }
  const admittedRestore = scopeRefusals(journal0);
  if (!values.yes && !interactive) throw new ConfirmationRequired("stopping the whole controller stack requires --yes outside an interactive terminal", { target, remedy: "run `cotal down --yes` to stop it; `cotal down --dry-run` shows what it stops" });
  // Complete native impact before confirmation. The broker's own kernel scope cannot be prepared
  // while its dependants run; it is recomputed after they stop and refuses on any change then.
  const manager = members.find((member) => member.role === "manager" && member.live);
  if (manager) {
    manager.native = await prepareNativeServiceStop(manager.definition, manager.instance, withAgents);
    if (!manager.native) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the manager's native agent impact could not be established; no member was stopped", { target: instanceProjection(manager.instance) });
  } else if (withAgents) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--with-agents needs the stack's live manager and its native impact; no member was stopped", { target });
  if (presentation !== "json") {
    console.log(renderReport(planView(journal0, members, withAgents), presentation, terminalWidth(process.stdout)));
    if (manager?.native) console.log(renderReport(nativeImpactView(manager.native), presentation, terminalWidth(process.stdout)));
  }
  if (!values.yes) {
    const answer = await prompts.confirm({ message: `Stop every displayed member of ${oneLine(journal0.space)}'s controller stack with only the displayed native impact?`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) {
      writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop", ...target, cancelled: true, members: journal0.members }, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "no member was stopped" }] }, () => planView(journal0, members, withAgents));
      return;
    }
  }
  let journal: StackJournal = { ...journal0, operation: newStackOperation("down", withAgents), members: journal0.members.map((row) => ({ ...row, state: row.instanceId === null ? "not-attempted" : "planned", code: undefined })), updatedAt: new Date().toISOString() };
  let snapshot: StackJournalSnapshot = writeStackJournal(root, previous, journal);
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
  for (const role of STOP_ORDER) {
    const member = members.find((row) => row.role === role);
    if (!member) continue;
    const holds = serviceDefinitionStore(journal.space).pin(member.definition);
    try {
      let kernel: ServiceAdapterKernelStopPlan | undefined;
      if (role === "broker") {
        // Recheck the whole scope now that earlier members are confirmed stopped.
        scopeRefusals(journal);
        if (member.live) kernel = await prepareKernelServiceStop(member.definition, member.instance);
        if (kernel && presentation !== "json") console.log(renderReport(kernelImpactView(kernel), presentation, terminalWidth(process.stdout)));
      }
      const current = serviceInstanceStore(journal.space).read(member.instance.name);
      if (!current) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a recorded member's instance record disappeared during the stop; no absence was inferred");
      const stopped = await stopProcessService(member.definition, current, holds, { plan: role === "manager" ? member.native : undefined, withAgents: role === "manager" && withAgents }, { plan: kernel });
      mark(role, { state: stopped.noOp ? "already-stopped" : "stopped" });
      if (!stopped.noOp) changed.push(instanceProjection(stopped.instance));
    } catch (error) {
      const classified = isCommandFailure(error) ? error : undefined;
      const uncertain = classified === undefined || classified.outcome === "unknown";
      mark(role, { state: uncertain ? "unknown" : classified!.outcome === "refused" ? "refused" : "failed", code: classified?.code ?? "OPERATION_UNKNOWN" });
      for (const later of STOP_ORDER.slice(STOP_ORDER.indexOf(role) + 1)) if (journal.members.find((row) => row.role === later)?.state === "planned") mark(later, { state: "not-attempted" });
      failure = new CommandFailure(uncertain ? "unknown" : changed.length ? "partial" : classified!.outcome, uncertain ? "OPERATION_UNKNOWN" : changed.length ? "OPERATION_PARTIAL" : classified!.code, `the ${role} did not confirm its stop; later members were not attempted and completed stops were not rolled back`, { target: { ...target, operation: journal.operation.id, members: journal.members }, changed, ...(classified ? { native: { code: classified.code, outcome: classified.outcome, detail: classified.message } } : {}), remedy: `inspect the recorded members with cotal service --space ${journal.space} before another action; no failed or unknown stop was retried` });
      break;
    } finally {
      try { holds.release(); } catch { /* The reservation release is not confirmed; outcomes above stand. */ }
    }
  }
  if (!failure) {
    // Shared cleanup only after the whole recorded set is confirmed stopped. An open stack never
    // had a delivery credential, so none is removed or claimed removed.
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
  writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop", ...target, operation: journal.operation, withAgents, members: journal.members, changed, managerImpact: manager?.native ?? null, atomic: false, cleanup: failure ? "not-confirmed" : journal.mode === "open" ? "registration-removed-no-delivery-credential" : "delivery-credential-and-registration-removed", admittedRestore: admittedRestore ?? null }, ...(failure ? { failure, completeness: "partial" as const } : changed.length ? {} : { noOp: true }) }, (result) => ({ sections: [...restoreNotice(admittedRestore), { title: failure ? "Controller stack stop incomplete" : changed.length ? "Controller stack stopped" : "Controller stack was not running; nothing was stopped", blocks: [
    { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Result" }], rows: result.members.filter((row) => row.instanceId !== null).map((row) => ({ role: row.role, instance: row.instanceId ?? "none", state: { text: row.state.replaceAll("-", " "), tone: ["stopped", "already-stopped"].includes(row.state) ? "ok" as const : ["refused", "failed"].includes(row.state) ? "failed" as const : "waiting" as const } })) },
    { kind: "lines", lines: ["A returned native manager stop and an observed broker exit are not proof of authority, lease, store or descendant cleanup. The stack journal and the saved definitions remain; the next bare cotal up reuses them."] },
  ] }] }));
}
