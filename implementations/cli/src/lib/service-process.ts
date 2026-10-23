import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CommandFailure, assertRecordIdentity, canonicalRoot, commandIsCotalSupervisor, isCommandFailure, maintenanceAdmitsStackWork, readMaintenanceJournal, readProcessCommand, readServiceStopRequest, resolveNativeServiceTarget, resolveOnPath, serviceAdapterReadiness, serviceMetadataDigest, spaceKey, serviceAdapterKernelStopPlan, serviceAdapterKernelStopResult, serviceAdapterStopPlan, serviceAdapterStopAbandonment, serviceAdapterStopRefusal, serviceAdapterStopResult, type ServiceAdapterStopAbandonment, type ServiceAdapterAttempt, type ServiceAdapterKernelStopPlan, type ServiceAdapterPreservedStop, type ServiceAdapterStopPlan, type ServiceAdapterContext, type ServiceDefinitionInput, type ControllerStackView, isWorkspaceTargetError, targetErrorCode, workspaceErrorParts, type MeshTargetError } from "@cotal-ai/workspace";
import { refuseRecordedSupervisor } from "./service-supervision.js";
import { serviceInstallIntents } from "./service-install-intent.js";
import { serviceUninstallIntents } from "./service-uninstall-intent.js";
import { serviceUnitActionStore } from "./service-unit-action.js";
import { selfArgv } from "./self-exec.js";
import { loadServiceAdapter, resolveServiceAdapter, sameServiceAdapterPin, type LoadedServiceAdapter, type ResolvedServiceAdapter } from "./service-adapters.js";
import { serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { instanceProjection, observeServiceProcess, processServiceHost, requireProcessIdentity, serviceInstances, serviceInstanceStore, type ServiceInstance, type ServiceInstanceSnapshot } from "./service-instances.js";
import { maintenanceStackView } from "./stack-journal.js";

export const PROCESS_SERVICE_CAPABILITIES = Object.freeze({ multiInstance: true, foreground: true, logs: true, install: false });
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const gone = (state: string) => state === "gone" || state === "previous-boot" || state === "foreign-pid";
/** A record with no creation pin whose own state says no child exists: its launch failed before
 *  a process did. There is nothing to stop. */
const neverLaunched = (value: ServiceInstance) => !value.process && gone(observeServiceProcess(value));

/** The recorded states a crash or a failed start leaves behind. A retained `stopping` request is not
 *  one of them: its own stop evidence decides it. */
const UNSETTLED_RUN: readonly ServiceInstance["state"][] = ["starting", "running", "unknown"];

/** Record an instance as `failed` when its exact recorded process is proven gone (its PID is dead,
 *  names a later process, or belongs to an earlier boot) and no stop of ours explains the exit. A
 *  native record that retains a stop request (see {@link retainedStopRequest}) is recorded `stopping`
 *  under that request instead, since only that stop's own receipt can settle it. The caller holds
 *  the definition's writer lock, so no launch or stop of it is in flight. Nothing is signalled,
 *  relaunched or removed. Any other record is returned unchanged. */
export function settleExitedInstance(row: ServiceInstanceSnapshot): ServiceInstanceSnapshot {
  const value = row.record.value;
  if (!value.process || !UNSETTLED_RUN.includes(value.state) || !gone(observeServiceProcess(value))) return row;
  const retained = retainedStopRequest(value);
  return transition(row, retained ? { state: "stopping", requestId: retained.requestId, readiness: "not-checked" } : { state: "failed", readiness: "not-checked" });
}

/** A record settled by {@link settleExitedInstance} or by its own failed start: its exact process
 *  is gone and no stop receipt explains the exit. */
export function exitedWithoutStop(value: ServiceInstance): boolean {
  return value.state === "failed" && value.process !== undefined && gone(observeServiceProcess(value));
}

/** Nothing of this record runs and no stop of ours is retained: it never launched, or its exact
 *  process is gone and its record is settled or a crash a stop may settle. */
function goneWithoutStop(value: ServiceInstance): boolean {
  if (neverLaunched(value)) return true;
  if (!gone(observeServiceProcess(value))) return false;
  return value.state === "failed" || value.process !== undefined && UNSETTLED_RUN.includes(value.state);
}

export type NativeStopEvidence = { requestId: string; publication: "published" | "unknown" };

/** The native stop request this exact instance launch holds, or undefined when the launch has no
 *  request file. It is `published` when the file reads as this launch's own. A file or state
 *  directory that cannot be read cannot rule a publication out, so it answers with the request this
 *  record names and an `unknown` publication, never a verified one. */
function publishedNativeStop(value: ServiceInstance): NativeStopEvidence | undefined {
  try {
    const stateDirectory = serviceInstanceStore(value.space).directory();
    if (!stateDirectory) return { requestId: value.requestId, publication: "unknown" };
    const request = readServiceStopRequest({ space: value.space, instanceId: value.instanceId, launchRequestId: value.launchRequestId, stateDirectory });
    return request && { requestId: request.requestId, publication: "published" };
  } catch { return { requestId: value.requestId, publication: "unknown" }; }
}

/** The native stop this record retains, or undefined. A native record with a process retains one
 *  while it is `stopping`, or in a state a crash leaves behind, and its launch holds a stop request:
 *  an earlier build recorded such a stop `unknown`. Only the adapter's own request-bound receipt
 *  settles it; no start, stop, crash settlement or exit record replaces it. */
export function retainedStopRequest(value: ServiceInstance): NativeStopEvidence | undefined {
  if (!value.nativeStopRequired || !value.process || value.state !== "stopping" && !UNSETTLED_RUN.includes(value.state)) return undefined;
  return publishedNativeStop(value);
}

/** Settle the native stop this record retains from its adapter's own evidence. The caller holds the
 *  definition's writer lock. When the adapter confirms that request's `completed` receipt and the
 *  exact process exit, it has released its reservation, and the record is recorded `stopped` with
 *  that result, as a stop confirmed within its call would be. When it reports the child's refusal,
 *  it has removed the request and released the reservation, and the record returns to what its
 *  process shows, as after a refusal within the call. Any other record, including one whose adapter
 *  confirms less, is returned unchanged. */
export async function settleRetainedNativeStop(definition: ServiceDefinitionSnapshot, row: ServiceInstanceSnapshot): Promise<ServiceInstanceSnapshot> {
  const value = row.record.value, launch = definition.record.value.launch, retained = retainedStopRequest(value);
  if (!retained || retained.publication !== "published" || launch.type !== "adapter" || !value.process) return row;
  const declared = resolveServiceAdapter(launch.adapter, launch.options);
  if (declared.declaration.stop !== "native" || !sameServiceAdapterPin(value.adapter, declared.pin) || value.definitionRevision !== definition.record.revision) return row;
  const provider = await loadServiceAdapter(declared, launch.options);
  const raw = provider.settleStop?.({ ...adapterContext(definition, value), process: { ...value.process }, requestId: retained.requestId });
  if (raw === undefined) return row;
  if ((raw as { nativeStop?: unknown }).nativeStop === "refused") {
    const refusal = serviceAdapterStopRefusal(raw);
    if (refusal.requestId !== retained.requestId || publishedNativeStop(value) !== undefined)
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the adapter's settled refusal did not retire the retained request; the record was kept", { target: instanceProjection(row) });
    return transition(row, { state: observeServiceProcess(value) === "running" ? "running" : "unknown", readiness: "not-checked" });
  }
  const result = serviceAdapterStopResult(raw);
  if (result.nativeStop !== "returned" || result.requestId !== retained.requestId || result.process.pid !== value.process.pid || result.process.token !== value.process.token || !gone(observeServiceProcess(value)))
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the adapter's settlement did not answer the retained request and its exact process exit; the record was kept", { target: instanceProjection(row) });
  return transition(row, { state: "stopped", requestId: retained.requestId, readiness: "not-checked", nativeStop: result });
}

/** Abandon the native stop `requestId` this record retains, on an operator's explicit request. The
 *  caller holds the definition's writer lock. The adapter refuses unless no receipt settles the
 *  request and its exact process and the stopper that published it have both exited; it then removes
 *  the request and releases its reservation. The record is recorded `failed`, as a process that exited
 *  without a confirmed stop, because what it stopped before it exited is not confirmed. */
export async function abandonRetainedNativeStop(definition: ServiceDefinitionSnapshot, row: ServiceInstanceSnapshot, requestId: string): Promise<{ row: ServiceInstanceSnapshot; abandonment: ServiceAdapterStopAbandonment }> {
  const value = row.record.value, launch = definition.record.value.launch, retained = retainedStopRequest(value);
  const target = { ...instanceProjection(row), requestId };
  if (!retained || retained.requestId !== requestId || !value.process) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this instance retains no stop request with that ID; nothing was abandoned", { target });
  if (retained.publication !== "published") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this launch's stop request file does not read as its own; nothing was abandoned", { target });
  if (launch.type !== "adapter") throw new CommandFailure("refused", "UNSUPPORTED", "only an adapter's native stop can be abandoned; nothing was abandoned", { target });
  const declared = resolveServiceAdapter(launch.adapter, launch.options);
  if (declared.declaration.stop !== "native" || !sameServiceAdapterPin(value.adapter, declared.pin) || value.definitionRevision !== definition.record.revision)
    throw new CommandFailure("refused", "CONFLICT", "the instance's adapter or definition changed since its launch; nothing was abandoned", { target });
  const provider = await loadServiceAdapter(declared, launch.options);
  if (!provider.abandonStop) throw new CommandFailure("refused", "UNSUPPORTED", "this service adapter cannot abandon a stop; nothing was abandoned", { target });
  const abandonment = serviceAdapterStopAbandonment(provider.abandonStop({ ...adapterContext(definition, value), process: { ...value.process }, requestId }));
  if (abandonment.requestId !== requestId || publishedNativeStop(value) !== undefined || !gone(observeServiceProcess(value)))
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the adapter's abandonment did not retire the request of an exited process; the record was kept", { target });
  return { row: transition(row, { state: "failed", readiness: "not-checked" }), abandonment };
}

/** The refusal for a retained native stop, made before any readiness probe, stop request or record
 *  write. This command has no effect, so it is refused; only the earlier stop's outcome is unknown. A
 *  request file that does not read as this launch's own is named an unknown publication. */
function retainedNativeStop(definition: ServiceDefinitionSnapshot, row: ServiceInstanceSnapshot, retained: NativeStopEvidence): CommandFailure {
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", retained.publication === "published"
    ? "an earlier native stop request is retained without its terminal receipt, so its outcome is unknown; nothing was submitted or written and its exit was not settled as a crash"
    : "this launch's native stop request file does not read as its own, so whether an earlier stop was published is unknown; nothing was submitted or written and its exit was not settled as a crash",
  { target: { ...instanceProjection(row), requestId: retained.requestId, stopPublication: retained.publication }, remedy: `inspect the original request with cotal service status ${definition.name} --instance ${row.name} --space ${row.record.value.space}` });
}

