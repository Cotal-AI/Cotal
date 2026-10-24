/** Controller-owned preserve (`down --preserve-state` on a controller root).
 *
 *  Order: refuse anything outside the recorded members that the broker's stop would cut off, and
 *  prove the exact manager instance serves the preserved-exit contract (both reads), journal the
 *  prepare intent, fence delivery, prepare, cut intent, commit, then the preserved-exit stop through
 *  the attempt table, then auth and the broker's kernel exit, quiescence, checkpoints and completion
 *  with each member's own receipt. Every effect follows its durable intent; a crash resolves forward
 *  from evidence or holds. Nothing is retried after a possible effect. */
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson, contractDigest, contractStoreContext, dialerFor, fetchContractClosure, isReachable,
  issuedUserCaller, recompileContractClosure, resolveService, standaloneConnectOpts,
} from "@cotal-ai/core";
import {
  CommandFailure, MAINTENANCE_RESUME_DOCUMENT_VERSION, MANAGER_PIDFILE, acquireMaintenanceLock, appendPreservedStopAttempt,
  beginMaintenanceCut, canonicalLocalProcessPath, clearPreservationCommitIntent, clearPreservationPrepareIntent,
  completeMaintenanceCut, cutController, identityRecord, markPreservedStopPublished, readLocalRecordSource,
  readMaintenanceJournal, readMaintenanceResumeDocument, readPreservationPrepareIntent, readServedContract, readServiceIdentity,
  readServiceStopReceipts, readServiceStopRequest, recordPreservationManagerCommit, releaseMaintenanceLock,
  requestServiceObservation, resolveControlTarget, seatCheckpointDir, serviceMetadataDigest, stopReservationPath,
  writeMaintenanceResumeDocument, writePreservationCommitIntent, writePreservationPrepareIntent,
  type ControllerMember, type ControllerStop, type JsonValue, type MaintenanceCutCommittedRecord, type MaintenanceLock,
  type NativeServiceIdentity, type NativeServiceStopRequest, type PreservedExitCapability, type PreservedStopAttempt, type ServiceAdapterPreservedStop,
} from "@cotal-ai/workspace";
import { askManager } from "./control.js";
import { waitForEndpointUnreachable } from "./endpoint-cut.js";
import { serviceDefinitionStore } from "./service-definitions.js";
import { observeServiceProcess, serviceInstanceStore, type ServiceInstanceSnapshot } from "./service-instances.js";
import { prepareKernelServiceStop, prepareNativeServiceStop, startProcessService, stopProcessService } from "./service-process.js";
import { readStackJournal, stackScopeRefusals, writeStackJournal, STACK_DEFINITION, type StackJournal, type StackJournalSnapshot, type StackRole } from "./stack-journal.js";
import { assertControlPlaneQuiesced, assertSeatsCheckpointable, captureSeatCheckpoints, readPresenceWithoutConsumer, retainedPrincipalKeys } from "../commands/down.js";

const MANAGER_ENDPOINT = "manager";

interface Member { role: StackRole; instance: ServiceInstanceSnapshot }

function refuse(code: ConstructorParameters<typeof CommandFailure>[1], message: string, target: unknown, remedy?: string): never {
  throw new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}) });
}

function hold(message: string, target: unknown, remedy = "inspect the manager's native stop request and receipts; this release has no command that abandons a held cut"): never {
  throw new CommandFailure("unknown", "OPERATION_UNKNOWN", message, { target, remedy });
}

function stateDirectory(space: string): string {
  const dir = serviceInstanceStore(space).directory();
  if (!dir) refuse("CONFLICT", "the reserved service state directory is missing", { space });
  return dir!;
}

/** A complete revision-33 status payload with a preservation binding. A closed revision-32 status
 *  schema rejects only its `preservation` key. */
function statusProbe(instanceId: string): unknown {
  return {
    instanceId, execution: "runtime", runtime: "pty", custody: "legacy", runHosting: false, terminalSessions: true,
    agentCount: 0, uptimeMs: 0, connectors: [], classSpawn: true, staticReconciliation: { state: "idle", failures: [] },
    stopImpact: { agentScope: "manager", observedAt: new Date(0).toISOString(), maintenance: "preserved", resumeRequired: false, stopping: false, lifecycleInFlight: 0, reservedLaunches: 0, retirementsPending: 0, deprovisioningInFlight: 0, staticReconciliationInFlight: 0, agents: [], preservation: { attemptId: "probe", inventorySha256: "0".repeat(64) } },
  };
}

