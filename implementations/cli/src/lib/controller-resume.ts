/** Controller-owned resume and restore (bare `up`, `up --restore` and `backup restore` on a
 *  controller cut). Every member starts or is adopted from the journal's own start rows,
 *  each journaled as `requested` before its call, and the broker and manager must also carry this
 *  attempt. When the cut's broker record is retired (an alternate restore's rewritten definition, or a
 *  rollback's rebound revision), the broker is a new instance whose IDs the journal names before its
 *  start. A resume binds the broker's listener proof to its started row; a
 *  restore binds it to the cut's broker instance at a new launch request, or to the journaled new
 *  instance. After manager commitment only the manager is
 *  relaunched, with the journal's commit token as a protected file, and only once its last recorded
 *  process is proven gone with its own stop receipt; any other member that is not live holds.
 *  Activation then runs the shared path in `up.ts`. Nothing is rolled back. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  CommandFailure, beginOrdinaryResume, bindOrdinaryResumeListener, bindRestoreListener, controllerAttemptBinding, controllerAttemptBroker, cutController,
  isCommandFailure, readMaintenanceJournal, recordControllerAttemptBroker, requestControllerMemberStart, settleControllerMemberStart, sweepTokenHandoff, writeTokenHandoff,
  type AttemptBrokerInstance, type CommitIntentRecord, type ControllerCutBinding, type ControllerListenerInstance, type ControllerMember, type ControllerRole,
  type ControllerStartedMember, type JsonValue, type MaintenanceJournal, type MaintenanceLock, type RestoreListenerProof, type ServiceAdapterAttempt,
} from "@cotal-ai/workspace";
import { serviceDefinitionStore } from "./service-definitions.js";
import { observeServiceProcess, serviceInstanceStore, type ServiceInstance } from "./service-instances.js";
import { startProcessService } from "./service-process.js";
import { readStackJournal, writeStackJournal, type StackJournal } from "./stack-journal.js";

function refuse(code: ConstructorParameters<typeof CommandFailure>[1], message: string, target: unknown, remedy?: string): never {
  throw new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}) });
}

function hold(message: string, target: unknown, remedy?: string): never {
  throw new CommandFailure("unknown", "OPERATION_UNKNOWN", message, { target, ...(remedy ? { remedy } : {}) });
}

const statusRemedy = (member: ControllerMember, space: string) => `cotal service status ${member.definition} --instance ${member.instanceId} --space ${space}`;

/** Stack and maintenance journal coupling, checked on every read under the maintenance lock. Before
 *  an attempt the stack journal records the cut's own operation. An attempt's operation is the one
 *  its maintenance journal names: a crash between the two writes leaves the completed preserve
 *  recorded, and only that is advanced to the attempt's operation. */
export function assertControllerCoupling(root: string, cut: ControllerCutBinding, server: string, sourcePath: string, attempt?: { stackOperationId: string; attemptId: string }): StackJournal {
  const snapshot = readStackJournal(root);
  if (!snapshot) return refuse("CONFLICT", "a controller-custody maintenance journal has no stack journal; nothing was resumed", { root });
  const journal = snapshot.journal;
  if (journal.server !== server || journal.broker?.storeDir !== sourcePath)
    refuse("CONFLICT", "the stack journal does not match the maintenance cut's broker address or store; nothing was resumed", { root });
  const expected = attempt?.stackOperationId ?? cut.stackOperationId;
  if (journal.operation.id === expected) return journal;
  if (attempt && journal.operation.id === cut.stackOperationId && journal.operation.kind === "preserve" && journal.operation.phase === "completed")
    return writeStackJournal(root, snapshot, { ...journal, operation: { id: attempt.stackOperationId, kind: "resume", phase: "applying", recordedAt: new Date().toISOString(), withAgents: false, maintenanceAttemptId: attempt.attemptId }, updatedAt: new Date().toISOString() }).journal;
  return refuse("CONFLICT", "the stack journal does not match the maintenance cut's operation; nothing was resumed", { root, recorded: journal.operation.id, expected });
}

