import { basename, dirname, isAbsolute, join } from "node:path";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
import { executionIdentity } from "./execution-identity.js";
import { publishServiceExecution } from "./service-execution.js";
import { identityRecord } from "./pid.js";
import { CommandFailure } from "./output.js";
import { decodeLocalJson, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { serviceOperationId, type ServiceAdapterContext, type ServiceAdapterReadiness } from "./service-adapter.js";

type StartupContext = Pick<ServiceAdapterContext, "space" | "instanceId" | "launchRequestId" | "stateDirectory">;

const name = (id: string, request: string) => `.${spaceKey(serviceOperationId(id))}.${spaceKey(serviceOperationId(request))}.ready.json`;
export const serviceStartupPath = (context: StartupContext): string => join(context.stateDirectory, name(context.instanceId, context.launchRequestId));

export function validateServiceStartupPath(path: string, id: string, request: string): void {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path) || basename(path) !== name(id, request)) throw new CommandFailure("refused", "CONFLICT", "the native service readiness path does not name its full instance and launch request");
  protectedLocalDirectory(dirname(path));
}

/** Call from the native child only after its real initialization and signal handlers exist.
 *  This receipt grants no authority and carries no bootstrap URL, token or credential. */
export function publishServiceStartup(path: string, value: { phase: string; space: string; instanceId: string; launchRequestId: string }): void {
  validateServiceStartupPath(path, value.instanceId, value.launchRequestId);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.phase)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the native startup phase is invalid");
  const processIdentity = identityRecord(process.pid);
  if (!("token" in processIdentity)) throw new CommandFailure("refused", "UNSUPPORTED", "the native service child has no creation-pinned process identity");
  if (process.platform === "linux" && executionIdentity()) publishServiceExecution({ ...value, stateDirectory: dirname(path) });
  writeSecretFileCreateOnly(path, JSON.stringify({ schemaVersion: 1, phase: value.phase, space: value.space, instanceId: value.instanceId, launchRequestId: value.launchRequestId, process: processIdentity, observedAt: new Date().toISOString() }) + "\n");
}

/** The most `cotal manager start --idle-exit` takes, in seconds: 30 days. */
export const MAX_IDLE_EXIT_SECONDS = 30 * 24 * 60 * 60;

const idleExitPath = (context: StartupContext): string => serviceStartupPath(context).replace(/\.ready\.json$/, ".idle-exit.json");

/** Call from the native child once the stop that its `--idle-exit` began has completed, so status can
 *  tell an idle exit from a crash. The receipt grants no authority. */
export function publishServiceIdleExit(context: StartupContext, idleSeconds: number): void {
  const path = idleExitPath(context);
  validateServiceStartupPath(serviceStartupPath(context), context.instanceId, context.launchRequestId);
  const processIdentity = identityRecord(process.pid);
  if (!("token" in processIdentity)) throw new CommandFailure("refused", "UNSUPPORTED", "the native service child has no creation-pinned process identity");
  writeSecretFileCreateOnly(path, JSON.stringify({ schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: processIdentity, idleSeconds, observedAt: new Date().toISOString() }) + "\n");
}

/** The idle-exit receipt this launch's pinned process left, or undefined when it left none. A receipt
 *  for another launch or process is refused, never read as this one's. */
export function readServiceIdleExit(context: StartupContext, process: { pid: number; token: string }): { idleSeconds: number; observedAt: string } | undefined {
  const bytes = readLocalRecordSource(idleExitPath(context), 8192, true);
  if (!bytes) return undefined;
  const row = decodeLocalJson(bytes) as Record<string, unknown>;
  const identity = row?.process as { pid?: unknown; token?: unknown } | undefined;
  if (!row || Object.keys(row).some((key) => !["schemaVersion", "space", "instanceId", "launchRequestId", "process", "idleSeconds", "observedAt"].includes(key)) || row.schemaVersion !== 1 || row.space !== context.space || row.instanceId !== context.instanceId || row.launchRequestId !== context.launchRequestId || !identity || identity.pid !== process.pid || identity.token !== process.token || !Number.isSafeInteger(row.idleSeconds) || Number(row.idleSeconds) < 1 || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt)))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the idle-exit receipt does not match this launch and process; no stop was inferred from it");
  return { idleSeconds: Number(row.idleSeconds), observedAt: row.observedAt };
}

/** A native startup receipt plus the controller's current process proof. This is not an HTTP
 *  health query, a native endpoint response or proof of ongoing application availability. */
export function observeServiceStartup(context: ServiceAdapterContext & { process: { pid: number; token: string }; signal: AbortSignal }, phase: string): ServiceAdapterReadiness {
  context.signal.throwIfAborted();
  const bytes = readLocalRecordSource(serviceStartupPath(context), 8192, true);
  if (!bytes) return { state: "pending" };
  const row = decodeLocalJson(bytes) as Record<string, unknown>;
  const identity = row?.process as { pid?: unknown; token?: unknown } | undefined;
  if (!row || Object.keys(row).some((key) => !["schemaVersion", "phase", "space", "instanceId", "launchRequestId", "process", "observedAt"].includes(key)) || row.schemaVersion !== 1 || row.phase !== phase || row.space !== context.space || row.instanceId !== context.instanceId || row.launchRequestId !== context.launchRequestId || !identity || identity.pid !== context.process.pid || identity.token !== context.process.token || Object.keys(identity).length !== 2 || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt)) || Date.parse(row.observedAt) > Date.now() + 1000) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the startup receipt does not match this full owned launch; no other receipt or process was adopted");
  return { state: "ready", process: { ...context.process }, observedAt: new Date().toISOString() };
}