/** The original members a controller cut stops: recorded, running, process-pinned instances. */
function cutMembers(journal: StackJournal): Member[] {
  const members: Member[] = [];
  for (const row of journal.members) {
    if (row.instanceId === null) continue;
    const instance = serviceInstanceStore(journal.space).read(row.instanceId);
    if (!instance || instance.record.value.definition !== row.definition || !instance.record.value.process || instance.record.value.state !== "running" || observeServiceProcess(instance.record.value) !== "running")
      refuse("LIFECYCLE_BLOCKED", "a recorded stack member is not a running, process-pinned instance; a controller preserve needs every recorded member live", { space: journal.space, role: row.role, instanceId: row.instanceId });
    members.push({ role: row.role, instance: instance! });
  }
  if (!members.some((row) => row.role === "manager") || !members.some((row) => row.role === "broker"))
    refuse("LIFECYCLE_BLOCKED", "a controller preserve needs the stack's running manager and broker", { space: journal.space });
  return members;
}

function memberBinding(space: string, member: Member): ControllerMember {
  const value = member.instance.record.value;
  const definition = serviceDefinitionStore(space).read(value.definition);
  if (!definition || definition.record.revision !== value.definitionRevision)
    refuse("CONFLICT", "a stack member runs at another revision than its saved definition", { space, role: member.role, instanceId: member.instance.name });
  return { role: member.role, definition: value.definition, definitionRevision: value.definitionRevision, instanceId: value.instanceId, launchRequestId: value.launchRequestId, process: { pid: value.process!.pid, token: value.process!.token } };
}

/** A read only: the exact manager instance's own
 *  served-contract file, verified against the contract store, must compile a status contract that
 *  accepts a preservation binding. Outside an open space the instance's attributed describe must
 *  name the same status contract. The manager is still active, so its status is admitted. */
async function provePreservedExitCapability(journal: StackJournal, manager: Member): Promise<PreservedExitCapability> {
  const value = manager.instance.record.value;
  const context = { space: journal.space, instanceId: value.instanceId, launchRequestId: value.launchRequestId, stateDirectory: stateDirectory(journal.space) };
  const unsupported = (detail: string): never => refuse("UNSUPPORTED", `the selected manager instance does not serve the preserved-exit stop contract (${detail}); upgrade the manager by restarting it under this release before down --preserve-state`, { space: journal.space, instanceId: value.instanceId }, `cotal service restart ${STACK_DEFINITION.manager} --instance ${value.instanceId} --space ${journal.space}`);
  const binding = readServiceIdentity(context, value.process!);
  if (!binding || binding.native.endpoint !== MANAGER_ENDPOINT) return unsupported("no protected launch identity");
  const served = readServedContract(context, value.process!);
  if (!served || served.endpoint !== MANAGER_ENDPOINT) return unsupported("no served-contract binding");
  const statusRow = (served.document as { commands?: Array<{ name?: unknown; outputDigest?: unknown }> }).commands?.find((row) => row.name === "status");
  if (!statusRow || typeof statusRow.outputDigest !== "string") return unsupported("no status command in its served contract");
  const tls = journal.server.startsWith("tls:");
  const target = journal.mode === "open" ? undefined : await resolveControlTarget({ space: journal.space, server: journal.server }, "control-caller-privileged", value.instanceId, { endpoint: MANAGER_ENDPOINT, onRefusal: "throw" });
  const auth = target?.auth;
  if (target && (target.space !== journal.space || target.server !== journal.server || !auth?.epCaller)) refuse("CONFLICT", "the manager caller did not resolve to this stack's space and broker", { space: journal.space });
  const options = standaloneConnectOpts(auth?.creds ? { creds: auth.creds, tls } : auth?.bearer ? { bearer: auth.bearer, sentinelCreds: auth.sentinelCreds!, tls } : { tls });
  const nc = await dialerFor(journal.server)({ servers: journal.server, ...options, maxReconnectAttempts: 0 });
  try {
    const store = await contractStoreContext(nc, journal.space);
    const { manifest, artifacts } = await fetchContractClosure(store, served.clusterDigest, () => []);
    const rootBytes = artifacts.get(manifest.root.replace(/^sha256:/u, ""));
    if (!rootBytes || manifest.root !== contractDigest(served.document) || new TextDecoder().decode(rootBytes) !== canonicalJson(served.document))
      return unsupported("the contract store does not hold its served contract");
    const output = await recompileContractClosure(store, statusRow.outputDigest);
    let epoch: number;
    if (!auth) epoch = await openReceiptEpoch(context, value.process!, binding.native, unsupported);
    else {
      const caller = auth.bearer !== undefined && auth.managerInstanceId !== undefined ? await issuedUserCaller(nc, journal.space, String(options.name), auth.epCaller!) : auth.epCaller!;
      const service = await resolveService(nc, journal.space, MANAGER_ENDPOINT, caller, { instanceId: value.instanceId, deadlineMs: 5000 });
      if (service.responder.instanceId !== binding.native.instanceId || service.owner !== binding.native.principal.owner) return unsupported("its attributed instance differs");
      if (service.commands.get("status")?.contract.output.closureDigest !== statusRow.outputDigest)
        refuse("CONFLICT", "the instance's described status contract differs from its served-contract file; nothing was changed", { space: journal.space, instanceId: value.instanceId });
      epoch = service.responder.epoch;
    }
    if (!output.validate(statusProbe(binding.native.instanceId))) return unsupported("its status contract rejects a preservation binding");
    return { instanceId: binding.native.instanceId, epoch, owner: binding.native.principal.owner, uid: binding.native.principal.uid, clusterDigest: served.clusterDigest, statusOutputDigest: statusRow.outputDigest };
  } finally { await nc.close(); }
}