/** Eligibility for the start of a resume or restore: every cut member is still the
 *  stopped record at its cut launch request, its process gone, its receipt equal to the journal row,
 *  and its saved definition at the expected revision. */
export function assertControllerResumeEligible(space: string, cut: ControllerCutBinding, stops: readonly { role: ControllerRole; receipt: { requestId: string } }[], expectedBrokerRevision: string): void {
  for (const member of cut.members) {
    const instance = serviceInstanceStore(space).read(member.instanceId);
    const value = instance?.record.value;
    const target = { space, role: member.role, instanceId: member.instanceId };
    if (!value || value.launchRequestId !== member.launchRequestId || value.state !== "stopped" || !["gone", "previous-boot"].includes(observeServiceProcess(value)))
      refuse("LIFECYCLE_BLOCKED", "a cut member is no longer the stopped record the cut recorded; nothing was resumed", target, `inspect ${statusRemedy(member, space)}`);
    const stop = stops.find((row) => row.role === member.role)!;
    const receipt = member.role === "manager" ? value!.nativeStop : member.role === "broker" ? value!.kernelStop : value!.processStop;
    if (!receipt || receipt.requestId !== stop.receipt.requestId)
      refuse("LIFECYCLE_BLOCKED", "a cut member's terminal receipt no longer matches the cut's recorded stop; nothing was resumed", target);
    const definition = serviceDefinitionStore(space).read(member.definition);
    const expected = member.role === "broker" ? expectedBrokerRevision : member.definitionRevision;
    if (!definition || definition.record.revision !== expected)
      refuse("CONFLICT", "a cut member's saved definition is not at the revision the cut expects; nothing was resumed", { ...target, expected });
  }
}

/** The controller binding a new resume or restore journals: a fresh stack operation, no starts. */
export function newControllerAttemptLaunch(): { custody: "controller"; controller: { stackOperationId: string; started: [] } } {
  return { custody: "controller", controller: { stackOperationId: randomUUID(), started: [] } };
}

/** Journal the controller resume intent. The attempt's launch carries only journal-derived values.
 *  The stack journal follows through {@link assertControllerCoupling}. */
export function beginControllerResume(lock: MaintenanceLock, attemptId: string, launch: { server: string; storeDir: string; maxFileStore?: number; runtime: string; detached: boolean; serverName: string; serverNonce: string; acceptedStaleCheckpoints?: JsonValue }): void {
  beginOrdinaryResume(lock, { attemptId, launch: { ...launch, ...newControllerAttemptLaunch() } as unknown as { [key: string]: JsonValue } });
}

export interface ControllerAttempt {
  record: MaintenanceJournal;
  cut: ControllerCutBinding;
  started: readonly ControllerStartedMember[];
  attemptId: string;
  stackOperationId: string;
  /** A restore, as opposed to an ordinary resume. */
  restore: boolean;
  /** The manager committed this attempt; only the manager may be relaunched from here. */
  committed: boolean;
  /** The cut's broker record is retired, so this attempt's broker is a new instance. */
  brokerRequired: boolean;
  /** That new instance, once journaled. */
  broker?: AttemptBrokerInstance;
}

/** The current journal's resume or restore binding, re-read under the lock. */
export function currentControllerAttempt(root: string): ControllerAttempt {
  const record = readMaintenanceJournal(root);
  const cut = record ? cutController(record.cut) : undefined;
  const binding = record ? controllerAttemptBinding(record) : undefined;
  const attemptId = !record ? undefined : "restore" in record ? record.restore.attemptId : "ordinaryResume" in record ? record.ordinaryResume.attemptId : undefined;
  if (!record || !cut || !binding || !attemptId) return hold("the controller resume or restore journal is missing its custody binding", { root });
  const broker = controllerAttemptBroker(record);
  return {
    record, cut, started: binding.started, attemptId, stackOperationId: binding.stackOperationId, restore: "restore" in record,
    committed: (record as { managerCommit?: unknown }).managerCommit !== undefined, brokerRequired: broker.required, ...(broker.instance ? { broker: broker.instance } : {}),
  };
}

