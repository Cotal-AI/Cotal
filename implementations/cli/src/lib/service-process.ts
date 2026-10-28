import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CommandFailure, assertRecordIdentity, shellPath, boundedValue, canonicalRoot, commandIsCotalSupervisor, isCommandFailure, maintenanceAdmitsStackWork, readMaintenanceJournal, readProcessCommand, readServiceStopRequest, resolveNativeServiceTarget, loopbackListeners, processGroupMembers, processGroupOf, serviceAdapterReadiness, serviceMetadataDigest, spaceKey, serviceAdapterKernelStopPlan, serviceAdapterKernelStopResult, serviceAdapterStopPlan, serviceAdapterStopAbandonment, serviceAdapterStopRefusal, serviceAdapterStopResult, type ServiceAdapterStopAbandonment, type ServiceAdapterAttempt, type ServiceAdapterKernelStopPlan, type ServiceAdapterPreservedStop, type ServiceAdapterStopPlan, type ServiceAdapterContext, type ServiceDefinitionInput, type ControllerStackView, type OutputWarning, isWorkspaceTargetError, oneLine, targetErrorCode, workspaceErrorParts, type MeshTargetError, localRecordAccess, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { refuseRecordedSupervisor } from "./service-supervision.js";
import { serviceInstallIntents } from "./service-install-intent.js";
import { serviceUninstallIntents } from "./service-uninstall-intent.js";
import { serviceUnitActionStore } from "./service-unit-action.js";
import { daemonArgv } from "./self-exec.js";
import { loadServiceAdapter, resolveServiceAdapter, sameServiceAdapterPin, type LoadedServiceAdapter, type ResolvedServiceAdapter } from "./service-adapters.js";
import { serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { instanceProjection, observeServiceProcess, processServiceHost, requireProcessIdentity, serviceInstances, serviceInstanceStore, type ServiceCustody, type ServiceInstance, type ServiceInstanceSnapshot } from "./service-instances.js";
import { maintenanceStackView, STACK_DEFINITION, stackMemberRecord } from "./stack-journal.js";
import { askCustodian, custodiedPlatform, custodyLog, removeCustodyCapability, startCustodiedService } from "./service-custody-win32.js";
import { seedBeforeLaunch } from "../seed/launch.js";

export const PROCESS_SERVICE_CAPABILITIES = Object.freeze({ multiInstance: true, foreground: true, logs: true, install: false });
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
/** How long a launch with process readiness waits for an immediate exit before it reports the process running. */
const PROCESS_SETTLE_MS = 1000;
const gone = (state: string) => state === "gone" || state === "previous-boot" || state === "foreign-pid";
/** A log this account may read and append to. Windows protects it with the access list Cotal sets
 *  when it creates the file and has no POSIX owner or mode to check, as for every local record. */
const privateLog = (info: Stats) => info.isFile() && (localRecordAccess() === "windows-acl" || info.uid === process.getuid!() && (info.mode & 0o077) === 0);
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
 *  process shows, as after a refusal within the call. A record left `stopping` by a stopper that
 *  exited before it published a request handed the child nothing, so it also returns to what its
 *  process shows, as a stop that published nothing does within its call. A signal stop whose
 *  exact process still runs (see {@link resumableSignalStop}) returns to `running`. Any other record,
 *  including one whose adapter confirms less, is returned unchanged. */
export async function settleRetainedNativeStop(definition: ServiceDefinitionSnapshot, row: ServiceInstanceSnapshot): Promise<ServiceInstanceSnapshot> {
  const value = row.record.value, launch = definition.record.value.launch, retained = retainedStopRequest(value);
  if (value.nativeStopRequired && value.process && value.state === "stopping" && !retained) {
    const observed = observeServiceProcess(value);
    return transition(row, { state: observed === "running" ? "running" : gone(observed) ? "failed" : "unknown", readiness: "not-checked" });
  }
  if (resumableSignalStop(value)) return transition(row, { state: "running", readiness: "not-checked" });
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

/** Whether {@link settleRetainedNativeStop} may change this record before a classification reads it:
 *  a native `stopping` record that published no request, a signal stop whose process still runs, or a
 *  published native stop, which only its adapter's receipts decide. */
export function retainedStopMaySettle(value: ServiceInstance): boolean {
  const retained = retainedStopRequest(value);
  return value.nativeStopRequired && value.process !== undefined && value.state === "stopping" && !retained || resumableSignalStop(value) || retained?.publication === "published";
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

/** A broker's kernel-exit stop or a generic process stop that its stopper left `stopping` while that
 *  exact process still runs. Such a stop records `stopping` before it signals, so a stopper cut off
 *  in between signalled nothing, and no exit was observed as its own either way. Under the
 *  definition's writer lock its stopper has exited, so the record returns to `running` and the next
 *  stop signals the process again. */
export function resumableSignalStop(value: ServiceInstance): boolean {
  return !value.nativeStopRequired && value.state === "stopping" && value.process !== undefined && observeServiceProcess(value) === "running";
}

/** A broker's kernel-exit stop or a generic process stop that its stopper left `stopping` when it
 *  exited before it observed the exit, once that exact process is gone. Only an operator abandons it. */
export function abandonableSignalStop(value: ServiceInstance): boolean {
  return !value.nativeStopRequired && value.state === "stopping" && value.process !== undefined && gone(observeServiceProcess(value));
}

/** Abandon, on an operator's explicit request, the signal stop `requestId` this record retains (see
 *  {@link abandonableSignalStop}). The caller holds the definition's writer lock, so the stopper that
 *  recorded the request has exited. The record is recorded `failed`, as a process that exited without
 *  a confirmed stop, because no exit was observed as that stop's own. */
export function abandonRetainedSignalStop(row: ServiceInstanceSnapshot, requestId: string): ServiceInstanceSnapshot {
  const value = row.record.value, target = { ...instanceProjection(row), requestId };
  if (value.nativeStopRequired || value.state !== "stopping" || value.requestId !== requestId || !value.process) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this instance retains no stop request with that ID; nothing was abandoned", { target });
  if (!gone(observeServiceProcess(value))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the process this stop request names still runs; nothing was abandoned", { target });
  return transition(row, { state: "failed", readiness: "not-checked" });
}

/** Record `failed`, on an operator's explicit request, a launch whose record names no process: its
 *  launcher ended after it recorded the launch and before it recorded the child. The caller holds the
 *  definition's writer lock, which that launcher held, so it has exited. A child it spawned without
 *  recording is not excluded, and nothing here looks for one. */
export function abandonUnresolvedLaunch(row: ServiceInstanceSnapshot): ServiceInstanceSnapshot {
  if (observeServiceProcess(row.record.value) !== "unresolved-launch") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this instance's launch is not unresolved: its record names a process or a settled state; nothing was abandoned", { target: instanceProjection(row) });
  return transition(row, { state: "failed", readiness: "not-checked" });
}

/** What an interrupt records for each launch this process recorded and has not yet pinned to its child. */
const unpinnedLaunches = new Set<() => void>();

/** For a command that ends itself on an interrupt: record each launch it has not yet pinned to its
 *  child. One with no spawned child is recorded `failed`. One whose child was spawned is recorded with
 *  that child's identity; when that cannot be read, it is recorded `failed` with the exit once the
 *  child has exited and `unknown` before, as a failed pin is. Without this, the record names no
 *  process, and only `down --abandon-launch` resolves it. */
export function settleInterruptedLaunches(): void {
  for (const settle of unpinnedLaunches) settle();
}

/** The refusal for a retained native stop, made before any readiness probe, stop request or record
 *  write. This command has no effect, so it is refused; only the earlier stop's outcome is unknown. A
 *  request file that does not read as this launch's own is named an unknown publication. */
function retainedNativeStop(definition: ServiceDefinitionSnapshot, row: ServiceInstanceSnapshot, retained: NativeStopEvidence): CommandFailure {
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", retained.publication === "published"
    ? "an earlier native stop request is retained without its terminal receipt, so its outcome is unknown; nothing was submitted or written and its exit was not settled as a crash"
    : "this launch's native stop request file does not read as its own, so whether an earlier stop was published is unknown; nothing was submitted or written and its exit was not settled as a crash",
  { target: { ...instanceProjection(row), requestId: retained.requestId, stopPublication: retained.publication }, remedy: `inspect the original request with \`cotal service status ${definition.name} --instance ${row.name} --space ${row.record.value.space}\`` });
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
  if (rows.length !== 1) {
    // Each record is named with its state, and one whose process is gone with the command that
    // clears it. A record still marked running after its process exited reads as exited.
    const { definition, space } = rows[0]!.record.value;
    const ended = (row: ServiceInstanceSnapshot) => gone(observeServiceProcess(row.record.value));
    const state = (row: ServiceInstanceSnapshot) => ended(row) && UNSETTLED_RUN.includes(row.record.value.state) ? "exited" : row.record.value.state;
    const clear = rows.filter(ended).map((row) => `cotal service remove ${definition} --instance ${row.name} --space ${space} --yes`);
    throw new CommandFailure("refused", "TARGET_AMBIGUOUS", `this definition has several instance records; choose --instance with one full ID: ${rows.map((row) => row.name).join(", ")}`, {
      target: { candidates: rows.map((row) => row.name) },
      remedy: `pass --instance with one of ${rows.map((row) => `${row.name} (${state(row)})`).join(", ")}${clear.length ? `; clear a stopped record you no longer need with ${clear.join("; ")}` : ""}`,
    });
  }
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
  return isAbsolute(source) ? source : resolve(definition.launch.cwd, source);
}

function environment(definition: ServiceDefinitionInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // LOCALAPPDATA locates Cotal's own folder on Windows when COTAL_HOME is unset, as HOME does elsewhere.
  // The usage telemetry variables and CI reach the service as they reach a seat (docs/telemetry.md).
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "COTAL_HOME", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DO_NOT_TRACK", "CI", "COTAL_TELEMETRY", "COTAL_TELEMETRY_DISABLED", "COTAL_TELEMETRY_URL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  // Variable names are not secrets, so a missing one is named with the child variable it feeds.
  const missing = Object.entries(definition.envRefs ?? {}).filter(([, source]) => process.env[source] === undefined);
  if (missing.length) {
    const sources = missing.map(([, source]) => source);
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the environment this command runs in does not set ${missing.map(([destination, source]) => `${source} (passed to the service as ${destination})`).join(", ")}; no environment value was printed and no process was launched`, {
      target: { missing: missing.map(([destination, source]) => ({ variable: source, as: destination })) },
      remedy: `set ${sources.join(" and ")} in the shell that runs cotal, then run the command again`,
    });
  }
  for (const [destination, source] of Object.entries(definition.envRefs ?? {})) env[destination] = process.env[source];
  if (definition.credentialRef) env.COTAL_CREDS = definition.credentialRef.path;
  return env;
}

export function serviceLogPath(space: string, id: string, create = false): string | undefined {
  const dir = serviceInstanceStore(space).directory(create);
  return dir ? join(dir, `${spaceKey(id)}.log`) : undefined;
}

/** The size at which a background launch moves the instance's log aside before it starts. */
const LOG_ROTATE_BYTES = 16 * 1024 * 1024;

/** Move a log that reached {@link LOG_ROTATE_BYTES} to `<log>.1`, replacing an earlier one, so the
 *  launch starts a fresh file. Only a start or restart rotates, so a running service's log grows
 *  until its next start. */
function rotateServiceLog(path: string): void {
  let info;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!privateLog(info)) throw new Error("unprotected log target");
  if (info.size >= LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
}

/** Delete the instances' logs, `<log>` and the rotated `<log>.1`, and return the paths deleted. */
export function removeServiceLogs(space: string, ids: readonly string[]): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    const path = serviceLogPath(space, id);
    if (!path) continue;
    for (const file of [path, `${path}.1`]) {
      try { unlinkSync(file); removed.push(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new CommandFailure("partial", "OPERATION_PARTIAL", `the definition and its stopped instance records were removed, but the log ${file} was not deleted: ${(error as Error).message}`, { target: { space, instanceId: id }, changed: removed.map((log) => ({ kind: "service-log", path: log })), remedy: `delete ${file} yourself` });
      }
    }
  }
  return removed;
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

/** What a failed bounded readiness request saw, in words. No response body or header is kept. */
function httpReadinessFailure(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused, so nothing listened there";
  if ((error as { name?: unknown } | undefined)?.name === "TimeoutError") return "no answer before the request timed out";
  return typeof code === "string" ? `the request failed with ${code}` : "the request failed";
}

/** Whether something already answers `url` before a child is launched: any HTTP answer there would
 *  then not be the new process's. A refused, failed or unanswered request is not an answer. */
async function readinessAddressAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** The processes of this account that listen on `url`'s loopback address, each as its PID and
 *  program name. */
function addressHolders(url: string): string[] {
  return loopbackListeners(url).map((pid) => {
    const command = readProcessCommand(pid);
    return command.kind === "command" ? `${pid} (${basename(command.command.split(" ")[0]!)})` : String(pid);
  });
}

/** A warning for each saved service of `space`, or of those of `names`, whose HTTP readiness address
 *  still answers while none of its instances runs, as a descendant that outlived a stop, or left the
 *  service's process group, can. It names the address and the processes of this account that listen
 *  there. Saved services that cannot be read give one warning saying no address was checked. */
export async function readinessAddressSurvivors(space: string, names?: readonly string[]): Promise<OutputWarning[]> {
  const idle: { name: string; url: string }[] = [];
  try {
    for (const row of serviceDefinitionStore(space).list()) {
      const { readiness } = row.record.value;
      if (readiness.type !== "http" || (names && !names.includes(row.name))) continue;
      if (!serviceInstances(space, row.name).some((instance) => observeServiceProcess(instance.record.value) === "running")) idle.push({ name: row.name, url: readiness.url });
    }
  } catch (error) {
    // The command this reports for has already done its work, so an unreadable record is named here.
    if (!(error instanceof CommandFailure)) throw error;
    return [{ code: "SERVICE_ADDRESS_NOT_CHECKED", target: { space }, message: `the saved services could not be read (${error.message}), so no address a stopped one may still hold was checked` }];
  }
  const warnings: OutputWarning[] = [];
  for (const { name, url } of idle) {
    if (!await readinessAddressAnswers(url)) continue;
    const address = new URL(url).host;
    const holders = addressHolders(url);
    warnings.push({ code: "SERVICE_ADDRESS_HELD", target: { space, definition: name, address }, message: `something still answers ${address}, where ${name}'s HTTP readiness is checked, and no instance of ${name} runs${holders.length ? `; process ${holders.join(", ")} of this account listens there` : ""}` });
  }
  return warnings;
}

export async function serviceReadiness(row: ServiceInstanceSnapshot, definition: ServiceDefinitionInput, adapter?: { provider: LoadedServiceAdapter; context: ServiceAdapterContext }): Promise<ServiceInstanceSnapshot> {
  const deadline = Date.now() + definition.readiness.timeoutMs;
  // The last HTTP readiness observation, named when the deadline passes first: the status the
  // service answered with, or what a failed request saw.
  let seen: { status: number } | { failure: string } | undefined;
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
      seen = { status: response.status };
    } catch (error) {
      // A failed bounded HTTP read is not proof of process death or listener ownership.
      seen = { failure: httpReadinessFailure(error) };
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  const uncertain = transition(row, { state: "unknown", readiness: "not-checked" });
  if (definition.readiness.type === "http") {
    // The address alone is named: a definition's URL is kept out of reports, and its path may carry a token.
    const { definition: name, instanceId, space } = uncertain.record.value, host = new URL(definition.readiness.url).host;
    const inspect = `read its output with \`cotal service logs ${name} --instance ${instanceId} --space ${space}\`, and stop it with \`cotal service stop ${name} --instance ${instanceId} --space ${space} --yes\` before another start`;
    // A service that answered with another status said it is not ready, so the start failed.
    if (seen && "status" in seen)
      throw new CommandFailure("failed", "OPERATION_FAILED", `the owned process answered its HTTP readiness check on ${host} with status ${seen.status}, not ${definition.readiness.expectedStatus}, until its ${definition.readiness.timeoutMs} ms deadline passed. The process was left running, not relaunched or killed`, { target: instanceProjection(uncertain), remedy: inspect });
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the owned process did not answer its HTTP readiness check on ${host} with status ${definition.readiness.expectedStatus} within ${definition.readiness.timeoutMs} ms; the last check saw ${seen?.failure ?? "no completed request"}. The process was left running, not relaunched or killed`, {
      target: instanceProjection(uncertain),
      remedy: `${inspect}; \`cotal service show ${name} --space ${space}\` shows the readiness deadline it missed`,
    });
  }
  throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the owned process did not establish its declared readiness before the deadline; it was not relaunched or automatically killed", { target: instanceProjection(uncertain), remedy: "inspect service status/logs with the original full instance ID before another start" });
}

/** A target the adapter could not resolve, as the refusal its code and remedy name. */
function targetRefusal(error: MeshTargetError): CommandFailure {
  const { message, remedy } = workspaceErrorParts({ kind: "target", error });
  return new CommandFailure("refused", targetErrorCode(error.code), message, remedy ? { remedy } : {});
}

export function prepareProcessService(definition: ServiceDefinitionSnapshot) {
  processServiceHost();
  validateServiceDefinition(definition.record.value, definition.record.value.space, true, false, definition.name);
  const launch = definition.record.value.launch;
  const program = launch.type === "process" ? executable(definition.record.value) : undefined;
  if (launch.type === "process" && commandIsCotalSupervisor([program, ...launch.args].join(" "))) throw new CommandFailure("refused", "UNSUPPORTED", "a native manager needs its service adapter and agent-impact guards, not generic process control; no instance was allocated");
  const adapter = launch.type === "adapter" ? resolveServiceAdapter(launch.adapter, launch.options) : undefined;
  let cliInvocation: string[] | undefined;
  if (adapter?.declaration.requiresCli) {
    try { cliInvocation = daemonArgv(); }
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

/** The refusal for a start that selects an instance of an earlier revision, as one a definition moved
 *  aside and added again leaves. Nothing adopts or removes it: an added service's Next stops it if it
 *  still runs, then forgets its record, so the next start launches the current revision. A stack
 *  member's records stay with its stack, so its refusal names no command. */
function staleRevisionInstance(definition: ServiceDefinitionSnapshot, selected: ServiceInstanceSnapshot): CommandFailure {
  const { name } = definition, { space } = definition.record.value, id = selected.name;
  const forget = `forget its record with \`cotal service remove ${name} --instance ${id} --space ${space} --yes\`, then run \`cotal service start ${name} --space ${space}\` again`;
  const remedy = (Object.values(STACK_DEFINITION) as string[]).includes(name) ? undefined
    : gone(observeServiceProcess(selected.record.value)) ? forget : `stop it with \`cotal service stop ${name} --instance ${id} --space ${space} --yes\`, ${forget}`;
  return new CommandFailure("refused", "CONFLICT", "this instance belongs to another definition revision; it was not adopted", { target: instanceProjection(selected), remedy });
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
  if (options.foreground && custodiedPlatform()) throw new CommandFailure("refused", "UNSUPPORTED", "on Windows a service runs in the background under the custodian that holds its job; a terminal-attached foreground child was not substituted", { remedy: `start it in the background with \`cotal service start ${definition.name} --space ${value.space}\`` });
  if (declaredAdapter && (options.newInstance && !declaredAdapter.declaration.capabilities.multiInstance || options.foreground && !declaredAdapter.declaration.capabilities.foreground)) throw new CommandFailure("refused", "UNSUPPORTED", "the selected adapter does not declare this multi-instance or foreground capability; no launch was allocated");
  const hold = held ?? serviceDefinitionStore(value.space).pin(definition);
  let child: ChildProcess | undefined, unpinned: (() => void) | undefined, spawnedCustody: ServiceCustody | undefined;
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
    if (selected && selected.record.value.definitionRevision !== definition.record.revision) throw staleRevisionInstance(definition, selected);
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
      if (declaredAdapter?.declaration.stop === "native" && selected.record.value.process && !settledExit && !(selected.record.value.state === "stopped" && selected.record.value.nativeStop)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native service disappeared during its retained stop request, without its recorded terminal stop; no replacement was launched", { target: instanceProjection(selected), remedy: `inspect the original request with \`cotal service status ${definition.name} --instance ${selected.name} --space ${value.space}\`` });
      if (declaredAdapter?.declaration.stop === "kernel-exit" && selected.record.value.process && !settledExit && !(selected.record.value.state === "stopped" && selected.record.value.kernelStop)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original broker process disappeared during its retained stop request, without this controller's recorded exact-exit stop; no replacement listener was launched over its store", { target: instanceProjection(selected), remedy: `inspect the original request with \`cotal service status ${definition.name} --instance ${selected.name} --space ${value.space}\`` });
    }
    // HTTP readiness proves only that something answers, so an address that answers before the
    // launch could pass a child that never listened, such as a second instance on the first one's port.
    if (value.readiness.type === "http" && await readinessAddressAnswers(value.readiness.url)) {
      const host = new URL(value.readiness.url).host, live = rows.find((row) => observeServiceProcess(row.record.value) === "running");
      // Another listener, such as a server that left a stopped instance's process group, is named as
      // SERVICE_ADDRESS_HELD names it. It is not signalled: no instance of this service owns it.
      const holders = live ? [] : addressHolders(value.readiness.url);
      throw new CommandFailure("refused", "CONFLICT", `something already answers ${host}, where ${definition.name}'s HTTP readiness is checked, so a new process's readiness could not be told from it${holders.length ? `; process ${holders.join(", ")} of this account listens there` : ""}; nothing was launched`, {
        target: { space: value.space, definition: definition.name, address: host, ...(live ? { instanceId: live.name } : {}) },
        remedy: live ? `instance ${live.name} of ${definition.name} answers there; give another instance its own port, or stop that one with \`cotal service stop ${definition.name} --instance ${live.name} --space ${value.space} --yes\` first`
          : holders.length ? `stop process ${holders.join(", ")}, which is not an instance of ${definition.name}, then run the command again` : `stop what listens on ${host}, then run the command again`,
      });
    }
    // An `up` reconciles the connector seed store here, once every refusal above has passed.
    await seedBeforeLaunch();
    hold.check();
    const now = new Date().toISOString(), id = options.brokerInstance?.instanceId ?? options.replacement?.instanceId ?? selected?.name ?? randomUUID(), launchRequestId = options.brokerInstance?.launchRequestId ?? options.replacement?.launchRequestId ?? randomUUID();
    const instance: ServiceInstance = { schemaVersion: 1, instanceId: id, definition: definition.name, definitionRevision: definition.record.revision, space: value.space, host: processServiceHost(), requestId: launchRequestId, launchRequestId, state: "starting", launcher, readiness: "not-checked", supervisor: "none", ...(options.attempt ? { attempt: { attemptId: options.attempt.attemptId } } : {}), ...(declaredAdapter ? { adapter: declaredAdapter.pin, ...(declaredAdapter.declaration.stop === "native" ? { nativeStopRequired: true as const } : declaredAdapter.declaration.stop === "kernel-exit" ? { kernelStopRequired: true as const } : {}) } : {}), foreground: options.foreground === true, createdAt: selected?.record.value.createdAt ?? now, updatedAt: now };
    const store = serviceInstanceStore(value.space);
    store.commit(id, selected, instance);
    // The replaced incarnation's custodian is gone, so its capability opens nothing.
    removeCustodyCapability(value.space, selected?.record.value.custody);
    let row = store.read(id)!;
    // Until the child's identity is recorded, an interrupt records this launch on its way out. On
    // Windows that is its custodian, which can still be asked for the job once it is recorded.
    unpinned = () => {
      if (spawnedCustody) { row = transition(row, { custody: spawnedCustody, state: "unknown", readiness: "not-checked" }); return; }
      if (child?.pid === undefined) { row = transition(row, { state: "failed", readiness: "not-checked" }); return; }
      let identity;
      try { identity = requireProcessIdentity(child.pid); } catch { identity = undefined; }
      row = transition(row, identity ? { process: identity } : { state: exited ? "failed" : "unknown", ...(exited ? { exit: { code: exitCode, signal: exitSignal } } : {}) });
    };
    unpinnedLaunches.add(unpinned);
    // Smoke only: hold a recorded launch before its child exists, so a signal can land in that window.
    if (process.env.COTAL_SMOKE_HOLD_AFTER_LAUNCH_RECORD === "1") await delay(60_000);
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
        const validated = validateServiceDefinition({ ...value, launch: { type: "process", ...plan }, readiness: { type: "process", timeoutMs: value.readiness.timeoutMs } }, value.space, true, true);
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
      if (failure?.outcome === "refused") {
        // A record the adapter refused on, whose process a member of this space's stack runs, is
        // named with that member, as `up` names a service it does not replace.
        const path = (failure.target as { path?: unknown } | undefined)?.path;
        const member = typeof path === "string" ? stackMemberRecord(value.space, path) : undefined;
        throw new CommandFailure("refused", failure.code, member
          ? `service preparation was refused before a child launch: the ${member.definition} member of this space's controller stack runs the process recorded at ${path} (pid ${member.pid}, instance ${member.instanceId}), so ${definition.name} does not start beside it`
          : `service preparation was refused before a child launch: ${failure.message}`, { target: instanceProjection(row), native: { code: failure.code, outcome: failure.outcome, detail: failure.message },
          remedy: member ? `stop it with \`cotal down ${member.definition} --instance ${member.instanceId} --space ${value.space} --yes\`, then run \`cotal service start ${definition.name} --space ${value.space}\` again` : failure.remedy });
      }
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "service preparation did not establish an accepted direct-child launch plan; no child was launched, and no provider or launch was retried", { target: instanceProjection(row) });
    }
    const path = serviceLogPath(value.space, id, true)!;
    let log: number | undefined;
    // Where this launch's own log lines start, so a failure quotes this launch and not an earlier one.
    let logFrom: number | undefined;
    let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
    let exited = false;
    let done!: () => void;
    const exit = new Promise<void>((resolve) => { done = resolve; });
    let identity: ProcessIdentityRecord;
    if (custodiedPlatform()) {
      // Windows: a custodian creates the program inside a kill-on-close job and reports its pin.
      let started;
      try {
        rotateServiceLog(path);
        logFrom = custodyLog(path);
        started = await startCustodiedService(row.record.value, { ...launch, env }, path, (custody) => { spawnedCustody = custody; });
      } catch (error) {
        row = transition(row, spawnedCustody ? { custody: spawnedCustody, state: "unknown", readiness: "not-checked" } : { state: "failed", readiness: "not-checked" });
        throw new CommandFailure(spawnedCustody ? "unknown" : "failed", spawnedCustody ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", `the custodied process launch did not report a running service child (${(error as Error).message}); its instance receipt was retained`, { target: instanceProjection(row) });
      }
      identity = started.process;
      row = transition(row, { process: identity, custody: started.custody });
      unpinnedLaunches.delete(unpinned);
      // The custodian holds the program; this launch watches its pin to notice an early exit.
      const pinned = identity;
      const watch = setInterval(() => {
        if (assertRecordIdentity(pinned).kind === "match") return;
        clearInterval(watch);
        exited = true;
        done();
      }, 100);
      watch.unref();
      exit.then(async () => {
        try { exitCode = (await askCustodian(row, { op: "status" })).root.exit; } catch { /* The custodian already left with its job; the log keeps the cause. */ }
      });
    } else {
      try {
        if (!options.foreground) {
          rotateServiceLog(path);
          log = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
          const info = fstatSync(log);
          if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error("unprotected log target");
          logFrom = info.size;
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
      try { identity = requireProcessIdentity(child.pid); }
      catch {
        if (!exited) child.kill("SIGTERM");
        await Promise.race([exit, delay(3000)]);
        row = transition(row, { state: exited ? "failed" : "unknown", ...(exited ? { exit: { code: exitCode, signal: exitSignal } } : {}) });
        throw new CommandFailure(exited ? "failed" : "unknown", exited ? "OPERATION_FAILED" : "OPERATION_UNKNOWN", "the child could not be creation-pinned; its native child handle was asked to exit, and no replacement was launched", { target: instanceProjection(row) });
      }
      row = transition(row, { process: identity });
      unpinnedLaunches.delete(unpinned);
    }
    // A process that exits at once never ran: process readiness first gives it a moment to do so,
    // and that exit is then settled below with the code this parent observed.
    if (value.readiness.type === "process") await Promise.race([exit, delay(Math.min(PROCESS_SETTLE_MS, value.readiness.timeoutMs))]);
    let running: ServiceInstanceSnapshot;
    try { running = await serviceReadiness(row, value, adapter); }
    catch (error) {
      // Only an exit of the pinned child itself is settled here, with the exit this parent observed.
      if (!isCommandFailure(error) || error.code !== "OPERATION_FAILED" || observeServiceProcess(row.record.value) === "running") throw error;
      await Promise.race([exit, delay(1000)]);
      const failed = transition(row, { state: "failed", readiness: "not-checked", ...(exited ? { exit: { code: exitCode, signal: exitSignal } } : {}) });
      const last = logFrom === undefined ? undefined : lastLoggedLine(path, logFrom);
      throw new CommandFailure("failed", "OPERATION_FAILED", `the owned service process exited before readiness was established${exited ? ` (exit code ${exitCode ?? "none"}, signal ${exitSignal ?? "none"})` : ""}; ${last ? `the last line it logged is: ${last}` : "its log records the cause"}`, { target: instanceProjection(failed), remedy: `read its log with \`cotal service logs ${definition.name} --instance ${id} --space ${value.space}\`` });
    }
    return { instance: running, noOp: false, child, exit: { done: exit, observed: () => exited, result: () => ({ code: exitCode, signal: exitSignal }) } };
  } finally { if (unpinned) unpinnedLaunches.delete(unpinned); if (!held) hold.release(); }
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
  if (value.kernelStopRequired || declared?.declaration.stop === "kernel-exit") throw new CommandFailure("refused", "UNSUPPORTED", `${oneLine(definition.name)} runs a broker, which a set of names never stops; no service was stopped`, { remedy: `stop the services that use it, then the broker alone with \`cotal service stop ${definition.name} --instance ${selected.name} --space ${value.space} --yes\`` });
  if (gone(state)) return;
  if (state !== "running" || !value.process) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a selected service process is foreign, unreadable or unresolved; no service was stopped");
  const command = readProcessCommand(value.process.pid);
  if (command.kind !== "command" || commandIsCotalSupervisor(command.command)) throw new CommandFailure("refused", "UNSUPPORTED", "a selected process has an unreadable or manager-supervisor role; no generic set stop bypassed its native impact policy");
}

/** How long a process stop waits after SIGTERM before it sends SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 15_000;

/** Windows generic stop: the custodian terminates the instance's whole job, so a program that already
 *  exited is stopped with the members it left. The receipt names the program only when it was still
 *  running; the stop completes once the custodian, which holds the job, has exited. */
async function stopCustodiedProcess(current: ServiceInstanceSnapshot, initial: ReturnType<typeof observeServiceProcess>) {
  let row = current;
  if ((initial !== "running" && initial !== "members-running") || !row.record.value.process) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected process is foreign, unreadable or unresolved; it was not signalled", { target: instanceProjection(row) });
  const held = await askCustodian(row, { op: "status" });
  if (commandIsCotalSupervisor([held.program, ...held.args].join(" "))) throw new CommandFailure("refused", "UNSUPPORTED", "generic process stop cannot bypass manager agent-impact guards; use its supported service adapter. No job was terminated", { target: instanceProjection(row) });
  const program = { ...row.record.value.process }, custodian = row.record.value.custody!.custodian;
  row = transition(row, { state: "stopping", requestId: randomUUID() });
  const ended = await askCustodian(row, { op: "terminate", code: 1 });
  for (const deadline = Date.now() + 5000; assertRecordIdentity(custodian).kind === "match" && Date.now() < deadline;) await delay(100);
  if (ended.members.length || ended.root.exit === null || assertRecordIdentity(custodian).kind === "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the service's job did not confirm it emptied${ended.members.length ? `; process ${ended.members.join(", ")} still ran in it` : ""}; its record was retained and no restart was attempted`, { target: instanceProjection(row) });
  removeCustodyCapability(row.record.value.space, row.record.value.custody);
  const processStop = initial === "running" ? { processStop: { kind: "process-exit" as const, requestId: row.record.value.requestId, process: program, signal: "job-terminate" as const, observedAt: new Date().toISOString() } } : {};
  return { instance: transition(row, { state: "stopped", readiness: "not-checked", ...processStop }), noOp: false };
}

/** Windows: a program with a native or kernel-exit stop policy exited on its own, and its job still
 *  holds processes. Those end with the job, so a manager's agents end only on `--with-agents`. The
 *  custodian terminates the job to empty, and the record settles as an exit no stop explains. */
async function endLeftoverJob(current: ServiceInstanceSnapshot, membersMayEnd: boolean) {
  const row = current;
  const held = await askCustodian(row, { op: "status" });
  if (!membersMayEnd && held.members.length) throw new CommandFailure("refused", "UNSUPPORTED", `the service's program exited while its job still holds process ${held.members.join(", ")}, which would end with it; nothing was stopped`, { target: instanceProjection(row), remedy: `end them with \`cotal service stop ${row.record.value.definition} --instance ${row.name} --space ${row.record.value.space} --with-agents --yes\`` });
  const custodian = row.record.value.custody!.custodian;
  const ended = await askCustodian(row, { op: "terminate", code: 1 });
  for (const deadline = Date.now() + 5000; assertRecordIdentity(custodian).kind === "match" && Date.now() < deadline;) await delay(100);
  if (ended.members.length || assertRecordIdentity(custodian).kind === "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the service's job did not confirm it emptied${ended.members.length ? `; process ${ended.members.join(", ")} still ran in it` : ""}; its record was retained`, { target: instanceProjection(row) });
  removeCustodyCapability(row.record.value.space, row.record.value.custody);
  return { instance: settleExitedInstance(row), noOp: false };
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
      if (initial === "members-running") return await endLeftoverJob(row, native?.withAgents === true);
      if (initial !== "running" || !row.record.value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native stop has no current attributable process or retained returned receipt; disappearance was not treated as completion", { target: instanceProjection(row) });
      if (!native?.plan) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "native service stop requires its current caller-scoped impact and explicit confirmation; generic signals were not used");
      const plan = serviceAdapterStopPlan(native.plan, row.record.value.process);
      if (plan.withAgents !== native.withAgents || !samePreserved(plan.preserved, native.preserved)) throw new CommandFailure("refused", "CONFLICT", "the confirmed native stop policy differs from the submitted policy");
      const provider = await loadServiceAdapter(declared, launch.type === "adapter" ? launch.options : {});
      hold.check();
      // A preserved-exit caller journals its attempt first and passes that attempt's request ID.
      if (native.preserved && !native.requestId) throw new CommandFailure("refused", "USAGE_INVALID", "a preserved-exit stop needs its journaled attempt's request ID; no request was published");
      const requestId = native.requestId ?? randomUUID(), target = { ...row.record.value.process }, began = Date.now();
      if (custodiedPlatform() && !native.withAgents) {
        // A Windows manager's agents run in its job and end with it, so a stop that keeps them refuses.
        const others = (await askCustodian(row, { op: "status" })).members.filter((pid) => pid !== target.pid);
        if (others.length) throw new CommandFailure("refused", "UNSUPPORTED", `on Windows the manager's job also holds process ${others.join(", ")}, which would end with it; nothing was stopped`, { target: instanceProjection(row), remedy: `stop it with its agents, \`cotal service stop ${definition.name} --instance ${row.name} --space ${row.record.value.space} --with-agents --yes\`` });
      }
      row = transition(row, { state: "stopping", requestId });
      let returned = false;
      try {
        const raw = await adapterCall((signal) => provider.stop!({ ...adapterContext(definition, row.record.value), process: target, withAgents: native.withAgents, ...(native.preserved ? { preserved: { ...native.preserved } } : {}), requestId, plan, signal }), 45000);
        returned = true;
        const result = serviceAdapterStopResult(raw);
        // A Windows custodian exits a moment after the job it held empties.
        for (const deadline = Date.now() + 5000; custodiedPlatform() && observeServiceProcess(row.record.value) === "members-running" && Date.now() < deadline;) await delay(100);
        // The terminal kind must answer the submitted request: a preserved stop returns only
        // `preserved-exit-returned`, an ordinary stop only `returned`.
        if (result.nativeStop !== (native.preserved ? "preserved-exit-returned" : "returned") || result.requestId !== requestId || result.scopeSha256 !== plan.scopeSha256 || result.process.pid !== target.pid || result.process.token !== target.token || Date.parse(result.observedAt) < began - 1000 || Date.parse(result.observedAt) > Date.now() + 1000 || !gone(observeServiceProcess(row.record.value))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service did not confirm both its original returned stop and the exact process exit");
        removeCustodyCapability(row.record.value.space, row.record.value.custody);
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
    if (custodiedPlatform()) return await stopCustodiedProcess(row, initial);
    if (initial !== "running" || !row.record.value.process) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected process is foreign, unreadable or unresolved; it was not signalled", { target: instanceProjection(row) });
    const command = readProcessCommand(row.record.value.process.pid);
    if (command.kind !== "command" || commandIsCotalSupervisor(command.command)) throw new CommandFailure("refused", "UNSUPPORTED", "generic process stop cannot bypass manager agent-impact guards or an unreadable process role; use its supported service adapter. No signal was sent", { target: instanceProjection(row) });
    row = transition(row, { state: "stopping", requestId: randomUUID() });
    // The receipt names the last signal this call itself delivered to the pinned process. A process
    // that was already gone before any delivery gets no receipt: absence is not a stop.
    let delivered: "SIGTERM" | "SIGKILL" | undefined;
    // A background start leads its own process group, so the stop signals that group and waits for
    // it to empty: a descendant such as a backgrounded server goes with the process. A foreground
    // start shares the command's group and is signalled alone. A group ID is not reused while a
    // member lives, so after its leader exits the group is signalled only while members remain.
    const pid = row.record.value.process!.pid;
    let group = false;
    const members = () => (group ? processGroupMembers(pid) : []);
    const signal = (name: "SIGTERM" | "SIGKILL") => {
      const state = observeServiceProcess(row.record.value);
      if (gone(state)) {
        if (!members().length) return;
        try { process.kill(-pid, name); delivered = name; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the signal to the service's remaining process group was not confirmed; its record was retained", { target: instanceProjection(row) }); }
        return;
      }
      if (state !== "running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "service ownership became uncertain before signalling; its record was retained", { target: instanceProjection(row) });
      const role = readProcessCommand(row.record.value.process!.pid);
      if (role.kind !== "command" || commandIsCotalSupervisor(role.command)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the process role changed or became unreadable before signalling; manager impact guards were not bypassed", { target: instanceProjection(row) });
      const identity = assertRecordIdentity(row.record.value.process!);
      if (identity.kind !== "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the exact process incarnation changed before a signal; no successor was signalled", { target: instanceProjection(row) });
      group ||= processGroupOf(pid) === pid;
      try { process.kill(group ? -pid : pid, name); delivered = name; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the exact process signal was not confirmed; its record was retained", { target: instanceProjection(row) }); }
    };
    signal("SIGTERM");
    for (const [timeout, escalation] of [[PROCESS_STOP_GRACE_MS, "SIGKILL"], [3000, undefined]] as const) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const state = observeServiceProcess(row.record.value);
        if (gone(state) && !members().length) return { instance: transition(row, { state: "stopped", readiness: "not-checked", ...(delivered ? { processStop: { kind: "process-exit" as const, requestId: row.record.value.requestId, process: { ...row.record.value.process! }, signal: delivered, observedAt: new Date().toISOString() } } : {}) }), noOp: false };
        if (!gone(state) && state !== "running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the service exit could not be established; its identity and stop receipt were retained", { target: instanceProjection(row) });
        await delay(100);
      }
      if (escalation) signal(escalation);
    }
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the selected service process${members().length ? ` group, with process ${members().join(", ")},` : ""} did not confirm exit; its record was retained and no restart was attempted`, { target: instanceProjection(row) });
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
  if (initial === "members-running") return await endLeftoverJob(row, true);
  if (initial !== "running" || !value.process) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker has no current attributable process or retained exact-exit receipt; disappearance was not treated as a completed stop", { target: instanceProjection(row) });
  if (!kernel?.plan) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a broker stop requires its current exact scope and explicit confirmation; no signal was sent");
  const confirmed = serviceAdapterKernelStopPlan(kernel.plan);
  const provider = await loadServiceAdapter(declared, launch.type === "adapter" ? launch.options : {});
  hold.check();
  const target = { ...value.process };
  const fresh = serviceAdapterKernelStopPlan(await adapterCall((signal) => provider.prepareKernelStop!({ ...adapterContext(definition, value), process: target, signal }), 15000));
  if (fresh.scopeSha256 !== confirmed.scopeSha256 || serviceMetadataDigest(fresh.binding) !== serviceMetadataDigest(confirmed.binding)) throw new CommandFailure("refused", "CONFLICT", "the broker binding or dependant scope changed after confirmation; no signal was sent", { target: instanceProjection(row) });
  hold.check();
  // On Windows the custodian reports the exact program it launched, which is the broker's role.
  const role = custodiedPlatform() ? await askCustodian(row, { op: "status" }).then((held) => ({ kind: "command" as const, command: [held.program, ...held.args].join(" ") }), () => ({ kind: "unreadable" as const })) : readProcessCommand(target.pid);
  if (role.kind !== "command" || commandIsCotalSupervisor(role.command) || assertRecordIdentity(target).kind !== "match") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the broker process identity or role could not be re-established immediately before the signal; no signal was sent", { target: instanceProjection(row) });
  const requestId = randomUUID();
  row = transition(row, { state: "stopping", requestId });
  try {
    if (assertRecordIdentity(target).kind !== "match") throw new Error("identity changed");
    // Windows has no SIGTERM to deliver: the custodian terminates the broker's job.
    if (custodiedPlatform()) await askCustodian(row, { op: "terminate", code: 1 });
    else process.kill(target.pid, "SIGTERM");
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
      removeCustodyCapability(row.record.value.space, row.record.value.custody);
      return { instance: transition(row, { state: "stopped", readiness: "not-checked", kernelStop }), noOp: false, kernelStop };
    }
    // A Windows custodian outlives its emptied job by a moment before it exits.
    if (state !== "running" && state !== "members-running") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker exit could not be attributed; its stop request was retained", { target: instanceProjection(row) });
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

export function removableServiceInstances(space: string, name: string, instanceId?: string): ServiceInstanceSnapshot[] {
  const named = (row: { name: string }) => instanceId === undefined || row.name === instanceId;
  const pending = [...serviceInstallIntents(space), ...serviceUninstallIntents(space)].filter((row) => row.record.value.definition === name && named(row));
  if (pending.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service remove cannot discard a definition while an installation or removal attempt may still own a unit, private store or enable link", { target: { space, name, attempts: pending.map((row) => ({ instanceId: row.name, attemptId: row.record.value.attemptId, step: row.record.value.step, position: row.record.value.position })) }, remedy: "inspect and reconcile every retained native unit attempt before removing this definition" });
  const nativeActions = serviceUnitActionStore(space).list();
  if (nativeActions.some((row) => row.name !== row.record.value.instanceId)) throw new CommandFailure("refused", "SCHEMA_INVALID", "a native action filename differs from its full instance ID; no definition was removed");
  const actions = nativeActions.filter((row) => row.record.value.definition === name && named(row));
  if (actions.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service remove cannot discard a definition while an exact native action is retained", { target: { space, name, attempts: actions.map((row) => ({ instanceId: row.name, attemptId: row.record.value.attemptId, operation: row.record.value.operation, position: row.record.value.position })) } });
  const rows = serviceInstances(space, name).filter(named);
  if (instanceId !== undefined && !rows.length) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the full instance ID does not belong to this selected definition and space", { target: { space, name, instanceId } });
  for (const row of rows) refuseRecordedSupervisor(row.record.value, "remove");
  for (const row of rows) if (!gone(observeServiceProcess(row.record.value))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service remove requires every recorded owned instance stopped and its supervisor uninstalled", { target: instanceProjection(row), remedy: `use \`cotal service stop ${name} --instance ${row.name}\` before removing ${instanceId === undefined ? "its definition" : "its record"}` });
  // A settled exit is a record of evidence, not an unknown request. An unsettled one is settled by
  // the named stop, which signals nothing when the process is already gone.
  const settle = (row: ServiceInstanceSnapshot) => row.record.value.state === "stopping" || retainedStopRequest(row.record.value) ? { remedy: `inspect the original request with \`cotal service status ${name} --instance ${row.name} --space ${space}\`` }
    : UNSETTLED_RUN.includes(row.record.value.state) ? { remedy: `record the exit with \`cotal service stop ${name} --instance ${row.name} --space ${space} --yes\`, then remove it` } : {};
  for (const row of rows) if (row.record.value.nativeStopRequired && row.record.value.process && !row.record.value.nativeStop && !exitedWithoutStop(row.record.value)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service has no confirmed terminal stop; its launch and unknown request cannot be forgotten merely because the process disappeared", { target: instanceProjection(row), ...settle(row) });
  for (const row of rows) if (row.record.value.kernelStopRequired && row.record.value.process && !row.record.value.kernelStop && !exitedWithoutStop(row.record.value)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker has no recorded exact-exit stop from this controller; its launch cannot be forgotten merely because the process disappeared", { target: instanceProjection(row), ...settle(row) });
  return rows;
}

/** Forget one stopped instance record of a kept definition, under the definition writer lock and
 *  after the checks `service remove` makes for each record. Its logs stay. */
export function removeStoppedInstanceRecord(definition: ServiceDefinitionSnapshot, instanceId: string): void {
  const space = definition.record.value.space;
  const hold = serviceDefinitionStore(space).pin(definition);
  try {
    const [row] = removableServiceInstances(space, definition.name, instanceId);
    serviceInstanceStore(space).commit(row!.name, row!, undefined);
  } finally { hold.release(); }
}

/** Called under the definition writer lock, after stopped/host/supervisor checks for every row.
 *  Returns the full IDs whose records it removed. */
export function removeStoppedInstanceRecords(space: string, name: string): string[] {
  const rows = removableServiceInstances(space, name), removed: string[] = [];
  try {
    for (const row of rows) { serviceInstanceStore(space).commit(row.name, row, undefined); removeCustodyCapability(space, row.record.value.custody); removed.push(row.name); }
  } catch (error) {
    if (!removed.length) throw error;
    throw new CommandFailure("partial", "OPERATION_PARTIAL", "some stopped instance records were removed, but the definition was kept after another record changed", { target: { space, name }, changed: removed.map((instanceId) => ({ kind: "stopped-instance-record", instanceId })), remedy: "inspect the remaining records before another removal; no process was signalled and logs were retained" });
  }
  return removed;
}

/** The most a finite tail reads back from the end of a log, the size at which a start rotates it. */
const LOG_TAIL_BYTES = LOG_ROTATE_BYTES;

/** Read only bounded regular-file bytes; log data is not promised to be secret-redacted. */
export function readServiceLog(space: string, id: string, tail: number) {
  const path = serviceLogPath(space, id);
  if (!path) return { lines: [] as string[], omittedBytes: 0, path: null };
  return readOwnedLogTail(path, tail);
}

/** The refusal for a log this account cannot open, with the step that gives its owner read and write back. */
function unreadableLog(path: string, code: string) {
  return new CommandFailure("refused", "PERMISSION_DENIED", `the log ${path} cannot be read by this account (${code}); nothing was read or changed`, { target: { path }, remedy: `make it readable by you, for example with chmod u+rw ${shellPath(path)}` });
}

/** The last `tail` lines of an owned private log file, from at most its last 1 MiB. A log this
 *  account cannot read is refused with the step that gives its owner read and write back. */
export function readOwnedLogTail(path: string, tail: number) {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { lines: [] as string[], omittedBytes: 0, path };
    if (code === "EACCES" || code === "EPERM") throw unreadableLog(path, code);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (![info.size, info.dev, info.ino].every((number) => Number.isSafeInteger(number) && number >= 0)) throw new CommandFailure("refused", "UNSUPPORTED", "this log's native file coordinates cannot be represented safely; no approximate byte offsets were reported");
    if (!privateLog(info)) throw new CommandFailure("refused", "PERMISSION_DENIED", "the service log is not an owned private regular file");
    // Read back 1 MiB at a time until the bytes hold `tail` whole lines, the file's start or the bound.
    const limit = Math.min(info.size, LOG_TAIL_BYTES), chunks: Buffer[] = [];
    let start = info.size, newlines = 0;
    while (info.size - start < limit && (start === info.size || newlines < tail)) {
      const length = Math.min(1024 * 1024, limit - (info.size - start)), chunk = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) { const count = readSync(fd, chunk, offset, length - offset, start - length + offset); if (!count) break; offset += count; }
      if (offset < length) break;
      chunks.unshift(chunk);
      start -= length;
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) newlines++;
      if (start + length === info.size && chunk[length - 1] === 10) newlines--;
    }
    let text = Buffer.concat(chunks).toString("utf8");
    if (start) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    const all = text.replace(/\n$/, "").split("\n");
    return { lines: text ? all.slice(-tail) : [], omittedBytes: start, path };
  } finally { closeSync(fd); }
}

/** The last line an owned private log holds past byte `from`, as one bounded line of operator output,
 *  or undefined when nothing was logged there or the log cannot be read as an owned file. */
function lastLoggedLine(path: string, from: number): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const info = fstatSync(fd);
    if (!privateLog(info) || info.size <= from) return undefined;
    const length = Math.min(info.size - from, 8192), bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const count = readSync(fd, bytes, read, length - read, info.size - length + read); if (!count) break; read += count; }
    const line = bytes.subarray(0, read).toString("utf8").split("\n").map((text) => text.trim()).filter(Boolean).pop();
    return line ? oneLine(boundedValue(line, 400)) : undefined;
  } catch { return undefined; } finally { closeSync(fd); }
}

/** {@link ownedLogSlice} of a service instance's log, or undefined when no instance store exists. */
export function serviceLogSlice(space: string, id: string, position: { offset: number; dev: number; ino: number } | undefined, tail: number) {
  const path = serviceLogPath(space, id);
  return path ? ownedLogSlice(path, position, tail) : undefined;
}

/** One bounded raw slice of an owned private log file. File identity and byte offsets are local file
 *  facts, not global sequences. A log this account cannot read is refused as `readOwnedLogTail`
 *  refuses it. */
export function ownedLogSlice(path: string, position: { offset: number; dev: number; ino: number } | undefined, tail: number) {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") throw unreadableLog(path, code);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (![info.size, info.dev, info.ino].every((number) => Number.isSafeInteger(number) && number >= 0)) throw new CommandFailure("refused", "UNSUPPORTED", "this log's native file coordinates cannot be represented safely; no approximate byte offsets were reported");
    if (!privateLog(info)) throw new CommandFailure("refused", "PERMISSION_DENIED", "the selected service log is not an owned private regular file");
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
