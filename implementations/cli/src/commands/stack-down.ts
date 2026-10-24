/** Controller-owned whole-stack shutdown over the exact members the stack journal records. The
 *  complete set, the manager's native agent impact and the broker binding are shown before any
 *  confirmation. Stops run manager, then delivery, then a user stack's auth service, then the
 *  broker, whose kernel-exit scope is
 *  recomputed only after every earlier member is confirmed gone. A member that is already gone is
 *  recorded as such under its definition's lock and is not stopped again, so a repeated stop is a
 *  no-op. Shared registry and credential cleanup follow only a complete confirmed stop. Nothing
 *  outside the recorded members is touched. The whole apply holds the root's maintenance lock. */
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import * as prompts from "../lib/prompts.js";
import { DEFAULT_SPACE, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, ConfirmationRequired, canonicalRoot, deliveryCredsKey, findMesh, homeCotalDir, isCommandFailure, isConnectRefusal, oneLine, presentationOf, processStopped, readBrokerPolicy, readNatsInfoGreeting, recordMesh, recordOperationSpace, recordPreparedSpace, releaseMaintenanceLock, removeMesh, removeMeshesByRoot, renderReport, stackHomeRemedy, stackRunsUnderOtherHome, terminalWidth, workspaceSecretStore, writeResult,
  type MaintenanceLock, type MeshEntry, type OutputWarning, type Presentation, type Report, type ServiceAdapterKernelStopPlan, type ServiceAdapterStopAbandonment, type ServiceAdapterStopPlan,
} from "@cotal-ai/workspace";
import { brokerLaunchAt } from "../lib/broker-service.js";
import { yesRequired } from "../lib/confirmation-required.js";
import { noticeOnInterrupt } from "../lib/interrupt-notice.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { canPrompt } from "./meshes-wizard.js";
import { nativeImpactView } from "./service-actions.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances, serviceInstanceStore, serviceRecordsWriteProblem, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { abandonableSignalStop, assertNoServiceUnitAttempts, prepareKernelServiceStop, prepareNativeServiceStop, resumableSignalStop, retainedStopRequest, settleExitedInstance, stopProcessService } from "../lib/service-process.js";
import { abandonLaunchRemedy, abandonRemedy, abandonRetainedStackStop, abandonUnresolvedStackLaunch, acquireStackOperationLock, newStackOperation, previewStackSettlement, processGone, readStackJournal, recordedProcessesUnder, recordedProcessLine, refuseControllerCut, RESUME_REMEDY, runningStackRoles, settleRetainedStackStops, settleStackOperation, stackJournalPath, stackMaintenanceFence, stackNeverStarted, stackOperationUnsettled, stackScopeRefusals, stackSettlementNotice, withSettledMembers, writeStackJournal, type StackJournal, type StackJournalSnapshot, type StackMember, type StackRole, type StackSettlement } from "../lib/stack-journal.js";
import { readStackRuns } from "../lib/stack-runs.js";

const STOP_ORDER: readonly StackRole[] = ["manager", "delivery", "auth", "broker"];

interface Member { role: StackRole; definition: ServiceDefinitionSnapshot; instance: ServiceInstanceSnapshot; live: boolean; native?: ServiceAdapterStopPlan }

/** The controller route applies whenever the root has a stack journal. */
export function controllerStackRecorded(root: string): boolean {
  return readStackJournal(canonicalRoot(root)) !== undefined;
}

/** The root of the controller stack this machine started for `space` in a folder other than `root`,
 *  or undefined. `cotal down` stops only the stack of the folder it runs in, so a refusal names it. */
export function stackRootElsewhere(space: string, root: string): string | undefined {
  try {
    const mesh = findMesh(space);
    return mesh && mesh.origin === "up" && canonicalRoot(mesh.root) !== canonicalRoot(root) && controllerStackRecorded(mesh.root) ? mesh.root : undefined;
  } catch {
    return undefined;
  }
}

/** The same `down`, without `--space`, for a refusal that names the folder to run it from. */
export const sameDown = (values: ParsedArgs["values"]): string =>
  ["cotal down", ...["dry-run", "with-agents", "preserve-state", "yes"].filter((flag) => values[flag] === true).map((flag) => `--${flag}`)].join(" ");