/** The instance this attempt runs for a role: the journaled new broker when the cut's is retired. */
function attemptInstanceId(attempt: ControllerAttempt, member: ControllerMember): string {
  if (member.role !== "broker" || !attempt.brokerRequired) return member.instanceId;
  return attempt.broker?.instanceId ?? hold("the cut's broker record is retired and this attempt has not journaled its new broker instance", { role: "broker" });
}

/** The broker and the manager carry the attempt that launched them; auth and delivery take none. */
function launchedBy(member: ControllerMember, value: ServiceInstance, attemptId: string): boolean {
  return member.role !== "broker" && member.role !== "manager" || value.attempt?.attemptId === attemptId;
}

type StartDecision = { kind: "start" } | { kind: "adopt"; launchRequestId: string } | { kind: "done"; launchRequestId: string };

/** Read the newest started row for this role with the instance record. */
function decideMemberStart(space: string, member: ControllerMember, started: readonly ControllerStartedMember[], attemptId: string, broker?: AttemptBrokerInstance): StartDecision {
  if (broker) return decideAttemptBrokerStart(space, member, broker, started, attemptId);
  const value = serviceInstanceStore(space).read(member.instanceId)?.record.value;
  const target = { space, role: member.role, instanceId: member.instanceId };
  if (!value) return hold("a cut member's instance record disappeared during the attempt; nothing was started", target);
  const rows = started.filter((row) => row.role === member.role);
  const row = rows[rows.length - 1];
  const running = observeServiceProcess(value) === "running" && Boolean(value.process) && launchedBy(member, value, attemptId);
  if (!row) {
    if (value.launchRequestId === member.launchRequestId && value.state === "stopped") return { kind: "start" };
    // A member relaunched outside this attempt is never adopted or stopped.
    return refuse("LIFECYCLE_BLOCKED", "a stack member was relaunched outside this resume; inspect it with cotal service status before another resume", target, statusRemedy(member, space));
  }
  if (row.outcome === "running" && value.launchRequestId === row.launchRequestId && running) return { kind: "done", launchRequestId: row.launchRequestId! };
  if (value.launchRequestId === row.priorLaunchRequestId && value.state === "stopped") return { kind: "start" };
  if (row.outcome === "refused-before-spawn" && value.launchRequestId === row.launchRequestId && value.state === "failed" && !value.process) return { kind: "start" };
  // Only a row whose call never settled can be adopted, and only at a live launch it attributes.
  if (row.outcome === undefined && value.launchRequestId !== row.priorLaunchRequestId && value.state === "running" && running)
    return { kind: "adopt", launchRequestId: value.launchRequestId };
  return hold("a member's earlier start may have launched and its outcome is not proven; no second start was made", target, statusRemedy(member, space));
}

/** The start decision for a journaled new broker instance. Its IDs are never reallocated, so a
 *  start is repeated only when no record of it exists (the record is created before any spawn), and
 *  only an unsettled row at that exact pair may be adopted. Anything else holds. */