/** On an open space, the epoch is the pinned child's own local receipt
 *  epoch. The receipt's registration must equal the protected launch identity, as the open
 *  observation requires; no receipt or a different registration is unsupported. */
async function openReceiptEpoch(context: { space: string; instanceId: string; launchRequestId: string; stateDirectory: string }, target: { pid: number; token: string }, native: NativeServiceIdentity, unsupported: (detail: string) => never): Promise<number> {
  const answer = await requestServiceObservation(context, target, { timeoutMs: 3000, signal: AbortSignal.timeout(5000) });
  const payload = answer?.payload as { registration?: Record<string, unknown> } | undefined;
  const registration = payload?.registration;
  if (!payload || Object.keys(payload).sort().join() !== "registration,stopImpact" || !registration || typeof registration !== "object" || Object.keys(registration).sort().join() !== "endpoint,epoch,instanceId,principal")
    return unsupported("no local receipt from its pinned process");
  const { epoch, ...identity } = registration;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 0 || serviceMetadataDigest(identity) !== serviceMetadataDigest(native)) return unsupported("its local receipt names another registration");
  return Number(epoch);
}

function stopContext(space: string, manager: ControllerMember) {
  return { space, instanceId: manager.instanceId, launchRequestId: manager.launchRequestId, stateDirectory: stateDirectory(space) };
}

function rebuiltRequest(space: string, manager: ControllerMember, attempt: PreservedStopAttempt): NativeServiceStopRequest {
  return { schemaVersion: 1, space, instanceId: manager.instanceId, launchRequestId: manager.launchRequestId, requestId: attempt.requestId, target: { ...attempt.target }, stopper: { ...attempt.stopper }, withAgents: false, scopeSha256: attempt.scopeSha256, preserved: { ...attempt.preserved } };
}

type StopState = { kind: "new" } | { kind: "settled"; attempt: PreservedStopAttempt; observedAt: string };

/** What the journaled preserved-exit stop attempts allow next:
 *  - a `completed` receipt for a journaled attempt, with the exact process gone, settles forward;
 *  - a new attempt only when every attempt is phase-free and no request file or marker exists;
 *  - at least one refused-and-cleared attempt, the rest phase-free, refuses the preserve;
 *  - anything else, including any reader throw, holds. */
