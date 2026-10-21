import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { assertRecordIdentity, CommandFailure, homeCotalDir, identityRecord, localRecordAccess, oneLine, protectedLocalDirectory, serviceAdapterKernelStopResult, serviceAdapterReadiness, serviceAdapterStopResult, type ServiceAdapterKernelStopResult, type ServiceAdapterStopResult, serviceOperationId, spaceFromSegment, type ServiceAdapterReadiness, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { serviceSupervisorProjection } from "./service-supervision.js";
import type { ServiceAdapterPin } from "./service-adapters.js";
import { localRecordObject, localRecordText, ProtectedRecordStore, type LocalRecordSnapshot } from "./protected-records.js";

export interface ServiceHost { machine: string; boot: string; name: string; uid: number }
export interface ServiceInstance {
  schemaVersion: 1;
  instanceId: string;
  definition: string;
  definitionRevision: string;
  space: string;
  host: ServiceHost;
  requestId: string;
  launchRequestId: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed" | "unknown";
  launcher: ProcessIdentityRecord;
  process?: ProcessIdentityRecord;
  readiness: "not-checked" | "process-running" | "http-reachable" | "adapter-process-running" | "endpoint-serving" | "broker-listener-reported";
  adapter?: ServiceAdapterPin;
  adapterReadiness?: Extract<ServiceAdapterReadiness, { state: "ready" }>;
  supervisorInvocationId?: string;
  nativeStopRequired?: true;
  nativeStop?: ServiceAdapterStopResult;
  /** The instance can be stopped only by its exact kernel-exit policy, never a generic signal path. */
  kernelStopRequired?: true;
  kernelStop?: ServiceAdapterKernelStopResult;
  /** The generic exact-PID stop's own receipt: this request signalled the pinned process and observed
   *  that exact process exit. Never written for an instance that was already gone. */
  processStop?: ServiceProcessStopReceipt;
  /** The maintenance attempt a controller resume launched this incarnation for. Never the
   *  attempt's handoff path or digest. */
  attempt?: { attemptId: string };
  supervisor: "none";
  foreground: boolean;
  createdAt: string;
  updatedAt: string;
  exit?: { code: number | null; signal: string | null };
}
export type ServiceInstanceSnapshot = LocalRecordSnapshot<ServiceInstance>;
export interface ServiceProcessStopReceipt { kind: "process-exit"; requestId: string; process: ProcessIdentityRecord; signal: "SIGTERM" | "SIGKILL"; observedAt: string }

/** Closed reader for the generic stop receipt. */
export function serviceProcessStopReceipt(input: unknown): ServiceProcessStopReceipt {
  const value = localRecordObject(input, ["kind", "requestId", "process", "signal", "observedAt"]);
  if (Object.keys(value).length !== 5 || value.kind !== "process-exit" || !["SIGTERM", "SIGKILL"].includes(String(value.signal))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the process stop receipt has an unsupported shape");
  let requestId: string;
  try { requestId = serviceInstanceId(localRecordText(value.requestId, 64)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the process stop receipt request ID is invalid"); }
  const observedAt = localRecordText(value.observedAt, 100);
  if (!Number.isFinite(Date.parse(observedAt))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the process stop receipt time is invalid");
  return { kind: "process-exit", requestId, process: identity(value.process), signal: value.signal as ServiceProcessStopReceipt["signal"], observedAt };
}
const states = ["starting", "running", "stopping", "stopped", "failed", "unknown"];
let host: ServiceHost | undefined;

export function serviceInstanceId(value: string): string {
  try { return serviceOperationId(value); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "--instance needs the full assigned service UUID, not a prefix or ordinal"); }
}

/** This driver refuses without an OS machine/boot identity; no PID-only ownership substitute. */
export function processServiceHost(): ServiceHost {
  if (host) return host;
  if (process.platform !== "linux" || process.getuid === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this process-service driver currently requires Linux machine/boot identity; another platform is not silently treated as Linux");
  let machine: string, boot: string;
  try {
    machine = readFileSync("/etc/machine-id", "utf8").trim();
    boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[0-9a-f]{32}$/i.test(machine) || !/^[0-9a-f-]{36}$/i.test(boot)) throw new Error();
  } catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the host's stable machine/boot identity could not be established; no process-service effect was attempted"); }
  return host = { machine: createHash("sha256").update(machine.toLowerCase()).digest("hex"), boot, name: hostname(), uid: process.getuid() };
}

export function requireProcessIdentity(pid: number): ProcessIdentityRecord {
  const identity = identityRecord(pid);
  if (!("token" in identity)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the process creation identity could not be pinned; PID-only service ownership is unsupported");
  return identity;
}

function identity(input: unknown): ProcessIdentityRecord {
  const value = localRecordObject(input, ["pid", "token"]);
  if (!Number.isInteger(value.pid) || Number(value.pid) <= 0 || Number(value.pid) > 2_147_483_647 || typeof value.token !== "string" || !/^[0-9]+$/.test(value.token)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the service instance has an invalid pinned Linux process identity; it was not adopted");
  return { pid: Number(value.pid), token: value.token };
}

function validateInstance(input: unknown, space: string): ServiceInstance {
  const value = localRecordObject(input, ["schemaVersion", "instanceId", "definition", "definitionRevision", "space", "host", "requestId", "launchRequestId", "state", "launcher", "process", "readiness", "adapter", "adapterReadiness", "nativeStopRequired", "nativeStop", "kernelStopRequired", "kernelStop", "processStop", "attempt", "supervisorInvocationId", "supervisor", "foreground", "createdAt", "updatedAt", "exit"]);
  if (value.schemaVersion !== 1 || value.space !== space || typeof value.state !== "string" || !states.includes(value.state) || value.supervisor !== "none" || typeof value.foreground !== "boolean" || !["not-checked", "process-running", "http-reachable", "adapter-process-running", "endpoint-serving", "broker-listener-reported"].includes(String(value.readiness))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the saved service instance has an unsupported shape; no empty or stopped state was inferred");
  let id: string;
  try { id = serviceInstanceId(localRecordText(value.instanceId, 64)); serviceInstanceId(localRecordText(value.requestId, 64)); serviceInstanceId(localRecordText(value.launchRequestId, 64)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "a stored service instance or request ID is invalid; it was not interpreted as a caller selector"); }
  const definition = localRecordText(value.definition, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(definition)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance's definition name is invalid");
  const machine = localRecordObject(value.host, ["machine", "boot", "name", "uid"]);
  if (typeof machine.machine !== "string" || !/^[0-9a-f]{64}$/.test(machine.machine) || typeof machine.boot !== "string" || !/^[0-9a-f-]{36}$/i.test(machine.boot) || typeof machine.name !== "string" || !Number.isInteger(machine.uid) || Number(machine.uid) < 0) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance's execution-host identity is invalid");
  let adapter: ServiceAdapterPin | undefined;
  if (value.adapter !== undefined) {
    const pin = localRecordObject(value.adapter, ["name", "package", "version", "declarationSha256"]);
    if (typeof pin.name !== "string" || !pin.name || pin.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(pin.name) || !(pin.package === null || typeof pin.package === "string" && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pin.package)) || typeof pin.version !== "string" || !pin.version || pin.version.length > 200 || typeof pin.declarationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.declarationSha256)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance's recorded adapter provenance is invalid");
    adapter = pin as unknown as ServiceAdapterPin;
  }
  let adapterReadiness: ServiceInstance["adapterReadiness"];
  if (value.adapterReadiness !== undefined) {
    const evidence = serviceAdapterReadiness(value.adapterReadiness);
    const process = value.process === undefined ? undefined : identity(value.process);
    if (!adapter || evidence.state !== "ready" || !process || evidence.process.pid !== process.pid || evidence.process.token !== process.token || !["adapter-process-running", "endpoint-serving", "broker-listener-reported"].includes(String(value.readiness)) || (value.readiness === "endpoint-serving") !== (evidence.native !== undefined) || (value.readiness === "broker-listener-reported") !== (evidence.listener !== undefined)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the adapter readiness does not belong to this pinned service process");
    adapterReadiness = evidence;
  } else if (["adapter-process-running", "endpoint-serving", "broker-listener-reported"].includes(String(value.readiness))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the saved adapter readiness has no attributed evidence");
  if (value.nativeStopRequired !== undefined && value.nativeStopRequired !== true) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained native stop policy marker is invalid; a process policy was not inferred");
  if (value.supervisorInvocationId !== undefined && (typeof value.supervisorInvocationId !== "string" || !/^[0-9a-f]{32}$/.test(value.supervisorInvocationId))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the recorded native unit invocation is invalid");
  const nativeStop = value.nativeStop === undefined ? undefined : serviceAdapterStopResult(value.nativeStop);
  if (nativeStop && (value.nativeStopRequired !== true || nativeStop.process.pid !== (value.process as ProcessIdentityRecord | undefined)?.pid || nativeStop.process.token !== (value.process as ProcessIdentityRecord | undefined)?.token || nativeStop.requestId !== value.requestId || value.state !== "stopped")) throw new CommandFailure("refused", "SCHEMA_INVALID", "the native stop receipt does not match this retained instance and request");
  if (value.kernelStopRequired !== undefined && value.kernelStopRequired !== true || value.kernelStopRequired === true && value.nativeStopRequired === true) throw new CommandFailure("refused", "SCHEMA_INVALID", "the retained kernel-exit stop policy marker is invalid or combined with a native policy");
  const kernelStop = value.kernelStop === undefined ? undefined : serviceAdapterKernelStopResult(value.kernelStop);
  if (kernelStop && (value.kernelStopRequired !== true || kernelStop.process.pid !== (value.process as ProcessIdentityRecord | undefined)?.pid || kernelStop.process.token !== (value.process as ProcessIdentityRecord | undefined)?.token || kernelStop.requestId !== value.requestId || value.state !== "stopped")) throw new CommandFailure("refused", "SCHEMA_INVALID", "the kernel-exit stop receipt does not match this retained instance and request");
  const processStop = value.processStop === undefined ? undefined : serviceProcessStopReceipt(value.processStop);
  let attempt: { attemptId: string } | undefined;
  if (value.attempt !== undefined) {
    const row = localRecordObject(value.attempt, ["attemptId"]);
    if (Object.keys(row).length !== 1 || typeof row.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.attemptId)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance maintenance attempt binding is invalid");
    attempt = { attemptId: row.attemptId };
  }
  if (processStop && (value.nativeStopRequired === true || value.kernelStopRequired === true || nativeStop || kernelStop || processStop.process.pid !== (value.process as ProcessIdentityRecord | undefined)?.pid || processStop.process.token !== (value.process as ProcessIdentityRecord | undefined)?.token || processStop.requestId !== value.requestId || value.state !== "stopped")) throw new CommandFailure("refused", "SCHEMA_INVALID", "the process stop receipt does not match this retained instance and request");
  const createdAt = localRecordText(value.createdAt, 100), updatedAt = localRecordText(value.updatedAt, 100);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance timestamps are invalid");
  if (value.exit !== undefined) {
    const exit = localRecordObject(value.exit, ["code", "signal"]);
    if (!(exit.code === null || Number.isInteger(exit.code)) || !(exit.signal === null || typeof exit.signal === "string")) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance exit observation is invalid");
  }
  return { schemaVersion: 1, instanceId: id, definition, definitionRevision: localRecordText(value.definitionRevision, 200), space, host: machine as unknown as ServiceHost, requestId: serviceInstanceId(localRecordText(value.requestId, 64)), launchRequestId: serviceInstanceId(localRecordText(value.launchRequestId, 64)), state: value.state as ServiceInstance["state"], launcher: identity(value.launcher), ...(value.process === undefined ? {} : { process: identity(value.process) }), readiness: value.readiness as ServiceInstance["readiness"], ...(adapter === undefined ? {} : { adapter }), ...(adapterReadiness === undefined ? {} : { adapterReadiness }), ...(typeof value.supervisorInvocationId === "string" ? { supervisorInvocationId: value.supervisorInvocationId } : {}), ...(value.nativeStopRequired ? { nativeStopRequired: true } : {}), ...(nativeStop ? { nativeStop } : {}), ...(value.kernelStopRequired ? { kernelStopRequired: true } : {}), ...(kernelStop ? { kernelStop } : {}), ...(processStop ? { processStop } : {}), ...(attempt ? { attempt } : {}), supervisor: "none", foreground: value.foreground, createdAt, updatedAt, ...(value.exit === undefined ? {} : { exit: value.exit as ServiceInstance["exit"] }) };
}

export const serviceInstanceStore = (space: string) => new ProtectedRecordStore("services", space, (value) => validateInstance(value, space), "instances");

export function serviceInstances(space: string, definition?: string): ServiceInstanceSnapshot[] {
  const rows = serviceInstanceStore(space).list();
  for (const row of rows) if (row.name !== row.record.value.instanceId) throw new CommandFailure("refused", "SCHEMA_INVALID", "the instance filename and full assigned ID disagree; the record was not adopted");
  return rows.filter((row) => definition === undefined || row.record.value.definition === definition);
}

export type ServiceProcessState = "running" | "gone" | "previous-boot" | "foreign-host" | "foreign-pid" | "unreadable" | "unresolved-launch";
export function observeServiceProcess(value: ServiceInstance): ServiceProcessState {
  const current = processServiceHost();
  if (current.machine !== value.host.machine || current.uid !== value.host.uid) return "foreign-host";
  if (current.boot !== value.host.boot) return "previous-boot";
  if (!value.process) return value.state === "failed" || value.state === "stopped" ? "gone" : "unresolved-launch";
  const observed = assertRecordIdentity(value.process);
  return observed.kind === "match" ? "running" : observed.kind === "gone" ? "gone" : observed.kind === "mismatch" ? "foreign-pid" : "unreadable";
}

export function instanceProjection(row: ServiceInstanceSnapshot) {
  const value = row.record.value;
  const supervisorRecord = serviceSupervisorProjection(value, processServiceHost());
  return { instanceId: value.instanceId, definition: value.definition, definitionRevision: value.definitionRevision, revision: row.record.revision, space: value.space, executionHost: value.host.name, observedProcess: observeServiceProcess(value), recordedState: value.state, pid: value.process?.pid ?? null, readinessObservation: value.readiness, readinessAsOf: value.updatedAt, servingResponse: value.adapterReadiness?.native ? value.adapterReadiness.evidence === "local-process-receipt" ? "child-local-receipt-as-of" : "adapter-checked-as-of" : "not-checked", nativeEvidence: value.adapterReadiness?.evidence ?? null, adapter: value.adapter ?? null, nativeEndpoint: value.adapterReadiness?.native ?? null, reportedListener: value.adapterReadiness?.listener ?? null, adapterObservedAt: value.adapterReadiness?.observedAt ?? null, nativeStop: value.nativeStop ?? null, kernelStop: value.kernelStop ?? null, processStop: value.processStop ?? null, stopPolicy: value.nativeStopRequired ? "native" as const : value.kernelStopRequired ? "kernel-exit" as const : "process" as const, supervisor: supervisorRecord.mechanism === "none-recorded" ? value.supervisor : supervisorRecord.mechanism, supervisorRecord, supervisorInvocationId: value.supervisorInvocationId ?? null, supervisorObservation: "not-checked" as const, requestId: value.requestId, launchRequestId: value.launchRequestId, foreground: value.foreground, exit: value.exit ?? null };
}

/** Called only while ext remove holds the extension writer lock. Enumerate the case-safe service
 *  store itself, including spaces no longer present in the mesh-selection registry. No provider
 *  is imported and an unreadable/foreign/unresolved instance never counts as stopped. */
export function assertExtensionServiceInstancesStopped(pkg: string): void {
  const root = join(homeCotalDir(), "services");
  let directory;
  try { directory = lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  protectedLocalDirectory(root);
  // Owner and mode are POSIX checks; the Windows record model has neither.
  if (!directory.isDirectory() || directory.isSymbolicLink() || (localRecordAccess() === "posix" && (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0))) throw new CommandFailure("refused", "PERMISSION_DENIED", "the service instance namespace is not an owned private directory; extension removal did not assume an empty inventory");
  const blockers: { space: string; definition: string; instanceId: string; process: ServiceProcessState }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const space = spaceFromSegment(`space.${entry.name}`);
    if (space === undefined) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CommandFailure("refused", "SCHEMA_INVALID", "a service space namespace is not a physical directory; extension removal did not skip its possible instances");
    for (const row of serviceInstances(space)) {
      if (row.record.value.adapter?.package !== pkg) continue;
      const process = observeServiceProcess(row.record.value);
      if (!["gone", "previous-boot", "foreign-pid"].includes(process)) blockers.push({ space, definition: row.record.value.definition, instanceId: row.name, process });
    }
  }
  if (blockers.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the extension still has live, foreign or unresolved service instances; stop or reconcile each full instance before removal", { target: { package: pkg, instances: blockers }, remedy: `use service status/logs and the exact owned service stop route for ${blockers.map((row) => `${oneLine(row.definition)} in space ${oneLine(row.space)}, instance ${row.instanceId} (${row.process})`).join("; ")}; unresolved launch intents are not absence` });
}