/** Settle every instance of one definition under its writer lock. */
export function settleExitedInstances(definition: ServiceDefinitionSnapshot): void {
  const space = definition.record.value.space;
  const hold = serviceDefinitionStore(space).pin(definition);
  try { for (const row of serviceInstances(space, definition.name)) settleExitedInstance(row); }
  finally { hold.release(); }
}

export function selectServiceInstance(rows: ServiceInstanceSnapshot[], id: string | undefined, allowMissing = false): ServiceInstanceSnapshot | undefined {
  if (id !== undefined) {
    const found = rows.find((row) => row.name === id);
    if (!found) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the full instance ID does not belong to this selected definition and space");
    return found;
  }
  if (!rows.length) { if (allowMissing) return undefined; throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no instance is recorded for this service definition"); }
  if (rows.length !== 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", `this definition has several instance records; choose --instance with one full ID:\n${rows.map((row) => row.name).join("\n")}`, { target: { candidates: rows.map((row) => row.name) } });
  return rows[0];
}

function sameIncarnation(before: ServiceInstance, after: ServiceInstance): boolean {
  return before.instanceId === after.instanceId && before.definitionRevision === after.definitionRevision && before.process?.pid === after.process?.pid && before.process?.token === after.process?.token;
}

function transition(row: ServiceInstanceSnapshot, change: Partial<ServiceInstance>): ServiceInstanceSnapshot {
  const store = serviceInstanceStore(row.record.value.space);
  const current = store.read(row.name);
  if (!current || !sameIncarnation(row.record.value, current.record.value)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the service incarnation changed while its operation was in flight; the successor was not overwritten", { target: { instanceId: row.name, requestId: row.record.value.requestId } });
  store.commit(row.name, current, { ...current.record.value, ...change, ...(change.readiness === "not-checked" ? { adapterReadiness: undefined } : {}), updatedAt: new Date().toISOString() });
  return store.read(row.name)!;
}

function executable(definition: ServiceDefinitionInput): string {
  if (definition.launch.type !== "process") throw new CommandFailure("refused", "UNSUPPORTED", "this driver accepts process definitions, not adapter options");
  const source = definition.launch.executable;
  const found = isAbsolute(source) ? source : /[\\/]/.test(source) ? resolve(definition.launch.cwd, source) : resolveOnPath(source);
  if (!found) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the declared executable is unavailable; no instance was allocated");
  return found;
}

function environment(definition: ServiceDefinitionInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "COTAL_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [destination, source] of Object.entries(definition.envRefs ?? {})) {
    if (process.env[source] === undefined) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "a selected host environment reference is unavailable; no environment value was printed and no process was launched");
    env[destination] = process.env[source];
  }
  if (definition.credentialRef) env.COTAL_CREDS = definition.credentialRef.path;
  return env;
}

export function serviceLogPath(space: string, id: string, create = false): string | undefined {
  const dir = serviceInstanceStore(space).directory(create);
  return dir ? join(dir, `${spaceKey(id)}.log`) : undefined;
}

/** Both absent, or the same attempt and inventory digest. */
function samePreserved(a: ServiceAdapterPreservedStop | undefined, b: ServiceAdapterPreservedStop | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.attemptId === b.attemptId && a.inventorySha256 === b.inventorySha256;
}

function ownedMetadata<T>(value: T): T {
  const freeze = (input: unknown): void => {
    if (input && typeof input === "object") { for (const child of Object.values(input)) freeze(child); Object.freeze(input); }
  };
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

function adapterContext(definition: ServiceDefinitionSnapshot, instance: ServiceInstance, cliInvocation?: readonly string[], attempt?: ServiceAdapterAttempt, stack?: ControllerStackView): ServiceAdapterContext {
  const value = definition.record.value;
  if (value.launch.type !== "adapter") throw new CommandFailure("refused", "UNSUPPORTED", "a process definition has no adapter context");
  const options = ownedMetadata(value.launch.options);
  const stateDirectory = serviceInstanceStore(value.space).directory();
  if (!stateDirectory) throw new CommandFailure("refused", "CONFLICT", "the reserved service state directory disappeared");
  return Object.freeze({ space: value.space, definition: definition.name, definitionRevision: definition.record.revision, instanceId: instance.instanceId, launchRequestId: instance.launchRequestId, stateDirectory, ...(cliInvocation ? { cliInvocation: Object.freeze([...cliInvocation]) } : {}), options, ...(value.credentialRef ? { credentialRef: Object.freeze({ ...value.credentialRef }) } : {}), ...(value.envRefs ? { envRefs: ownedMetadata(value.envRefs) } : {}), ...(attempt ? { attempt: ownedMetadata(attempt) } : {}), ...(stack ? { stack: ownedMetadata(stack) } : {}) });
}

/** A deadline bounds our observation, not the provider's work. No timed-out hook is retried. */
async function adapterCall<T>(call: (signal: AbortSignal) => Promise<T> | T, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CommandFailure("unknown", "OPERATION_UNKNOWN", "the adapter did not complete its bounded observation; it was not retried")); }, Math.max(1, timeoutMs)); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