function preservedStopState(root: string, space: string, manager: ControllerMember, attempts: readonly PreservedStopAttempt[]): StopState {
  const context = stopContext(space, manager);
  const marker = readLocalRecordSource(stopReservationPath(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space })), 128, true) !== undefined;
  let request: NativeServiceStopRequest | undefined;
  try { request = readServiceStopRequest(context); }
  catch { return hold("the preserved-exit stop request file does not match this manager launch; the cut holds", { space, instanceId: manager.instanceId }); }
  const phases: Array<{ attempt: PreservedStopAttempt; rows: ReturnType<typeof readServiceStopReceipts> }> = [];
  for (const attempt of attempts) {
    try { phases.push({ attempt, rows: readServiceStopReceipts(context, rebuiltRequest(space, manager, attempt)) }); }
    catch { return hold("a preserved-exit stop receipt does not match its journaled attempt; the cut holds", { space, requestId: attempt.requestId }); }
  }
  const completed = phases.find((row) => row.rows.some((phase) => phase.phase === "completed"));
  if (completed) {
    const identity = identityRecord(manager.process.pid);
    if ("token" in identity && identity.token === manager.process.token) return hold("the preserved-exit stop returned but the manager process has not exited; the cut holds", { space, requestId: completed.attempt.requestId });
    return { kind: "settled", attempt: completed.attempt, observedAt: completed.rows.find((phase) => phase.phase === "completed")!.observedAt };
  }
  const refusedCleared = phases.filter((row) => row.rows.length === 1 && row.rows[0]!.phase === "refused");
  const phaseFree = phases.filter((row) => row.rows.length === 0);
  if (request || marker || phaseFree.length + refusedCleared.length !== phases.length)
    return hold("an earlier preserved-exit stop attempt is published, reserved or unsettled; no new request was made and nothing was retried", { space, instanceId: manager.instanceId });
  if (refusedCleared.length)
    refuse("LIFECYCLE_BLOCKED", "the native manager refused an earlier preserved-exit stop for this cut; no request is published under a refused scope", { space, requestId: refusedCleared[refusedCleared.length - 1]!.attempt.requestId }, "inspect the manager's preservation state; this release has no command that abandons or re-cuts the preserve");
  return { kind: "new" };
}

export interface ControllerPreserveResult { space: string; root: string; attemptId: string; storeDir: string; checkpoints: number; operation: StackJournal["operation"] }

function settleStack(root: string, phase: StackJournal["operation"]["phase"], members?: (journal: StackJournal) => StackJournal["members"]): StackJournalSnapshot {
  const snapshot = readStackJournal(root)!;
  return writeStackJournal(root, snapshot, { ...snapshot.journal, operation: { ...snapshot.journal.operation, phase }, ...(members ? { members: members(snapshot.journal) } : {}), updatedAt: new Date().toISOString() });
}