function decideAttemptBrokerStart(space: string, member: ControllerMember, broker: AttemptBrokerInstance, started: readonly ControllerStartedMember[], attemptId: string): StartDecision {
  const value = serviceInstanceStore(space).read(broker.instanceId)?.record.value;
  const target = { space, role: member.role, instanceId: broker.instanceId };
  const remedy = `cotal service status ${member.definition} --instance ${broker.instanceId} --space ${space}`;
  const rows = started.filter((row) => row.role === "broker");
  const row = rows[rows.length - 1];
  if (rows.some((entry) => entry.instanceId !== broker.instanceId)) return hold("this attempt's broker start rows name another instance than its journaled new broker; nothing was started", target, remedy);
  const running = Boolean(value?.process) && value!.launchRequestId === broker.launchRequestId && observeServiceProcess(value!) === "running" && value!.attempt?.attemptId === attemptId;
  if (!value) {
    if (!row || row.outcome === undefined) return { kind: "start" };
    return hold("the journaled new broker instance's record disappeared after its start settled; no second start was made", target, remedy);
  }
  if (!row) return refuse("LIFECYCLE_BLOCKED", "the journaled new broker instance has a record this attempt never requested; nothing was started", target, remedy);
  if (row.outcome === "running" && row.launchRequestId === broker.launchRequestId && running) return { kind: "done", launchRequestId: broker.launchRequestId };
  if (row.outcome === undefined && value.state === "running" && running) return { kind: "adopt", launchRequestId: broker.launchRequestId };
  return hold("the journaled new broker instance is not proven live at its journaled launch, and its IDs are never reallocated; no second start was made", target, remedy);
}

/** Start one member and settle its row with the launch request and outcome. The row is already
 *  journaled. A refusal is `refused-before-spawn` only when the record shows no process. A journaled
 *  new broker starts with its own IDs, which no other record holds. */
async function launchMember(lock: MaintenanceLock, space: string, member: ControllerMember, prior: string, attempt?: ServiceAdapterAttempt, broker?: AttemptBrokerInstance): Promise<string> {
  const definition = serviceDefinitionStore(space).read(member.definition)!;
  const instanceId = broker?.instanceId ?? member.instanceId;
  try {
    const result = await startProcessService(definition, { ...(broker ? { brokerInstance: { ...broker } } : { instance: member.instanceId }), ...(attempt ? { attempt } : {}) });
    settleControllerMemberStart(lock, member.role, result.instance.record.value.launchRequestId, "running");
    return result.instance.record.value.launchRequestId;
  } catch (error) {
    const after = serviceInstanceStore(space).read(instanceId)?.record.value;
    const refusedBeforeSpawn = isCommandFailure(error) && error.outcome === "refused" && after !== undefined && !after.process && after.state === "failed" && after.launchRequestId !== prior;
    if (after && after.launchRequestId !== prior) settleControllerMemberStart(lock, member.role, after.launchRequestId, refusedBeforeSpawn ? "refused-before-spawn" : "unknown");
    throw error;
  }
}

/** Start or adopt one member by its start decision, before manager commitment. Returns its
 *  live launch request. */
export async function startControllerMember(lock: MaintenanceLock, root: string, space: string, role: ControllerRole, attempt?: ServiceAdapterAttempt): Promise<string | undefined> {
  let current = currentControllerAttempt(root);
  const member = current.cut.members.find((row) => row.role === role);
  if (!member) return undefined;
  if (role === "broker" && current.brokerRequired && !current.broker) {
    recordControllerAttemptBroker(lock, { instanceId: randomUUID(), launchRequestId: randomUUID() });
    current = currentControllerAttempt(root);
  }
  const broker = role === "broker" ? current.broker : undefined;
  const decision = decideMemberStart(space, member, current.started, current.attemptId, broker);
  if (decision.kind === "done") return decision.launchRequestId;
  if (decision.kind === "adopt") {
    settleControllerMemberStart(lock, role, decision.launchRequestId, "running");
    return decision.launchRequestId;
  }
  // A new broker instance has no launch of its own yet; its row names the retired record's.
  const prior = broker ? member.launchRequestId : serviceInstanceStore(space).read(member.instanceId)!.record.value.launchRequestId;
  requestControllerMemberStart(lock, { role, instanceId: broker?.instanceId ?? member.instanceId, priorLaunchRequestId: prior });
  return launchMember(lock, space, member, prior, attempt, broker);
}