/** A stop records each member's stop under the space's service instance records, so a folder there this
 *  account cannot write refuses before the plan, naming it, rather than leaving every member running
 *  after an unknown first stop. */
function assertServiceRecordsWritable(root: string, space: string, values: ParsedArgs["values"]): void {
  const dir = serviceRecordsWriteProblem(space, ["instances"]);
  if (dir) throw new CommandFailure("refused", "PERMISSION_DENIED", `this account cannot write ${dir}, where down records each member's stop; no member was stopped`, {
    target: { root, space, path: dir },
    remedy: `make it writable with chmod u+w ${dir}, then run \`${sameDown({ ...values, "dry-run": undefined, yes: true })}\``,
  });
}

/** A stop records each step in the stack journal in the root's `.cotal`, so a folder this account
 *  cannot write refuses before the plan, naming it, rather than after the plan at the first write. */
function assertJournalWritable(root: string, values: ParsedArgs["values"]): void {
  const dir = dirname(stackJournalPath(root));
  try { accessSync(dir, constants.W_OK | constants.X_OK); }
  catch {
    throw new CommandFailure("refused", "PERMISSION_DENIED", `this account cannot write ${dir}, where down records each step of the stop in the stack journal; no member was stopped`, {
      target: { root, path: dir },
      remedy: `make it writable with chmod u+w ${shellWord(dir)}, then run \`${sameDown({ ...values, "dry-run": undefined, yes: true })}\``,
    });
  }
}

export function validateStackDownArguments(root: string, values: ParsedArgs["values"]): void {
  const preserve = values["preserve-state"] === true;
  const allowed = new Set(preserve ? ["space", "yes", "json", "plain", "preserve-state", "store-dir", "session-store"] : ["space", "yes", "dry-run", "json", "plain", "with-agents", "abandon-stop", "abandon-launch"]);
  const unsupported = Object.keys(values).filter((name) => !allowed.has(name) && values[name] !== undefined && !(Array.isArray(values[name]) && (values[name] as unknown[]).length === 0));
  if (unsupported.length) throw new CommandFailure("refused", "USAGE_INVALID", preserve ? "a controller stack's preserve accepts only --space, --store-dir, --session-store, --yes and presentation flags; it is exclusive with --with-agents and --dry-run" : "a controller stack's bare down accepts only --space, --with-agents, --abandon-stop, --abandon-launch, --yes, --dry-run and presentation flags; no other option was ignored", { target: { options: unsupported } });
  if (values["dry-run"] === true && values.yes === true) throw new CommandFailure("refused", "USAGE_INVALID", "--yes acknowledges a guarded apply, not a read-only stack preview");
  if (values["abandon-stop"] !== undefined) {
    if (values["dry-run"] === true) throw new CommandFailure("refused", "USAGE_INVALID", "--abandon-stop removes a retained stop request, so a read-only preview cannot take it");
    if (values["with-agents"] === true) throw new CommandFailure("refused", "USAGE_INVALID", "--abandon-stop cannot be combined with --with-agents: the abandoned stop's manager has exited, so no manager can stop the agents");
    if (values.yes !== true) throw new ConfirmationRequired("--abandon-stop needs --yes, because it gives up the only record of what that stop did", { remedy: `run cotal down --abandon-stop ${values["abandon-stop"]} --yes to give it up` });
  }
  if (values["abandon-launch"] !== undefined) {
    if (values["dry-run"] === true) throw new CommandFailure("refused", "USAGE_INVALID", "--abandon-launch records a member launch failed, so a read-only preview cannot take it");
    if (values.yes !== true) throw new CommandFailure("refused", "USAGE_INVALID", "--abandon-launch needs --yes, because a process that launch started without recording it is not excluded");
  }
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
    if (!processGone(state) && state !== "running") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a recorded stack member is foreign, unreadable or has an unresolved launch; no member was stopped", { target: instanceProjection(instance), remedy: state === "unresolved-launch" ? `${inspect}; ${abandonLaunchRemedy(row.instanceId)}` : inspect });
    const retained = retainedStopRequest(instance.record.value);
    if (instance.record.value.state === "stopping" || retained) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", retained?.publication === "unknown"
      ? "a recorded stack member's stop request file does not read as its own, so whether a stop was published is unknown; nothing was resubmitted and no member was stopped"
      : "a recorded stack member retains an unconfirmed stop request; it was not resubmitted and no member was stopped", { target: { ...instanceProjection(instance), ...(retained ? { requestId: retained.requestId, stopPublication: retained.publication } : {}) }, remedy: retained?.publication === "published" ? `${inspect}; ${abandonRemedy(retained.requestId)}` : abandonableSignalStop(instance.record.value) ? `${inspect}; ${abandonRemedy(instance.record.value.requestId)}` : resumableSignalStop(instance.record.value) ? `${inspect}; ${RESUME_REMEDY}` : inspect });
    assertNoServiceUnitAttempts(journal.space, row.definition);
    members.push({ role: row.role, definition, instance, live: state === "running" });
  }
  return members.sort((a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role));
}