/** Stop the controller stack with its state preserved. A retry continues the same attempt. */
export async function preserveControllerStack(rootInput: string, storeOverride: string | undefined, sessionStores: readonly string[]): Promise<ControllerPreserveResult> {
  const snapshot0 = readStackJournal(rootInput);
  if (!snapshot0) return refuse("TARGET_NOT_FOUND", "this root has no controller stack journal", { root: rootInput });
  const journal0 = snapshot0.journal;
  const root = journal0.root, space = journal0.space;
  const storeDir = journal0.broker?.storeDir;
  if (!storeDir) return refuse("LIFECYCLE_BLOCKED", "this controller stack has no recorded broker store; a preserve needs its exact recorded store", { root, space });
  if (storeOverride !== undefined && storeOverride !== storeDir) refuse("CONFLICT", "--store-dir must equal the stack's recorded broker store", { root, space, recorded: storeDir });
  const lock = acquireMaintenanceLock(root);
  try {
    const existing = readMaintenanceJournal(root);
    const existingCut = existing ? cutController(existing.cut) : undefined;
    // A completed restore keeps its journal, and a new cut begins only after that journal is retired.
    if (existing?.state === "active")
      refuse("LIFECYCLE_BLOCKED", "a completed restore still holds this root's maintenance journal; a new preserve begins only after it is retired, so nothing was stopped", { root, space, attemptId: existing.restore.attemptId },
        existing.restore.previousSource ? `review it with cotal backup cleanup-fallback ${existing.restore.attemptId} --dry-run, then run it without --dry-run to remove only the retained old store and retire the journal` : undefined);
    if (existing && (!existingCut || existingCut.stackOperationId !== journal0.operation.id || !["cut-intent", "cut-committed", "ready"].includes(existing.state)))
      refuse("LIFECYCLE_BLOCKED", "this root retains another maintenance attempt; the controller preserve did not continue it", { root, space, state: existing.state });
    if (existing?.state === "ready") {
      await waitForEndpointUnreachable(journal0.server);
      return { space, root, attemptId: existing.cut.attemptId, storeDir: existing.source.path, checkpoints: 0, operation: journal0.operation };
    }
    // A retry checks the stack's scope again before any further stop.
    if (existing?.state === "cut-committed") {
      stackScopeRefusals(journal0, "cotal down --preserve-state");
      return await finishCommittedCut(lock, root, space, journal0, sessionStores);
    }
    if (existing?.state === "cut-intent")
      hold("a controller cut intent is retained without its recorded commit; it was not aborted or continued", { root, space, attemptId: existing.cut.attemptId }, "inspect the manager's preservation state and the maintenance journal before any action");
    if (["planned", "applying", "unknown"].includes(journal0.operation.phase))
      hold("an earlier whole-stack operation on this root has no settled outcome; it was not retried", { root, space, operation: journal0.operation }, "inspect each member with cotal service status");
    const members = cutMembers(journal0);
    // A read: what the broker's stop would cut off refuses before any effect.
    stackScopeRefusals(journal0, "cotal down --preserve-state");
    const manager = members.find((row) => row.role === "manager")!;
    // A read. A refusal here has written nothing and stopped nothing.
    const capability = await provePreservedExitCapability(journal0, manager);
    const prior = readPreservationPrepareIntent(root);
    if (prior && (prior.custody !== "controller" || prior.space !== space || prior.server !== journal0.server || prior.storeDir !== storeDir))
      refuse("CONFLICT", "a retained preservation prepare intent does not match this controller stack", { root, space, attemptId: prior.attemptId });
    const attemptId = prior?.attemptId ?? `preserve-${randomUUID()}`;
    writePreservationPrepareIntent(lock, { attemptId, space, mode: journal0.mode, server: journal0.server, storeDir, custody: "controller", capability });
    let stack = writeStackJournal(root, snapshot0, { ...journal0, operation: { id: randomUUID(), kind: "preserve", phase: "applying", recordedAt: new Date().toISOString(), withAgents: false, maintenanceAttemptId: attemptId }, updatedAt: new Date().toISOString() });
    const control = await resolveControlTarget({ space, server: journal0.server }, "control-caller-admin", capability.instanceId, { onRefusal: "throw" });
    const pin = { instanceId: capability.instanceId };
    // Plane-3 fence: the generic exact-PID stop of delivery, which records its own receipt.
    const delivery = members.find((row) => row.role === "delivery");
    if (delivery) {
      const definition = serviceDefinitionStore(space).read(delivery.instance.record.value.definition)!;
      const stopped = await stopProcessService(definition, delivery.instance);
      if (!stopped.instance.record.value.processStop) hold("the delivery fence recorded no exit receipt of its own; preservation did not continue", { root, space }, `inspect cotal service status ${STACK_DEFINITION.delivery} --instance ${delivery.instance.name} --space ${space}`);
    }
    let inventory: unknown;
    try {
      const prepared = await askManager(space, journal0.server, "preparePreservation", { attemptId }, control.auth, "any", 60_000, pin);
      if (!prepared.ok) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", prepared.error ?? "the manager refused preservation", { target: { root, space } });
      // Recheck (a): the responder is the proved incarnation.
      if (prepared.managerInstanceId !== capability.instanceId || prepared.managerEpoch !== capability.epoch)
        throw new CommandFailure("refused", "CONFLICT", "the manager that prepared is not the incarnation the capability proof bound", { target: { root, space } });
      const plan = prepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } | undefined;
      if (!plan?.inventory || (plan.failures?.length ?? 0) !== 0 || (plan.state !== "prepared" && plan.state !== "preserved"))
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the manager returned an incomplete preservation plan", { target: { root, space } });
      const retained = retainedPrincipalKeys(plan.inventory);
      const observed = await readPresenceWithoutConsumer(space, journal0.server);
      retained.add(observed.managerId);
      const unmanaged = observed.roster.filter((presence) => !retained.has(presence.card.id));
      if (unmanaged.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "unmanaged endpoints are live; preservation refused before its cut", { target: { root, space, endpoints: unmanaged.map((presence) => presence.card.id) } });
      assertSeatsCheckpointable(plan.inventory);
      inventory = plan.inventory;
    } catch (cause) {
      const aborted = await askManager(space, journal0.server, "abortPreservation", { attemptId }, control.auth, "any", 30_000, pin).then((reply) => reply.ok, () => false);
      clearPreservationPrepareIntent(lock);
      stack = settleStack(root, "refused");
      // Compensation: delivery restarts once, only after a confirmed abort and with no commit intent.
      if (delivery && aborted) {
        const definition = serviceDefinitionStore(space).read(delivery.instance.record.value.definition)!;
        await startProcessService(definition, { instance: delivery.instance.name });
      } else if (delivery) hold("preservation refused, but the manager abort was not confirmed; delivery stays stopped", { root, space }, `cotal service start ${STACK_DEFINITION.delivery} --instance ${delivery.instance.name} --space ${space} after inspection`);
      throw cause;
    }
    const resume = writeMaintenanceResumeDocument(lock, { version: MAINTENANCE_RESUME_DOCUMENT_VERSION, inventory: inventory as JsonValue, launch: { attemptId, space, server: journal0.server, storeDir, mode: journal0.mode, custody: "controller" } });
    // Recheck (b): the cut's manager binding is the proved one, not a fresh read.
    const broker = members.find((row) => row.role === "broker")!;
    const controller = { stackOperationId: stack.journal.operation.id, brokerDefinitionRevision: broker.instance.record.value.definitionRevision, members: members.map((row) => memberBinding(space, row)), manager: { instanceId: capability.instanceId, epoch: capability.epoch, lifecycleUid: capability.uid } };
    beginMaintenanceCut(lock, { attemptId, space, mode: journal0.mode, sourcePath: storeDir, resume, launch: { server: journal0.server, storeDir, custody: "controller", controller: controller as unknown as JsonValue } });
    clearPreservationPrepareIntent(lock);
    writePreservationCommitIntent(lock, { attemptId });
    const commit = await askManager(space, journal0.server, "commitPreservation", { attemptId }, control.auth, "any", 120_000, pin);
    const committed = commit.data as { state?: string; failures?: unknown[] } | undefined;
    if (!commit.ok || committed?.state !== "preserved" || (committed.failures?.length ?? 0) !== 0)
      hold("the manager preservation commit was not confirmed; the cut and commit intents are retained", { root, space, attemptId }, "inspect the manager's preservation state before any action");
    recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
    clearPreservationCommitIntent(lock);
    return await finishCommittedCut(lock, root, space, stack.journal, sessionStores);
  } finally {
    releaseMaintenanceLock(lock);
  }
}