/** Resume every non-manager member in order; the manager follows the broker's listener proof. */
export async function startControllerMembers(lock: MaintenanceLock, root: string, space: string, serverName: string): Promise<void> {
  const { attemptId } = currentControllerAttempt(root);
  for (const role of ["broker", "auth", "delivery"] as const)
    await startControllerMember(lock, root, space, role, role === "broker" ? { kind: "maintenance-resume", attemptId, serverName } : undefined);
}

/** The manager's attempt before commitment. It carries no commit token. */
export function managerResumeAttempt(root: string): ServiceAdapterAttempt {
  return { kind: "maintenance-resume", attemptId: currentControllerAttempt(root).attemptId };
}

/** Bind the broker's controller listener proof. A resume names its started row; a
 *  restore names the cut's broker instance at its new launch request, whose row this attempt also
 *  journaled. The instance record must be running at that launch request with that process. */
export function bindControllerBroker(lock: MaintenanceLock, root: string, space: string, launch: { server: string; serverName: string; serverNonce: string }): void {
  const attempt = currentControllerAttempt(root);
  const { record, cut, started, attemptId, restore } = attempt;
  if ((record as { listenerProof?: RestoreListenerProof }).listenerProof) return;
  const instanceId = attemptInstanceId(attempt, cut.members.find((row) => row.role === "broker")!);
  const row = [...started].reverse().find((entry) => entry.role === "broker" && entry.outcome === "running");
  const value = serviceInstanceStore(space).read(instanceId)?.record.value;
  if (!row || row.instanceId !== instanceId || !value?.process || value.launchRequestId !== row.launchRequestId || value.attempt?.attemptId !== attemptId) return hold("the started broker is not the running instance its row records; no listener proof was bound", { root, space });
  const instance: ControllerListenerInstance = { instanceId, launchRequestId: row.launchRequestId!, process: { pid: value.process.pid, token: value.process.token } };
  const proof: RestoreListenerProof = {
    kind: "controller", attemptId, serverName: launch.serverName, serverNonce: launch.serverNonce,
    processOwner: { pid: value.process.pid, host: hostname(), startedAt: new Date().toISOString(), id: `controller-broker-${row.launchRequestId}` },
    serverEndpoint: launch.server, target: restore ? (record as CommitIntentRecord).restore.target : record.source, instance,
  };
  const controllerInstanceRunning = (named: ControllerListenerInstance) => {
    const current = serviceInstanceStore(space).read(named.instanceId)?.record.value;
    return Boolean(current && current.launchRequestId === named.launchRequestId && current.process?.pid === named.process.pid && current.process?.token === named.process.token && observeServiceProcess(current) === "running");
  };
  if (restore) bindRestoreListener(lock, proof, { controllerInstanceRunning });
  else bindOrdinaryResumeListener(lock, proof, { controllerInstanceRunning });
}

/** That exact recorded process is gone, and its own native stop receipt names it (a gone member
 *  without its receipt holds; disappearance proves nothing). */
function exitReceipted(value: ServiceInstance): boolean {
  return value.state === "stopped" && Boolean(value.process && value.nativeStop && value.nativeStop.process.pid === value.process.pid && value.nativeStop.process.token === value.process.token) &&
    ["gone", "previous-boot"].includes(observeServiceProcess(value));
}

/** After manager commitment: a live manager of this attempt is kept. One whose newest start row
 *  ran, at that launch request, whose exact process is proven gone with its own stop receipt, is
 *  relaunched once with the journal's commit token as a protected file, the row journaled before
 *  the start. Anything else holds. */