/** A live manager's agent impact is read through the broker on an authenticated stack. When the
 *  stack's broker is gone that read cannot succeed, so the refusal names the command that brings
 *  the broker back while keeping the live manager. A broker whose process runs but sends no
 *  greeting, as a suspended one does, is named with its pid; the broker stops last, so it is not
 *  signalled here. */
async function managerImpact(journal: StackJournal, members: readonly Member[], manager: Member, withAgents: boolean): Promise<ServiceAdapterStopPlan | undefined> {
  try { return await prepareNativeServiceStop(manager.definition, manager.instance, withAgents); }
  catch (caught) {
    // The read connects through the broker, so a gone broker surfaces as the connect refusal.
    const error = isConnectRefusal(caught) ? caught.failure() : caught;
    const broker = members.find((member) => member.role === "broker" && member.live);
    const pid = broker?.instance.record.value.process?.pid;
    if (pid !== undefined && isCommandFailure(error) && !await readNatsInfoGreeting(journal.server, 2000)) {
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the stack's broker runs as pid ${pid} but does not answer at ${journal.server}, so the live manager's agent impact cannot be read; no member was stopped`, { target: { root: journal.root, space: journal.space, broker: broker!.instance.name, pid, manager: manager.instance.name }, native: { code: error.code, outcome: error.outcome, detail: error.message }, remedy: `if pid ${pid} is suspended, resume it with kill -CONT ${pid} and run cotal down again; if it stays unresponsive, end it with kill -KILL ${pid}, then run cotal up --space ${journal.space} to restart the broker while the manager keeps running, then run cotal down` });
    }
    if (broker || !isCommandFailure(error)) throw caught;
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
 *  running manager can stop the agents, unless the caller knows none can remain: the last down took
 *  --with-agents, or the root never started a stack. Its preview shows the no-op. The legacy route
 *  answers the same way. `warnings` report what this command changed before it found nothing running. */
export function nothingRunning(presentation: Presentation, target: { root: string; space?: string; server?: string }, withAgents: boolean, warnings: readonly OutputWarning[] = []): void {
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
  writeResult(presentation, { command: "down", target, result: { kind: "stack-not-running", ...target }, noOp: true, ...(warnings.length ? { warnings } : {}) }, () => ({ sections: [
    { title: `The stack in ${target.root} is not running`, blocks: [{ kind: "lines", lines: ["Nothing was stopped."] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal up", description: "Start it" }] }] },
  ] }));
}

/** The registration `cotal up` wrote for this stack is how its members' stops reach it. An older
 *  `meshes rm --force` dropped it, and an older `meshes add --force` replaced it with one added by
 *  hand. When it is missing, or a hand-added one names this same root and broker, the stop rebuilds
 *  it from the journal, but only while the stack's broker is the exact launch the journal records
 *  there. A hand-added registration of another address or folder is not replaced: removing it takes
 *  an act that names it. One another stack started, or a catalog lists, resolves as before. */
function strandedRegistration(journal: StackJournal, members: readonly Member[]): { entry: MeshEntry; previous: MeshEntry | undefined } | undefined {
  const registered = findMesh(journal.space);
  if (registered && registered.origin !== "manual" || !members.some((member) => member.live)) return undefined;
  const target = { root: journal.root, space: journal.space, server: journal.server };
  if (registered && (registered.server !== journal.server || canonicalRoot(registered.root) !== journal.root))
    throw new CommandFailure("refused", "CONFLICT", `"${journal.space}" is registered by hand at ${registered.server} for ${registered.root}, and this stack's broker is ${journal.server} in ${journal.root}; a registration added by hand is not replaced, so nothing was stopped`, { target, remedy: `if that registration names no other mesh you use, forget it with \`cotal space forget ${journal.space}\`, then run \`cotal down --yes\` here` });
  const what = registered ? "is registered by hand" : "has no registration";
  if (journal.mode === "user") throw new CommandFailure("refused", "UNSUPPORTED", `"${journal.space}" ${what}, and a user-auth stack's registration holds sign-in settings its journal does not, so it was not rebuilt; nothing was stopped`, { target, remedy: `inspect the recorded members with \`cotal service --space ${journal.space}\`` });
  const broker = members.find((member) => member.role === "broker");
  if (!broker?.live || !brokerLaunchAt(journal.space, broker.instance.name, broker.instance.record.value.launchRequestId, journal.root, journal.server))
    throw new CommandFailure("refused", "CONFLICT", `"${journal.space}" ${what}, and the stack's broker is not the launch its journal records at ${journal.server}, so its registration was not rebuilt; nothing was stopped`, { target, remedy: `inspect the recorded members with \`cotal service --space ${journal.space}\`` });
  const tlsRequired = readBrokerPolicy(journal.root)?.transport.kind === "tls-required";
  return { previous: registered, entry: {
    space: journal.space, server: journal.server, root: journal.root, mode: journal.mode, origin: "up", ts: new Date().toISOString(),
    ...(tlsRequired ? { tlsRequired: true } : {}),
    ...(journal.broker ? { storeDir: journal.broker.storeDir, ...(journal.broker.maxFileStore !== undefined ? { maxFileStore: journal.broker.maxFileStore } : {}), ...(journal.broker.host !== undefined ? { attachHost: journal.broker.host } : {}) } : {}),
  } };
}

/** What a stop that rebuilt the registration says it did, or for a preview, what it would do. */
function strandedNotice(journal: StackJournal, previous: MeshEntry | undefined, preview = false): OutputWarning {
  const used = preview ? "the stop would use" : "the stop used";
  return { code: "REGISTRATION_REBUILT", target: { root: journal.root, space: journal.space, server: journal.server }, message: previous
    ? `"${journal.space}" ${preview ? "is" : "was"} registered by hand at this stack's own root and broker; ${used} the registration \`cotal up\` writes for this stack, rebuilt from its journal, in its place`
    : `"${journal.space}" ${preview ? "has" : "had"} no registration; ${used} the one \`cotal up\` writes for this stack, rebuilt from its journal` };
}

/** What an abandoned member stop leaves unconfirmed. */
function abandonNotice(role: StackRole, abandonment: ServiceAdapterStopAbandonment): string {
  const receipts = abandonment.receipts.length ? `only ${abandonment.receipts.join(" and ")} receipts` : "no receipt";
  const abandoned = `stop request ${abandonment.requestId} of the ${role} was abandoned: its process exited with ${receipts}, and the down that sent it has exited.`;
  if (role !== "manager") return `${abandoned} Whether that stop caused the exit is not confirmed`;
  return `${abandoned} Whether the ${role} ${abandonment.withAgents ? "stopped and deprovisioned its agents" : "stopped or released its agents' seats"} is not confirmed; a seat that runs outside the ${role} process may still run`;
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
  // A busy root's refusal names the recorded space, as every refusal after the lock does.
  const recorded = readStackJournal(root)?.journal.space;
  if (recorded !== undefined) recordOperationSpace(recorded);
  const lock = acquireStackOperationLock(root);
  // A signal ends the stop where it is, and the notice names the members that still run.
  const release = noticeOnInterrupt(() => stackStopInterruptNotice(root));
  try { await applyStackStop(root, values, presentation, interactive, withAgents, lock); }
  finally { release(); releaseMaintenanceLock(lock); }
}

/** What an interrupted bare down left: the members still running, and the down that finishes it. */
function stackStopInterruptNotice(root: string): string {
  const space = readStackJournal(root)?.journal.space;
  const running = space === undefined ? [] : runningStackRoles(space);
  return running.length
    ? `Interrupted while stopping the stack in ${root}; ${running.join(", ")} ${running.length === 1 ? "is" : "are"} still running. Run cotal down --yes to finish the stop.`
    : `Interrupted while stopping the stack in ${root}; no member is running. Run cotal down --yes to finish its cleanup.`;
}

/** The recorded stack this stop targets, with every refusal that needs no lock or write. An earlier
 *  preserve or resume with no outcome is decided by its own maintenance attempt; an earlier up or
 *  down with none is classified read-only from its members, and refuses if any is unresolved. */
function stopTarget(root: string, values: ParsedArgs["values"]) {
  const previous = readStackJournal(root);
  if (!previous) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this root has no controller stack journal", { target: { root } });
  const journal0 = previous.journal;
  if (values.space !== undefined && values.space !== journal0.space) {
    const space = String(values.space), elsewhere = stackRootElsewhere(space, root);
    recordOperationSpace(space);
    throw new CommandFailure("refused", "CONFLICT", `--space ${space} ${elsewhere ? `names a controller stack rooted at ${elsewhere}` : "is not this folder's stack"}, and \`cotal down\` stops only the stack of the folder it runs in; this folder's stack is ${journal0.space}, so no member was stopped`, {
      target: { root, space, recordedSpace: journal0.space, ...(elsewhere ? { stackRoot: elsewhere } : {}) },
      remedy: elsewhere ? `run \`${sameDown(values)}\` from ${elsewhere}` : `run \`${sameDown(values)}\` from the folder whose stack is ${space}, or drop --space to stop ${journal0.space} here`,
    });
  }
  recordOperationSpace(journal0.space);
  if (stackRunsUnderOtherHome(root, journal0)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this root's controller stack runs under another Cotal home; this one holds no record of its members, so no member was stopped", { target: { root, space: journal0.space, cotalHome: homeCotalDir() }, remedy: stackHomeRemedy() });
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
  if (alreadyStopped(journal0, members) || stackNeverStarted(journal0)) return nothingRunning(presentation, target, false);
  // A preview reports what would refuse the real stop instead of refusing itself.
  let blocked: CommandFailure | undefined, restore: string | undefined, stranded: ReturnType<typeof strandedRegistration>;
  try { restore = scopeRefusals(journal0); stranded = strandedRegistration(journal0, members); assertJournalWritable(root, values); assertServiceRecordsWritable(root, journal0.space, values); }
  catch (error) { if (!isCommandFailure(error)) throw error; blocked = error; }
  const warnings = blocked ? [{ code: blocked.code, target: blocked.target, message: `the real stop would refuse: ${blocked.message}${blocked.remedy ? `; ${blocked.remedy}` : ""}` }] : stranded ? [strandedNotice(journal0, stranded.previous, true)] : [];
  // A preview that changes nothing succeeds. It is partial only in what it read: no provider and
  // no manager impact, which the real stop reads and confirms before any signal.
  writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop-preview", ...target, withAgents, members: members.map((member) => ({ role: member.role, definition: member.definition.name, instanceId: member.instance.name, process: member.live ? "running" : "gone" })), settlesOperation: settlement ?? null, blockedBy: blocked?.detail() ?? null, nativeImpactChecked: false, dryRun: true, signalled: false, admittedRestore: restore ?? null }, completeness: "partial", warnings }, () => {
    const view = planView(journal0, members, withAgents, settlement);
    return { ...view, sections: [...view.sections, ...restoreNotice(restore), { title: "Preview", blocks: [{ kind: "lines", lines: ["Nothing was stopped or written. The preview reads recorded members only; it loads no provider and queries no manager impact. The real stop reads and confirms that impact before any signal."] }] }] };
  });
}

async function applyStackStop(root: string, values: ParsedArgs["values"], presentation: ReturnType<typeof presentationOf>, interactive: boolean, withAgents: boolean, lock: MaintenanceLock): Promise<void> {
  // A member stop an earlier down could not confirm in time is settled from its own receipt first.
  const recorded = readStackJournal(root)?.journal;
  const ours = recorded && (values.space === undefined || values.space === recorded.space) ? recorded : undefined;
  if (ours) await settleRetainedStackStops(ours);
  // A stop no receipt can settle is abandoned only when the operator names its request.
  const abandoned = ours && typeof values["abandon-stop"] === "string" ? await abandonRetainedStackStop(ours, values["abandon-stop"]) : undefined;
  // So is a launch whose record names no process, when the operator names its instance.
  const launch = ours && typeof values["abandon-launch"] === "string" ? abandonUnresolvedStackLaunch(ours, values["abandon-launch"]) : undefined;
  const abandonWarnings: OutputWarning[] = [
    ...(abandoned ? [{ code: "STOP_ABANDONED", target: { ...instanceProjection(abandoned.row), role: abandoned.role, requestId: abandoned.abandonment.requestId, receipts: abandoned.abandonment.receipts }, message: abandonNotice(abandoned.role, abandoned.abandonment) }] : []),
    ...(launch ? [{ code: "LAUNCH_ABANDONED", target: { ...instanceProjection(launch.row), role: launch.role }, message: `the ${launch.role} launch ${launch.row.name} was recorded failed: the up that started it exited before it recorded a process. A process that launch started without recording it is not excluded, and this down does not stop it` }] : []),
  ];
  const { previous, journal0, settlement, members, target } = stopTarget(root, values);
  // The completed down that stopped the stack also stopped its agents when it took --with-agents, so
  // a repeat has nothing left to stop. A stack that never started has no agents either.
  if (alreadyStopped(journal0, members)) return nothingRunning(presentation, target, withAgents && !journal0.operation.withAgents, abandonWarnings);
  if (stackNeverStarted(journal0)) return nothingRunning(presentation, target, false, abandonWarnings);
  // A stopped broker takes connections and never answers, so every read through it would wait out
  // its budget and the broker's own stop would wait on a signal it cannot act on.
  const broker = members.find((member) => member.role === "broker" && member.live);
  const brokerPid = broker?.instance.record.value.process?.pid;
  if (brokerPid !== undefined && processStopped(brokerPid)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the stack's broker, pid ${brokerPid}, is stopped, so it accepts connections at ${journal0.server} and never answers; no member was stopped`, { target: { ...target, broker: broker!.instance.name, pid: brokerPid }, remedy: `resume it with kill -CONT ${brokerPid} and run cotal down again` });
  const admittedRestore = scopeRefusals(journal0);
  assertJournalWritable(root, values);
  assertServiceRecordsWritable(root, journal0.space, values);
  if (!values.yes && !interactive) throw new ConfirmationRequired(yesRequired("stopping the whole controller stack", presentation === "json"), { target, remedy: "run `cotal down --yes` to stop it; `cotal down --dry-run` shows what it stops" });
  // A missing or hand-added registration is rebuilt from the journal before anything resolves the
  // members, and put back as it was when the stop ends before any member stops.
  const stranded = strandedRegistration(journal0, members);
  if (stranded) recordMesh(stranded.entry);
  const putBack = () => {
    if (!stranded) return;
    if (stranded.previous) recordMesh(stranded.previous);
    else removeMesh(journal0.space);
  };
  // Complete native impact before confirmation. The broker's own kernel scope cannot be prepared
  // while its dependants run; it is recomputed after they stop and refuses on any change then.
  const manager = members.find((member) => member.role === "manager" && member.live);
  try {
    if (manager) {
      manager.native = await managerImpact(journal0, members, manager, withAgents);
      if (!manager.native) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the manager's native agent impact could not be established; no member was stopped", { target: instanceProjection(manager.instance) });
    } else if (withAgents) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--with-agents needs the stack's live manager and its native impact; no member was stopped", { target });
    if (!values.yes) {
      // What the prompt asks to confirm. The receipt names the mesh, so the plan does not.
      if (presentation !== "json") {
        console.log(renderReport({ sections: planView(journal0, members, withAgents, settlement).sections }, presentation, terminalWidth(process.stdout)));
        if (manager?.native) console.log(renderReport(nativeImpactView(manager.native), presentation, terminalWidth(process.stdout)));
      }
      const answer = await prompts.confirm({ message: `Stop every displayed member of ${oneLine(journal0.space)}'s controller stack with only the displayed native impact?`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) {
        putBack();
        writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop", ...target, cancelled: true, members: journal0.members }, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "no member was stopped" }] }, () => planView(journal0, members, withAgents, settlement));
        return;
      }
    }
  } catch (error) {
    putBack();
    throw error;
  }
  // A store reset lists the runs it removes from this record, read while the manager still answers:
  // the broker is the store's only reader and is stopped by then. A failed read never blocks the stop.
  const runs = manager ? await readStackRuns(journal0.space) : { observedAt: new Date().toISOString(), read: false as const, reason: "the stack's manager was not running" };
  // An earlier operation with no outcome is recorded as failed from its members' evidence first.
  const { snapshot: settledSnapshot, settled } = settleStackOperation(lock, previous);
  // A replacement an earlier `up` journaled is resolved from its own record, as the stop planned it.
  let journal: StackJournal = { ...settledSnapshot.journal, operation: { ...newStackOperation("down", withAgents), runs }, members: withSettledMembers(settledSnapshot.journal, undefined).members.map((row) => ({ ...row, state: row.instanceId === null ? "not-attempted" : "planned", code: undefined })), updatedAt: new Date().toISOString() };
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
  let deliveryCredentialKept = false;
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
  if (failure && !changed.length) putBack();
  if (!failure) {
    // Shared cleanup only after the whole recorded set is confirmed stopped. An open stack never
    // had a delivery credential, so none is removed or claimed removed. Each step is idempotent.
    // A delivery daemon that was already gone never released shard 0, and its credential is how
    // the next up recognises that row as this folder's dead daemon's and waits it out, so it stays
    // until that up replaces it.
    try {
      if (journal.mode !== "open") {
        const store = workspaceSecretStore(root), key = deliveryCredsKey(journal.space, { injected: false, root });
        if (journal.members.find((row) => row.role === "delivery")?.state === "already-stopped") deliveryCredentialKept = await store.get(key) !== undefined;
        else await store.delete(key);
      }
      // The stopped stack stays a prepared local space at its own root, so the next bare up
      // restarts the same recorded members instead of needing a new registration, and a selection
      // naming it stays.
      removeMeshesByRoot(root, journal.space);
      recordPreparedSpace({ space: journal.space, root, ts: new Date().toISOString() });
    } catch {
      failure = new CommandFailure("partial", "OPERATION_PARTIAL", journal.mode === "open" ? "every member stopped, but the mesh registration cleanup did not confirm" : "every member stopped, but the delivery credential or mesh registration cleanup did not confirm", { target, changed, remedy: journal.mode === "open" ? "inspect the root's registry entry; nothing was retried" : "inspect the root's delivery credential and registry entry; nothing was retried" });
    }
  }
  settle(failure ? (failure.outcome === "unknown" ? "unknown" : failure.outcome === "partial" ? "partial" : failure.outcome === "failed" ? "failed" : "refused") : "completed");
  writeResult(presentation, { command: "down", target, result: { kind: "controller-stack-stop", ...target, operation: journal.operation, withAgents, members: journal.members, changed, managerImpact: manager?.native ?? null, atomic: false, cleanup: failure ? "not-confirmed" : journal.mode === "open" ? "registration-removed-no-delivery-credential" : deliveryCredentialKept ? "registration-removed-delivery-credential-kept" : "delivery-credential-and-registration-removed", admittedRestore: admittedRestore ?? null, settledOperation: settled ?? null }, ...(settled || abandoned || stranded ? { warnings: [...abandonWarnings, ...(settled ? [{ code: "OPERATION_SETTLED", target: { ...target, operation: settled.operation.id }, message: stackSettlementNotice(settled) }] : []), ...(stranded ? [strandedNotice(journal0, stranded.previous)] : [])] } : {}), ...(failure ? { failure, completeness: "partial" as const } : changed.length ? {} : { noOp: true }) }, (result) => ({ sections: [...restoreNotice(admittedRestore), { title: failure ? "Controller stack stop incomplete" : changed.length ? "Controller stack stopped" : "Controller stack was not running; nothing was stopped", blocks: [
    { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Result" }], rows: result.members.filter((row) => row.instanceId !== null).sort((a, b) => STOP_ORDER.indexOf(a.role) - STOP_ORDER.indexOf(b.role)).map((row) => ({ role: row.role, instance: row.instanceId ?? "none", state: { text: row.state.replaceAll("-", " "), tone: ["stopped", "already-stopped"].includes(row.state) ? "ok" as const : ["refused", "failed"].includes(row.state) ? "failed" as const : "waiting" as const } })) },
  ] }, ...(failure ? [] : [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: "cotal up", description: "Start the stack again from its journal and saved definitions" }] }] }])] }));
}