/** From `cut-committed`: the preserved-exit stop by the attempt table, then the remaining members,
 *  quiescence, checkpoints and completion. A retry enters here and never prepares again. */
async function finishCommittedCut(lock: MaintenanceLock, root: string, space: string, stackJournal: StackJournal, sessionStores: readonly string[]): Promise<ControllerPreserveResult> {
  let record = readMaintenanceJournal(root) as MaintenanceCutCommittedRecord;
  const controller = cutController(record.cut)!;
  const manager = controller.members.find((row) => row.role === "manager")!;
  const document = readMaintenanceResumeDocument(root, record.resume);
  const preserved: ServiceAdapterPreservedStop = { attemptId: record.cut.attemptId, inventorySha256: createHash("sha256").update(JSON.stringify(document.inventory)).digest("hex") };
  let managerStop: ControllerStop;
  const state = preservedStopState(root, space, manager, record.preservedStop?.attempts ?? []);
  if (state.kind === "settled") {
    managerStop = { role: "manager", instanceId: manager.instanceId, launchRequestId: manager.launchRequestId, receipt: { kind: "preserved-exit", requestId: state.attempt.requestId, scopeSha256: state.attempt.scopeSha256, observedAt: state.observedAt } };
  } else {
    const instance = serviceInstanceStore(space).read(manager.instanceId);
    if (!instance || instance.record.value.launchRequestId !== manager.launchRequestId || instance.record.value.process?.pid !== manager.process.pid || instance.record.value.process?.token !== manager.process.token || observeServiceProcess(instance.record.value) !== "running")
      return hold("the cut's manager is not running at its recorded launch and process, and no completed preserved-exit receipt exists; the cut holds", { root, space, instanceId: manager.instanceId });
    const definition = serviceDefinitionStore(space).read(instance.record.value.definition)!;
    const plan = await prepareNativeServiceStop(definition, instance, false, preserved);
    // Recheck (c): the preview names the incarnation the cut recorded.
    if (!plan || plan.native.instanceId !== controller.manager.instanceId || plan.native.lifecycleUid !== controller.manager.lifecycleUid || plan.native.epoch !== controller.manager.epoch)
      return hold("the manager's preserved-exit preview names another incarnation than the cut recorded; the cut holds", { root, space });
    const self = identityRecord(process.pid);
    if (!("token" in self)) return refuse("UNSUPPORTED", "this process has no creation identity for a preserved-exit stop attempt", { root, space });
    const requestId = randomUUID();
    record = appendPreservedStopAttempt(lock, { requestId, target: { ...manager.process }, stopper: { pid: self.pid, token: self.token }, withAgents: false, scopeSha256: plan.scopeSha256, preserved });
    let stopped: Awaited<ReturnType<typeof stopProcessService>> | undefined;
    try { stopped = await stopProcessService(definition, serviceInstanceStore(space).read(manager.instanceId)!, undefined, { plan, withAgents: false, preserved, requestId }); }
    finally {
      // A request file for this attempt means it was published, whatever the call returned.
      let published = false;
      try { published = readServiceStopRequest(stopContext(space, manager))?.requestId === requestId; } catch { published = true; }
      if (published) record = markPreservedStopPublished(lock, requestId);
    }
    const native = stopped!.instance.record.value.nativeStop;
    if (!native || native.nativeStop !== "preserved-exit-returned" || native.requestId !== requestId) return hold("the preserved-exit stop did not return its terminal receipt; the cut holds", { root, space });
    managerStop = { role: "manager", instanceId: manager.instanceId, launchRequestId: manager.launchRequestId, receipt: { kind: "preserved-exit", requestId: native.requestId, scopeSha256: native.scopeSha256, observedAt: native.observedAt } };
  }
  if (await isReachable(stackJournal.server)) await assertControlPlaneQuiesced(space, stackJournal.server);
  const stops: ControllerStop[] = [managerStop];
  // Delivery was fenced before prepare; auth stops after quiescence; the broker stops last.
  for (const role of ["delivery", "auth", "broker"] as const) {
    const member = controller.members.find((row) => row.role === role);
    if (!member) continue;
    let instance = serviceInstanceStore(space).read(member.instanceId);
    if (!instance || instance.record.value.launchRequestId !== member.launchRequestId) return hold(`the cut's ${role} instance moved off its recorded launch; the cut holds`, { root, space, role });
    const definition = serviceDefinitionStore(space).read(instance.record.value.definition)!;
    if (observeServiceProcess(instance.record.value) === "running") {
      const kernel = role === "broker" ? await prepareKernelServiceStop(definition, instance) : undefined;
      instance = (await stopProcessService(definition, instance, undefined, undefined, { plan: kernel })).instance;
    }
    const value = instance.record.value;
    if (role === "broker") {
      if (!value.kernelStop) return hold("the broker has no kernel-exit receipt; the cut is not completed", { root, space });
      stops.push({ role, instanceId: member.instanceId, launchRequestId: member.launchRequestId, receipt: { kind: "kernel-exit", requestId: value.kernelStop.requestId, scopeSha256: value.kernelStop.scopeSha256, observedAt: value.kernelStop.observedAt } });
    } else {
      if (!value.processStop) return hold(`the ${role} member has no process-exit receipt of its own; the cut is not completed`, { root, space, role });
      stops.push({ role, instanceId: member.instanceId, launchRequestId: member.launchRequestId, receipt: { kind: "process-exit", requestId: value.processStop.requestId, observedAt: value.processStop.observedAt } });
    }
  }
  await waitForEndpointUnreachable(stackJournal.server);
  const captured = await captureSeatCheckpoints(root, space, record.resume, seatCheckpointDir(root, record.cut.attemptId), sessionStores);
  completeMaintenanceCut(lock, {
    attemptId: record.cut.attemptId, observedAt: new Date().toISOString(),
    managerCommit: { operation: "commitPreservation", attemptId: record.cut.attemptId, state: "preserved" },
    stopped: { manager: true, broker: true, localProcesses: true },
    listener: { endpoint: stackJournal.server, unreachable: true },
    controllerStops: stops,
  });
  const settled = settleStack(root, "completed", (journal) => journal.members.map((row) => row.instanceId === null ? row : { ...row, state: "stopped" as const }));
  return { space, root, attemptId: record.cut.attemptId, storeDir: record.source.path, checkpoints: captured.length, operation: settled.journal.operation };
}