export async function relaunchCommittedManager(lock: MaintenanceLock, root: string, space: string): Promise<void> {
  const { cut, started, attemptId } = currentControllerAttempt(root);
  const member = cut.members.find((row) => row.role === "manager")!;
  const target = { space, role: member.role, instanceId: member.instanceId };
  const row = [...started].reverse().find((entry) => entry.role === "manager");
  const value = serviceInstanceStore(space).read(member.instanceId)?.record.value;
  if (!row || row.outcome !== "running" || !value) return hold("the committed attempt's manager has no settled running start; it was not relaunched", target, statusRemedy(member, space));
  if (value.launchRequestId !== row.launchRequestId)
    refuse("LIFECYCLE_BLOCKED", "a stack member was relaunched outside this resume; inspect it with cotal service status before another resume", target, statusRemedy(member, space));
  if (value.process && observeServiceProcess(value) === "running" && value.attempt?.attemptId === attemptId) return;
  if (!exitReceipted(value)) hold("the committed attempt's manager is not running, and its exit is not proven by its own native stop receipt; it was not relaunched", target, statusRemedy(member, space));
  const prior = value.launchRequestId;
  sweepTokenHandoff(lock);
  const resumeCommit = writeTokenHandoff(lock);
  requestControllerMemberStart(lock, { role: "manager", instanceId: member.instanceId, priorLaunchRequestId: prior }, {
    priorManagerGone: (recorded) => {
      const current = serviceInstanceStore(space).read(member.instanceId)?.record.value;
      return Boolean(current && recorded.launchRequestId === prior && current.launchRequestId === prior && exitReceipted(current));
    },
  });
  await launchMember(lock, space, member, prior, { kind: "maintenance-resume", attemptId, resumeCommit });
}

/** Every cut member, or every one but `except`, must be live at the launch this attempt recorded. */
export function assertControllerMembersLive(root: string, space: string, except?: ControllerRole): void {
  const attempt = currentControllerAttempt(root);
  const { cut, started, attemptId } = attempt;
  for (const member of cut.members) {
    if (member.role === except) continue;
    if (member.role === "broker" && attempt.brokerRequired && !attempt.broker)
      hold("the cut's broker record is retired and this attempt has not journaled its new broker instance", { root, space, role: member.role });
    if (decideMemberStart(space, member, started, attemptId, member.role === "broker" ? attempt.broker : undefined).kind !== "done")
      hold("a cut member is not live at the launch this attempt recorded, and this state does not relaunch it; the attempt holds", { root, space, role: member.role, instanceId: member.instanceId }, statusRemedy(member, space));
  }
}

/** The live broker instance and process of this attempt, read before activation: the stack journal
 *  names it once the attempt settles, and a restore receipt reports its process. */
export function controllerAttemptBrokerInstance(root: string, space: string): { instanceId: string; pid: number } {
  const attempt = currentControllerAttempt(root);
  const instanceId = attemptInstanceId(attempt, attempt.cut.members.find((row) => row.role === "broker")!);
  return { instanceId, pid: serviceInstanceStore(space).read(instanceId)?.record.value.process?.pid ?? 0 };
}

/** Settle the stack journal's resume or restore operation. A completed attempt that started a new
 *  broker instance records it as the stack's broker, so the next preserve cuts that instance, and a
 *  completed restore records its target as the stack's store. */
export function settleControllerResume(root: string, phase: StackJournal["operation"]["phase"], completed: { brokerInstanceId?: string; storeDir?: string } = {}): void {
  const snapshot = readStackJournal(root)!;
  const done = phase === "completed";
  const members = snapshot.journal.members.map((row) => {
    if (row.instanceId === null || !done) return row;
    return { ...row, ...(row.role === "broker" && completed.brokerInstanceId ? { instanceId: completed.brokerInstanceId } : {}), state: "started" as const };
  });
  const broker = done && completed.storeDir && snapshot.journal.broker ? { ...snapshot.journal.broker, storeDir: completed.storeDir } : snapshot.journal.broker;
  writeStackJournal(root, snapshot, { ...snapshot.journal, operation: { ...snapshot.journal.operation, phase }, members, ...(broker ? { broker } : {}), updatedAt: new Date().toISOString() });
}