export async function serviceReadiness(row: ServiceInstanceSnapshot, definition: ServiceDefinitionInput, adapter?: { provider: LoadedServiceAdapter; context: ServiceAdapterContext }): Promise<ServiceInstanceSnapshot> {
  const deadline = Date.now() + definition.readiness.timeoutMs;
  do {
    const state = observeServiceProcess(row.record.value);
    if (gone(state)) throw new CommandFailure("failed", "OPERATION_FAILED", "the owned service process exited before readiness was established", { target: { instanceId: row.name, requestId: row.record.value.requestId } });
    if (state !== "running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "service process ownership could not be re-established while observing readiness; no replacement was launched", { target: { instanceId: row.name, requestId: row.record.value.requestId } });
    if (definition.readiness.type === "process") return transition(row, { state: "running", readiness: "process-running" });
    if (definition.readiness.type === "adapter") {
      if (!adapter || !row.record.value.process || !sameServiceAdapterPin(row.record.value.adapter, adapter.provider.pin)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the service readiness has no matching pinned adapter; no provider was substituted", { target: instanceProjection(row) });
      const began = Date.now();
      let observation;
      try {
        observation = serviceAdapterReadiness(await adapterCall((signal) => adapter.provider.readiness({ ...adapter.context, process: { ...row.record.value.process! }, signal }), deadline - Date.now()));
        if (observation.state === "ready") {
          const process = row.record.value.process, observedAt = Date.parse(observation.observedAt);
          if (observation.process.pid !== process.pid || observation.process.token !== process.token || observedAt < began - 1000 || observedAt > Date.now() + 1000 || (adapter.provider.declaration.readiness === "endpoint") !== (observation.native !== undefined) || (adapter.provider.declaration.readiness === "listener") !== (observation.listener !== undefined)) throw new Error("unattributed adapter observation");
          if (observeServiceProcess(row.record.value) !== "running") throw new Error("process changed during adapter observation");
          return transition(row, { state: "running", readiness: observation.native ? "endpoint-serving" : observation.listener ? "broker-listener-reported" : "adapter-process-running", adapterReadiness: observation });
        }
      } catch {
        const uncertain = transition(row, { state: "unknown", readiness: "not-checked" });
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the adapter did not establish current readiness for the owned process before its deadline, or returned mismatched evidence; no hook or launch was retried", { target: instanceProjection(uncertain), remedy: "inspect the original full instance and its launch request before another start" });
      }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
      continue;
    }
    try {
      const response = await fetch(definition.readiness.url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
      await response.body?.cancel();
      if (response.status === definition.readiness.expectedStatus && observeServiceProcess(row.record.value) === "running") return transition(row, { state: "running", readiness: "http-reachable" });
    } catch { /* A failed bounded HTTP read is not proof of process death or listener ownership. */ }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  const uncertain = transition(row, { state: "unknown", readiness: "not-checked" });
  throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the owned process did not establish its declared readiness before the deadline; it was not relaunched or automatically killed", { target: instanceProjection(uncertain), remedy: "inspect service status/logs with the original full instance ID before another start" });
}

/** A target the adapter could not resolve, as the refusal its code and remedy name. */
function targetRefusal(error: MeshTargetError): CommandFailure {
  const { message, remedy } = workspaceErrorParts({ kind: "target", error });
  return new CommandFailure("refused", targetErrorCode(error.code), message, remedy ? { remedy } : {});
}

export function prepareProcessService(definition: ServiceDefinitionSnapshot) {
  processServiceHost();
  validateServiceDefinition(definition.record.value, definition.record.value.space);
  const launch = definition.record.value.launch;
  const program = launch.type === "process" ? executable(definition.record.value) : undefined;
  if (launch.type === "process" && commandIsCotalSupervisor([program, ...launch.args].join(" "))) throw new CommandFailure("refused", "UNSUPPORTED", "a native manager needs its service adapter and agent-impact guards, not generic process control; no instance was allocated");
  const adapter = launch.type === "adapter" ? resolveServiceAdapter(launch.adapter, launch.options) : undefined;
  let cliInvocation: string[] | undefined;
  if (adapter?.declaration.requiresCli) {
    try { cliInvocation = selfArgv(); }
    catch { throw new CommandFailure("refused", "UNSUPPORTED", "this native adapter requires the verified cotal binary entry; an arbitrary library entry was not re-executed"); }
  }
  return { program, adapter, cliInvocation, env: environment(definition.record.value), launcher: requireProcessIdentity(process.pid) };
}

/** A restart stops before it starts, and its start carries no maintenance attempt. Under a
 *  maintenance journal the broker and manager adapters admit such a start only through
 *  `maintenanceAdmitsStackWork`, so a restart either would refuse is refused here, before any stop
 *  is prepared or made. It only reads; a journal written after it can still refuse the start. */
export function assertRestartAdmitted(definition: ServiceDefinitionSnapshot): void {
  const value = definition.record.value;
  if (value.launch.type !== "adapter" || !["nats-broker", "manager-service"].includes(value.launch.adapter)) return;
  const options = value.launch.options, root = canonicalRoot(String(options.root));
  if (!readMaintenanceJournal(root)) return;
  const server = value.launch.adapter === "nats-broker" ? String(options.server) : resolveNativeServiceTarget(root, value.space, options.server as string | undefined).server;
  if (!maintenanceAdmitsStackWork(root, value.space, server, maintenanceStackView(root, value.space)))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt, under which the replacement start would be refused; nothing was stopped", { target: { space: value.space, definition: definition.name } });
}

type DefinitionHold = ReturnType<ReturnType<typeof serviceDefinitionStore>["pin"]>;
export async function startProcessService(definition: ServiceDefinitionSnapshot, options: { instance?: string; newInstance?: boolean; foreground?: boolean; attempt?: ServiceAdapterAttempt; brokerInstance?: { instanceId: string; launchRequestId: string }; replacement?: { instanceId: string; launchRequestId: string } }, held?: DefinitionHold) {
  const value = definition.record.value;
  if (options.attempt && (value.launch.type !== "adapter" || options.foreground)) throw new CommandFailure("refused", "UNSUPPORTED", "a maintenance attempt reaches only an adapter launch in the background; no launch was allocated");
  // Only the broker and manager adapters read an attempt; every other adapter refuses it.
  if (options.attempt && value.launch.type === "adapter" && !["nats-broker", "manager-service"].includes(value.launch.adapter)) throw new CommandFailure("refused", "UNSUPPORTED", "this adapter accepts no maintenance attempt; no launch was allocated");
  // A controller attempt whose cut broker is retired starts the new broker
  // instance its maintenance journal names, with the journal's own IDs. The broker adapter admits
  // only that exact pair, and only while every other record of the definition is retired.
  if (options.brokerInstance && (!options.attempt || value.launch.type !== "adapter" || value.launch.adapter !== "nats-broker" || options.newInstance || options.instance !== undefined)) throw new CommandFailure("refused", "UNSUPPORTED", "a journaled broker instance is started only by its own controller attempt; no launch was allocated");
  // A stack redefinition starts the replacement its stack journal named before the old instance was
  // retired, with the journal's own IDs, and only while the definition has no instance record.
  if (options.replacement && (options.brokerInstance || options.newInstance || options.instance !== undefined)) throw new CommandFailure("refused", "UNSUPPORTED", "a journaled stack replacement is started only under its own IDs; no launch was allocated");
  const { program, adapter: declaredAdapter, cliInvocation, env, launcher } = prepareProcessService(definition);
  if (declaredAdapter && (options.newInstance && !declaredAdapter.declaration.capabilities.multiInstance || options.foreground && !declaredAdapter.declaration.capabilities.foreground)) throw new CommandFailure("refused", "UNSUPPORTED", "the selected adapter does not declare this multi-instance or foreground capability; no launch was allocated");
  const hold = held ?? serviceDefinitionStore(value.space).pin(definition);
  let child: ChildProcess | undefined;
  try {
    assertNoServiceUnitAttempts(value.space, definition.name);
    const rows = serviceInstances(value.space, definition.name);
    if (options.brokerInstance) {
      if (rows.some((row) => row.name === options.brokerInstance!.instanceId)) throw new CommandFailure("refused", "CONFLICT", "the journaled broker instance already has a record; no second launch was allocated");
      if (rows.some((row) => row.record.value.state !== "stopped" || !row.record.value.kernelStop || !gone(observeServiceProcess(row.record.value)))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another record of this broker definition is not a stopped one with its own kernel-exit receipt; no new broker instance was allocated");
    }
    if (options.replacement && rows.length) throw new CommandFailure("refused", "CONFLICT", "the definition already has an instance record; the journaled replacement was not launched beside it", { target: { space: value.space, definition: definition.name, candidates: rows.map((row) => row.name) } });
    const chosen = options.newInstance || options.brokerInstance || options.replacement ? undefined : selectServiceInstance(rows, options.instance, true);
    // A retained native stop is decided only by its own receipt, so no start probes, reuses or
    // replaces it, and its record is not written.
    const retained = chosen && retainedStopRequest(chosen.record.value);
    if (chosen && retained) throw retainedNativeStop(definition, chosen, retained);
    // A crash or failed start is settled from its own evidence before the relaunch checks below.
    const selected = chosen && settleExitedInstance(chosen);
    if (selected && selected.record.value.definitionRevision !== definition.record.revision) throw new CommandFailure("refused", "CONFLICT", "this instance belongs to another definition revision; it was not adopted");
    if (selected && !sameServiceAdapterPin(selected.record.value.adapter, declaredAdapter?.pin)) throw new CommandFailure("refused", "CONFLICT", "the recorded instance pins a different adapter declaration or package version; stop and explicitly remove its retained records before choosing a different provider", { target: instanceProjection(selected) });
    if (selected) {
      refuseRecordedSupervisor(selected.record.value, "start");
      const state = observeServiceProcess(selected.record.value);
      if (state === "running") {
        if (options.foreground) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an existing live instance cannot be converted into this terminal's foreground process; stop it explicitly before a foreground start", { target: instanceProjection(selected) });
        const adapter = declaredAdapter && value.launch.type === "adapter" ? { provider: await loadServiceAdapter(declaredAdapter, value.launch.options), context: adapterContext(definition, selected.record.value, cliInvocation) } : undefined;
        return { instance: await serviceReadiness(selected, value, adapter), noOp: true, child: undefined, exit: undefined };
      }
      if (!gone(state)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an unresolved or foreign service incarnation is retained; no second launch was allocated", { target: instanceProjection(selected), remedy: "inspect the original full instance with service status/logs; do not discard an unresolved launch receipt" });
      // A settled exit (`failed` with its gone process) is relaunched; a retained `stopping`
      // request is still decided by its own stop evidence.
      const settledExit = exitedWithoutStop(selected.record.value);
      if (declaredAdapter?.declaration.stop === "native" && selected.record.value.process && !settledExit && !(selected.record.value.state === "stopped" && selected.record.value.nativeStop)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native service disappeared during its retained stop request, without its recorded terminal stop; no replacement was launched", { target: instanceProjection(selected), remedy: `inspect the original request with cotal service status ${definition.name} --instance ${selected.name} --space ${value.space}` });
      if (declaredAdapter?.declaration.stop === "kernel-exit" && selected.record.value.process && !settledExit && !(selected.record.value.state === "stopped" && selected.record.value.kernelStop)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original broker process disappeared during its retained stop request, without this controller's recorded exact-exit stop; no replacement listener was launched over its store", { target: instanceProjection(selected), remedy: `inspect the original request with cotal service status ${definition.name} --instance ${selected.name} --space ${value.space}` });
    }
    hold.check();
    const now = new Date().toISOString(), id = options.brokerInstance?.instanceId ?? options.replacement?.instanceId ?? selected?.name ?? randomUUID(), launchRequestId = options.brokerInstance?.launchRequestId ?? options.replacement?.launchRequestId ?? randomUUID();
    const instance: ServiceInstance = { schemaVersion: 1, instanceId: id, definition: definition.name, definitionRevision: definition.record.revision, space: value.space, host: processServiceHost(), requestId: launchRequestId, launchRequestId, state: "starting", launcher, readiness: "not-checked", supervisor: "none", ...(options.attempt ? { attempt: { attemptId: options.attempt.attemptId } } : {}), ...(declaredAdapter ? { adapter: declaredAdapter.pin, ...(declaredAdapter.declaration.stop === "native" ? { nativeStopRequired: true as const } : declaredAdapter.declaration.stop === "kernel-exit" ? { kernelStopRequired: true as const } : {}) } : {}), foreground: options.foreground === true, createdAt: selected?.record.value.createdAt ?? now, updatedAt: now };
    const store = serviceInstanceStore(value.space);
    store.commit(id, selected, instance);
    let row = store.read(id)!;
    let adapter: { provider: LoadedServiceAdapter; context: ServiceAdapterContext } | undefined;
    let launch: { program: string; args: readonly string[]; cwd: string };
    try {
      if (value.launch.type === "process") launch = { program: program!, args: value.launch.args, cwd: value.launch.cwd };
      else {
        // The manager adapter reads no stack journal, so its launch carries the facts it admits a settled restore against.
        const stack = value.launch.adapter === "manager-service" && typeof value.launch.options.root === "string" ? maintenanceStackView(value.launch.options.root, value.space) : undefined;
        const context = adapterContext(definition, instance, cliInvocation, options.attempt, stack);
        const provider = await loadServiceAdapter(declaredAdapter!, value.launch.options);
        hold.check();
        const plan = await adapterCall(() => provider.build(context), Math.min(10000, value.readiness.timeoutMs));
        const validated = validateServiceDefinition({ ...value, launch: { type: "process", ...plan }, readiness: { type: "process", timeoutMs: value.readiness.timeoutMs } }, value.space);
        if (validated.launch.type !== "process") throw new Error("invalid adapter launch plan");
        const executablePath = executable(validated);
        if (provider.declaration.stop !== "native" && commandIsCotalSupervisor([executablePath, ...validated.launch.args].join(" "))) throw new CommandFailure("refused", "UNSUPPORTED", "the direct-process adapter ABI cannot bypass native manager agent-impact guards");
        launch = { program: executablePath, args: validated.launch.args, cwd: validated.launch.cwd };
        adapter = { provider, context };
      }
      hold.check();
    } catch (error) {
      const failure = isCommandFailure(error) ? error : isWorkspaceTargetError(error) ? targetRefusal(error) : undefined;
      // No child is spawned above this point, so this incarnation has no process: the record is
      // failed either way. Only the provider's own work stays unattributed on an unknown error.
      row = transition(row, { state: "failed", readiness: "not-checked" });
      if (failure?.outcome === "refused") throw new CommandFailure("refused", failure.code, `service preparation was refused before a child launch: ${failure.message}`, { target: instanceProjection(row), native: { code: failure.code, outcome: failure.outcome, detail: failure.message }, remedy: failure.remedy });
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "service preparation did not establish an accepted direct-child launch plan; no child was launched, and no provider or launch was retried", { target: instanceProjection(row) });
    }
    const path = serviceLogPath(value.space, id, true)!;
    let log: number | undefined;
    let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
    let exited = false;
    let done!: () => void;
    const exit = new Promise<void>((resolve) => { done = resolve; });
    try {
      if (!options.foreground) {
        log = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const info = fstatSync(log);
        if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error("unprotected log target");
      }
      child = spawn(launch.program, [...launch.args], { cwd: launch.cwd, env, shell: false, detached: !options.foreground, stdio: options.foreground ? "inherit" : ["ignore", log!, log!] });
      if (!options.foreground) child.unref();
      child.once("exit", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; done(); });
      await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    } catch {
      row = transition(row, { state: "failed", readiness: "not-checked" });
      throw new CommandFailure("failed", "OPERATION_FAILED", "the native process launch failed before a service child was established; its instance receipt was retained", { target: instanceProjection(row) });
    } finally { if (log !== undefined) closeSync(log); }
    if (!child.pid) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the launch has no confirmed process ID; its instance intent was retained and no retry was made", { target: instanceProjection(row) });
    let identity;
    try { identity = requireProcessIdentity(child.pid); }
    catch {
      if (!exited) child.kill("SIGTERM");
      await Promise.race([exit, delay(3000)]);
      row = transition(row, { state: exited ? "failed" : "unknown", ...(exited ? { exit: { code: exitCode, signal: exitSignal } } : {}) });
      throw new CommandFailure(exited ? "failed" : "unknown", exited ? "OPERATION_FAILED" : "OPERATION_UNKNOWN", "the child could not be creation-pinned; its native child handle was asked to exit, and no replacement was launched", { target: instanceProjection(row) });
    }
    row = transition(row, { process: identity });
    let running: ServiceInstanceSnapshot;
    try { running = await serviceReadiness(row, value, adapter); }
    catch (error) {
      // Only an exit of the pinned child itself is settled here, with the exit this parent observed.
      if (!isCommandFailure(error) || error.code !== "OPERATION_FAILED") throw error;
      await Promise.race([exit, delay(1000)]);
      const failed = transition(row, { state: "failed", readiness: "not-checked", ...(exited ? { exit: { code: exitCode, signal: exitSignal } } : {}) });
      throw new CommandFailure("failed", "OPERATION_FAILED", `the owned service process exited before readiness was established${exited ? ` (exit code ${exitCode ?? "none"}, signal ${exitSignal ?? "none"})` : ""}; its log records the cause`, { target: instanceProjection(failed), remedy: `read its log with cotal service logs ${definition.name} --instance ${id} --space ${value.space}` });
    }
    return { instance: running, noOp: false, child, exit: { done: exit, observed: () => exited, result: () => ({ code: exitCode, signal: exitSignal }) } };
  } finally { if (!held) hold.release(); }
}

/** Native preview imports only the pinned provider and performs its caller-scoped read. No
 *  process signal, request publication or reservation is part of this pre-confirmation step. */
export async function prepareNativeServiceStop(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot, withAgents = false, preserved?: ServiceAdapterPreservedStop): Promise<ServiceAdapterStopPlan | undefined> {
  if (preserved && withAgents) throw new CommandFailure("refused", "USAGE_INVALID", "a preserved-exit stop retains agents; --with-agents cannot be combined with it");
  const value = definition.record.value;
  const declared = value.launch.type === "adapter" ? resolveServiceAdapter(value.launch.adapter, value.launch.options) : undefined;
  if (declared?.declaration.stop !== "native") {
    if (withAgents) throw new CommandFailure("refused", "UNSUPPORTED", "--with-agents requires a declared native stop policy; generic descendant signals were not substituted");
    if (preserved) throw new CommandFailure("refused", "UNSUPPORTED", "a preserved-exit stop requires a declared native stop policy");
    return undefined;
  }
  if (!sameServiceAdapterPin(selected.record.value.adapter, declared.pin) || selected.record.value.definitionRevision !== definition.record.revision) throw new CommandFailure("refused", "CONFLICT", "the selected native service pins another definition or adapter revision");
  if (selected.record.value.state === "stopped" && selected.record.value.nativeStop && gone(observeServiceProcess(selected.record.value))) return undefined;
  const retained = retainedStopRequest(selected.record.value);
  if (retained) throw retainedNativeStop(definition, selected, retained);
  // Nothing runs, so there is no impact to read; the stop records that exit under its lock.
  if (goneWithoutStop(selected.record.value)) return undefined;
  if (observeServiceProcess(selected.record.value) !== "running" || !selected.record.value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service has no live attributable process for an impact read; no completed stop was inferred from disappearance", { target: instanceProjection(selected) });
  const provider = await loadServiceAdapter(declared, value.launch.type === "adapter" ? value.launch.options : {});
  const began = Date.now();
  const plan = ownedMetadata(serviceAdapterStopPlan(await adapterCall((signal) => provider.prepareStop!({ ...adapterContext(definition, selected.record.value), process: { ...selected.record.value.process! }, withAgents, ...(preserved ? { preserved: { ...preserved } } : {}), signal }), 15000), selected.record.value.process));
  if (plan.withAgents !== withAgents || !samePreserved(plan.preserved, preserved) || Date.parse(plan.observedAt) < began - 1000 || Date.parse(plan.observedAt) > Date.now() + 1000) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native stop preview did not establish the requested current policy");
  return plan;
}

/** Kernel-exit preview imports only the pinned provider and reads its exact binding and dependant
 *  guards. No signal, reservation or record write is part of this pre-confirmation step. */
export async function prepareKernelServiceStop(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot): Promise<ServiceAdapterKernelStopPlan | undefined> {
  const value = definition.record.value;
  const declared = value.launch.type === "adapter" ? resolveServiceAdapter(value.launch.adapter, value.launch.options) : undefined;
  if (declared?.declaration.stop !== "kernel-exit") return undefined;
  if (!sameServiceAdapterPin(selected.record.value.adapter, declared.pin) || selected.record.value.definitionRevision !== definition.record.revision || selected.record.value.kernelStopRequired !== true) throw new CommandFailure("refused", "CONFLICT", "the selected broker pins another definition, adapter revision or stop policy");
  if (selected.record.value.state === "stopped" && selected.record.value.kernelStop && gone(observeServiceProcess(selected.record.value))) return undefined;
  if (goneWithoutStop(selected.record.value)) return undefined;
  if (selected.record.value.state === "stopping") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "an earlier broker stop request is retained without its exact-exit receipt; it was not resubmitted", { target: instanceProjection(selected) });
  if (observeServiceProcess(selected.record.value) !== "running" || !selected.record.value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker has no live attributable process for a stop scope; disappearance was not treated as a completed stop", { target: instanceProjection(selected) });
  const provider = await loadServiceAdapter(declared, value.launch.type === "adapter" ? value.launch.options : {});
  const began = Date.now();
  const plan = ownedMetadata(serviceAdapterKernelStopPlan(await adapterCall((signal) => provider.prepareKernelStop!({ ...adapterContext(definition, selected.record.value), process: { ...selected.record.value.process! }, signal }), 15000)));
  if (Date.parse(plan.observedAt) < began - 1000 || Date.parse(plan.observedAt) > Date.now() + 1000) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker stop scope was not observed now");
  return plan;
}

/** Whole-set eligibility read before any member is stopped. The actual stop retains its own
 *  per-effect checks: a cooperative definition reservation does not freeze a live process. */
export function preflightProcessServiceStop(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot): void {
  assertNoServiceUnitAttempts(selected.record.value.space, definition.name);
  const current = serviceInstanceStore(selected.record.value.space).read(selected.name);
  if (!current || current.record.revision !== selected.record.revision || current.hash !== selected.hash) throw new CommandFailure("refused", "CONFLICT", "a selected service instance changed during set preflight; no service was stopped");
  refuseRecordedSupervisor(current.record.value, "stop");
  const value = current.record.value, state = observeServiceProcess(value), launch = definition.record.value.launch;
  if (neverLaunched(value)) return;
  const declared = launch.type === "adapter" ? resolveServiceAdapter(launch.adapter, launch.options) : undefined;
  if (declared?.declaration.stop === "native") {
    if (!sameServiceAdapterPin(value.adapter, declared.pin) || value.definitionRevision !== definition.record.revision) throw new CommandFailure("refused", "CONFLICT", "a selected native incarnation pins another definition or adapter; no service was stopped");
    if (gone(state) && value.state === "stopped" && value.nativeStop) return;
    if (state !== "running" || !value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a selected native service has no attributable live process or retained returned stop; no new stop was submitted");
    return;
  }
  if (value.nativeStopRequired) throw new CommandFailure("refused", "UNSUPPORTED", "a selected instance requires its original native stop policy; a set stop cannot replace it with process signals");
  if (value.kernelStopRequired || declared?.declaration.stop === "kernel-exit") throw new CommandFailure("refused", "UNSUPPORTED", "a selected broker requires its exact kernel-exit stop and dependant scope; a named service set does not integrate that policy, so no service was stopped", { remedy: "stop the broker alone with cotal service stop <name> --instance <full-id> after its dependants are stopped" });
  if (gone(state)) return;
  if (state !== "running" || !value.process) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a selected service process is foreign, unreadable or unresolved; no service was stopped");
  const command = readProcessCommand(value.process.pid);
  if (command.kind !== "command" || commandIsCotalSupervisor(command.command)) throw new CommandFailure("refused", "UNSUPPORTED", "a selected process has an unreadable or manager-supervisor role; no generic set stop bypassed its native impact policy");
}

/** Only the stored creation-pinned process is signalled. Every escalation rechecks its identity. */
export async function stopProcessService(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot, held?: DefinitionHold, native?: { plan?: ServiceAdapterStopPlan; withAgents: boolean; preserved?: ServiceAdapterPreservedStop; requestId?: string }, kernel?: { plan?: ServiceAdapterKernelStopPlan }) {
  const hold = held ?? serviceDefinitionStore(definition.record.value.space).pin(definition);
  try {
    assertNoServiceUnitAttempts(selected.record.value.space, definition.name);
    const store = serviceInstanceStore(selected.record.value.space), current = store.read(selected.name);
    if (!current || current.record.revision !== selected.record.revision || current.hash !== selected.hash) throw new CommandFailure("refused", "CONFLICT", "the selected instance changed before stop; no process was signalled");
    let row = current;
    refuseRecordedSupervisor(row.record.value, "stop");
    const initial = observeServiceProcess(row.record.value);
    const launch = definition.record.value.launch;
    const declared = launch.type === "adapter" ? resolveServiceAdapter(launch.adapter, launch.options) : undefined;
    if (declared?.declaration.stop === "native") {
      if (!sameServiceAdapterPin(row.record.value.adapter, declared.pin) || row.record.value.definitionRevision !== definition.record.revision) throw new CommandFailure("refused", "CONFLICT", "the native service incarnation pins another definition or adapter; it was not controlled");
      if (gone(initial) && row.record.value.state === "stopped" && row.record.value.nativeStop) return { instance: row, noOp: true, nativeStop: row.record.value.nativeStop };
      const retained = retainedStopRequest(row.record.value);
      if (retained) throw retainedNativeStop(definition, row, retained);
      // Already gone without a stop of ours: record that exit under this lock; nothing is signalled.
      if (goneWithoutStop(row.record.value)) return { instance: settleExitedInstance(row), noOp: true };
      if (initial !== "running" || !row.record.value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native stop has no current attributable process or retained returned receipt; disappearance was not treated as completion", { target: instanceProjection(row) });
      if (!native?.plan) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "native service stop requires its current caller-scoped impact and explicit confirmation; generic signals were not used");
      const plan = serviceAdapterStopPlan(native.plan, row.record.value.process);
      if (plan.withAgents !== native.withAgents || !samePreserved(plan.preserved, native.preserved)) throw new CommandFailure("refused", "CONFLICT", "the confirmed native stop policy differs from the submitted policy");
      const provider = await loadServiceAdapter(declared, launch.type === "adapter" ? launch.options : {});
      hold.check();
      // A preserved-exit caller journals its attempt first and passes that attempt's request ID.
      if (native.preserved && !native.requestId) throw new CommandFailure("refused", "USAGE_INVALID", "a preserved-exit stop needs its journaled attempt's request ID; no request was published");
      const requestId = native.requestId ?? randomUUID(), target = { ...row.record.value.process }, began = Date.now();
      row = transition(row, { state: "stopping", requestId });
      let returned = false;
      try {
        const raw = await adapterCall((signal) => provider.stop!({ ...adapterContext(definition, row.record.value), process: target, withAgents: native.withAgents, ...(native.preserved ? { preserved: { ...native.preserved } } : {}), requestId, plan, signal }), 45000);
        returned = true;
        const result = serviceAdapterStopResult(raw);
        // The terminal kind must answer the submitted request: a preserved stop returns only
        // `preserved-exit-returned`, an ordinary stop only `returned`.
        if (result.nativeStop !== (native.preserved ? "preserved-exit-returned" : "returned") || result.requestId !== requestId || result.scopeSha256 !== plan.scopeSha256 || result.process.pid !== target.pid || result.process.token !== target.token || Date.parse(result.observedAt) < began - 1000 || Date.parse(result.observedAt) > Date.now() + 1000 || !gone(observeServiceProcess(row.record.value))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service did not confirm both its original returned stop and the exact process exit");
        return { instance: transition(row, { state: "stopped", readiness: "not-checked", nativeStop: result }), noOp: false, nativeStop: result };
      } catch (error) {
        const refused = !returned && isCommandFailure(error) && error.outcome === "refused";
        // A published or unreadable request keeps the record `stopping` under that request, even after
        // its process exits, so no crash settlement, record removal or relaunch can treat the exit as
        // unstopped. Only a stop that published nothing returns to its observed state.
        const published = publishedNativeStop(row.record.value);
        row = transition(row, published ? { state: "stopping", requestId: published.requestId, readiness: "not-checked" } : { state: refused && observeServiceProcess(row.record.value) === "running" ? "running" : "unknown", readiness: "not-checked" });
        if (isCommandFailure(error) && (!returned || error.outcome !== "refused")) throw error;
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service stop did not confirm its original terminal receipt; no signal escalation or restart was attempted", { target: instanceProjection(row) });
      }
    }
    if (declared?.declaration.stop === "kernel-exit") return await stopKernelService(definition, row, hold, declared, initial, native, kernel);
    if (row.record.value.nativeStopRequired) throw new CommandFailure("refused", "UNSUPPORTED", "the retained instance requires its original native stop policy; no generic signal path was substituted");
    if (row.record.value.kernelStopRequired) throw new CommandFailure("refused", "UNSUPPORTED", "the retained instance requires its exact kernel-exit stop policy from its pinned adapter; no generic signal path was substituted");
    if (native?.withAgents) throw new CommandFailure("refused", "UNSUPPORTED", "generic process stop does not accept an agent-reap policy");
    if (gone(initial)) return { instance: transition(row, { state: "stopped", readiness: "not-checked" }), noOp: true };
    if (initial !== "running" || !row.record.value.process) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected process is foreign, unreadable or unresolved; it was not signalled", { target: instanceProjection(row) });
    const command = readProcessCommand(row.record.value.process.pid);
    if (command.kind !== "command" || commandIsCotalSupervisor(command.command)) throw new CommandFailure("refused", "UNSUPPORTED", "generic process stop cannot bypass manager agent-impact guards or an unreadable process role; use its supported service adapter. No signal was sent", { target: instanceProjection(row) });
    row = transition(row, { state: "stopping", requestId: randomUUID() });
    // The receipt names the last signal this call itself delivered to the pinned process. A process
    // that was already gone before any delivery gets no receipt: absence is not a stop.
    let delivered: "SIGTERM" | "SIGKILL" | undefined;
    const signal = (name: "SIGTERM" | "SIGKILL") => {
      const state = observeServiceProcess(row.record.value);
      if (gone(state)) return;
      if (state !== "running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "service ownership became uncertain before signalling; its record was retained", { target: instanceProjection(row) });
      const role = readProcessCommand(row.record.value.process!.pid);
      if (role.kind !== "command" || commandIsCotalSupervisor(role.command)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the process role changed or became unreadable before signalling; manager impact guards were not bypassed", { target: instanceProjection(row) });
      const identity = assertRecordIdentity(row.record.value.process!);
      if (identity.kind !== "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the exact process incarnation changed before a signal; no successor was signalled", { target: instanceProjection(row) });
      try { process.kill(row.record.value.process!.pid, name); delivered = name; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the exact process signal was not confirmed; its record was retained", { target: instanceProjection(row) }); }
    };
    signal("SIGTERM");
    for (const [timeout, escalation] of [[15000, "SIGKILL"], [3000, undefined]] as const) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const state = observeServiceProcess(row.record.value);
        if (gone(state)) return { instance: transition(row, { state: "stopped", readiness: "not-checked", ...(delivered ? { processStop: { kind: "process-exit" as const, requestId: row.record.value.requestId, process: { ...row.record.value.process! }, signal: delivered, observedAt: new Date().toISOString() } } : {}) }), noOp: false };
        if (state !== "running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the service exit could not be established; its identity and stop receipt were retained", { target: instanceProjection(row) });
        await delay(100);
      }
      if (escalation) signal(escalation);
    }
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the selected service process did not confirm exit; its record was retained and no restart was attempted", { target: instanceProjection(row) });
  } finally { if (!held) hold.release(); }
}

/** The broker's exact kernel-exit stop. It signals only the creation-pinned child after the
 *  confirmed scope is recomputed unchanged, waits for that exact process to exit and records the
 *  observed exit. A retained `stopping` request, an exit this call did not cause, or an exit not
 *  observed before the deadline stays unknown: no SIGKILL, resubmission or restart follows. */
async function stopKernelService(definition: ServiceDefinitionSnapshot, current: ServiceInstanceSnapshot, hold: DefinitionHold, declared: ResolvedServiceAdapter, initial: ReturnType<typeof observeServiceProcess>, native: { withAgents: boolean } | undefined, kernel: { plan?: ServiceAdapterKernelStopPlan } | undefined) {
  let row = current;
  const value = row.record.value, launch = definition.record.value.launch;
  if (native?.withAgents) throw new CommandFailure("refused", "UNSUPPORTED", "a broker kernel-exit stop has no agent policy; --with-agents belongs to the exact manager instance");
  if (!sameServiceAdapterPin(value.adapter, declared.pin) || value.definitionRevision !== definition.record.revision || value.kernelStopRequired !== true) throw new CommandFailure("refused", "CONFLICT", "the broker incarnation pins another definition, adapter or stop policy; it was not controlled", { target: instanceProjection(row) });
  if (gone(initial) && value.state === "stopped" && value.kernelStop) return { instance: row, noOp: true, kernelStop: value.kernelStop };
  // Already gone without a stop of ours: record that exit under this lock. No exit is attributed
  // to a signal, and no kernel-exit receipt is written.
  if (goneWithoutStop(value)) return { instance: settleExitedInstance(row), noOp: true };
  if (value.state === "stopping") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "an earlier broker stop request is retained without its exact-exit receipt; it was not resubmitted", { target: instanceProjection(row) });
  if (initial !== "running" || !value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker has no current attributable process or retained exact-exit receipt; disappearance was not treated as a completed stop", { target: instanceProjection(row) });
  if (!kernel?.plan) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a broker stop requires its current exact scope and explicit confirmation; no signal was sent");
  const confirmed = serviceAdapterKernelStopPlan(kernel.plan);
  const provider = await loadServiceAdapter(declared, launch.type === "adapter" ? launch.options : {});
  hold.check();
  const target = { ...value.process };
  const fresh = serviceAdapterKernelStopPlan(await adapterCall((signal) => provider.prepareKernelStop!({ ...adapterContext(definition, value), process: target, signal }), 15000));
  if (fresh.scopeSha256 !== confirmed.scopeSha256 || serviceMetadataDigest(fresh.binding) !== serviceMetadataDigest(confirmed.binding)) throw new CommandFailure("refused", "CONFLICT", "the broker binding or dependant scope changed after confirmation; no signal was sent", { target: instanceProjection(row) });
  hold.check();
  const role = readProcessCommand(target.pid);
  if (role.kind !== "command" || commandIsCotalSupervisor(role.command) || assertRecordIdentity(target).kind !== "match") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the broker process identity or role could not be re-established immediately before the signal; no signal was sent", { target: instanceProjection(row) });
  const requestId = randomUUID();
  row = transition(row, { state: "stopping", requestId });
  try {
    if (assertRecordIdentity(target).kind !== "match") throw new Error("identity changed");
    process.kill(target.pid, "SIGTERM");
  } catch {
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the exact broker signal was not confirmed delivered to the pinned process; its stop request was retained and no exit was attributed to it", { target: instanceProjection(row) });
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = observeServiceProcess(row.record.value);
    if (gone(state)) {
      let trace: "ports-file-removed" | "ports-file-retained" = "ports-file-retained";
      try { trace = provider.observeKernelStop!({ ...adapterContext(definition, row.record.value), process: target }); }
      catch { /* The observed exit stands; an unreadable trace is reported as retained, never removed. */ }
      const kernelStop = serviceAdapterKernelStopResult({ kind: "kernel-exit", requestId, scopeSha256: confirmed.scopeSha256, process: target, observation: "exact-process-exit", brokerShutdownTrace: trace, cleanup: "not-checked", observedAt: new Date().toISOString() });
      return { instance: transition(row, { state: "stopped", readiness: "not-checked", kernelStop }), noOp: false, kernelStop };
    }
    if (state !== "running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker exit could not be attributed; its stop request was retained", { target: instanceProjection(row) });
    await delay(100);
  }
  throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker did not exit within its stop window; the request was retained without force kill or restart", { target: instanceProjection(row), remedy: "inspect the exact broker instance before another action; a later stop of this instance is refused until it is reconciled" });
}

export function assertNoServiceUnitAttempts(space: string, name: string): void {
  const pending = [...serviceInstallIntents(space), ...serviceUninstallIntents(space)].filter((row) => row.record.value.definition === name);
  const nativeActions = serviceUnitActionStore(space).list();
  if (nativeActions.some((row) => row.name !== row.record.value.instanceId)) throw new CommandFailure("refused", "SCHEMA_INVALID", "a native action filename differs from its full instance ID; no process effect was submitted");
  const actions = nativeActions.filter((row) => row.record.value.definition === name);
  if (pending.length || actions.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a retained native installation, removal or unit action names this definition; no direct process effect was substituted", { target: { space, name, attempts: [...pending, ...actions].map((row) => ({ instanceId: row.name, attemptId: row.record.value.attemptId })) } });
}

export function removableServiceInstances(space: string, name: string): ServiceInstanceSnapshot[] {
  const pending = [...serviceInstallIntents(space), ...serviceUninstallIntents(space)].filter((row) => row.record.value.definition === name);
  if (pending.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service remove cannot discard a definition while an installation or removal attempt may still own a unit, private store or enable link", { target: { space, name, attempts: pending.map((row) => ({ instanceId: row.name, attemptId: row.record.value.attemptId, step: row.record.value.step, position: row.record.value.position })) }, remedy: "inspect and reconcile every retained native unit attempt before removing this definition" });
  const nativeActions = serviceUnitActionStore(space).list();
  if (nativeActions.some((row) => row.name !== row.record.value.instanceId)) throw new CommandFailure("refused", "SCHEMA_INVALID", "a native action filename differs from its full instance ID; no definition was removed");
  const actions = nativeActions.filter((row) => row.record.value.definition === name);
  if (actions.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service remove cannot discard a definition while an exact native action is retained", { target: { space, name, attempts: actions.map((row) => ({ instanceId: row.name, attemptId: row.record.value.attemptId, operation: row.record.value.operation, position: row.record.value.position })) } });
  const rows = serviceInstances(space, name);
  for (const row of rows) refuseRecordedSupervisor(row.record.value, "remove");
  for (const row of rows) if (!gone(observeServiceProcess(row.record.value))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service remove requires every recorded owned instance stopped and its supervisor uninstalled", { target: instanceProjection(row), remedy: `use cotal service stop ${name} --instance ${row.name} before removing its definition` });
  // A settled exit is a record of evidence, not an unknown request. An unsettled one is settled by
  // the named stop, which signals nothing when the process is already gone.
  const settle = (row: ServiceInstanceSnapshot) => row.record.value.state === "stopping" || retainedStopRequest(row.record.value) ? { remedy: `inspect the original request with cotal service status ${name} --instance ${row.name} --space ${space}` }
    : UNSETTLED_RUN.includes(row.record.value.state) ? { remedy: `record the exit with cotal service stop ${name} --instance ${row.name} --space ${space} --yes, then remove it` } : {};
  for (const row of rows) if (row.record.value.nativeStopRequired && row.record.value.process && !row.record.value.nativeStop && !exitedWithoutStop(row.record.value)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service has no confirmed terminal stop; its launch and unknown request cannot be forgotten merely because the process disappeared", { target: instanceProjection(row), ...settle(row) });
  for (const row of rows) if (row.record.value.kernelStopRequired && row.record.value.process && !row.record.value.kernelStop && !exitedWithoutStop(row.record.value)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker has no recorded exact-exit stop from this controller; its launch cannot be forgotten merely because the process disappeared", { target: instanceProjection(row), ...settle(row) });
  return rows;
}

/** Called under the definition writer lock, after stopped/host/supervisor checks for every row. */
export function removeStoppedInstanceRecords(space: string, name: string): void {
  const rows = removableServiceInstances(space, name), removed: string[] = [];
  try {
    for (const row of rows) { serviceInstanceStore(space).commit(row.name, row, undefined); removed.push(row.name); }
  } catch (error) {
    if (!removed.length) throw error;
    throw new CommandFailure("partial", "OPERATION_PARTIAL", "some stopped instance records were removed, but the definition was kept after another record changed", { target: { space, name }, changed: removed.map((instanceId) => ({ kind: "stopped-instance-record", instanceId })), remedy: "inspect the remaining records before another removal; no process was signalled and logs were retained" });
  }
}

/** Read only bounded regular-file bytes; log data is not promised to be secret-redacted. */
export function readServiceLog(space: string, id: string, tail: number) {
  const path = serviceLogPath(space, id);
  if (!path) return { lines: [] as string[], omittedBytes: 0, path: null };
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [] as string[], omittedBytes: 0, path }; throw error; }
  try {
    const info = fstatSync(fd);
    if (![info.size, info.dev, info.ino].every((number) => Number.isSafeInteger(number) && number >= 0)) throw new CommandFailure("refused", "UNSUPPORTED", "this log's native file coordinates cannot be represented safely; no approximate byte offsets were reported");
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the service log is not an owned private regular file");
    const length = Math.min(info.size, 1024 * 1024), start = info.size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) { const count = readSync(fd, buffer, offset, length - offset, start + offset); if (!count) break; offset += count; }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (start) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    const all = text.replace(/\n$/, "").split("\n");
    return { lines: text ? all.slice(-tail) : [], omittedBytes: start, path };
  } finally { closeSync(fd); }
}

/** One bounded raw log slice. File identity and byte offsets are local file facts, not global sequences. */
export function serviceLogSlice(space: string, id: string, position: { offset: number; dev: number; ino: number } | undefined, tail: number) {
  const path = serviceLogPath(space, id);
  if (!path) return undefined;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const info = fstatSync(fd);
    if (![info.size, info.dev, info.ino].every((number) => Number.isSafeInteger(number) && number >= 0)) throw new CommandFailure("refused", "UNSUPPORTED", "this log's native file coordinates cannot be represented safely; no approximate byte offsets were reported");
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the selected service log is not an owned private regular file");
    const replaced = position !== undefined && (position.dev !== info.dev || position.ino !== info.ino);
    const truncated = position !== undefined && !replaced && info.size < position.offset;
    let offset = position && !replaced && !truncated ? position.offset : 0;
    let omittedBytes = 0;
    if (!position || replaced || truncated) {
      const length = Math.min(info.size, 1024 * 1024), start = info.size - length;
      const sample = Buffer.alloc(length);
      let read = 0;
      while (read < length) { const count = readSync(fd, sample, read, length - read, start + read); if (!count) break; read += count; }
      let cursor = read && sample[read - 1] === 10 ? read - 1 : read;
      for (let count = 0; count < tail; count++) { if (cursor <= 0) { cursor = -1; break; } cursor = sample.lastIndexOf(10, cursor - 1); if (cursor < 0) break; }
      offset = start + cursor + 1;
      omittedBytes = offset;
    } else if (info.size - offset > 1024 * 1024) {
      const next = info.size - 1024 * 1024;
      omittedBytes = next - offset;
      offset = next;
    }
    const buffer = Buffer.alloc(Math.min(16_384, Math.max(0, info.size - offset)));
    const count = buffer.length ? readSync(fd, buffer, 0, buffer.length, offset) : 0;
    return { file: { dev: info.dev, ino: info.ino }, fromOffset: offset, toOffset: offset + count, sizeAtRead: info.size, bytes: buffer.subarray(0, count), omittedBytes, replaced, truncated };
  } finally { closeSync(fd); }
}
