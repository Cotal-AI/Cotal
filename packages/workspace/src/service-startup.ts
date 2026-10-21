import { basename, dirname, isAbsolute, join } from "node:path";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
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
  writeSecretFileCreateOnly(path, JSON.stringify({ schemaVersion: 1, phase: value.phase, space: value.space, instanceId: value.instanceId, launchRequestId: value.launchRequestId, process: processIdentity, observedAt: new Date().toISOString() }) + "\n");
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
