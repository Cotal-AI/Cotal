import { isAbsolute, join } from "node:path";
import { assertLifecycleToken, contractDigest, endpointToken, singleDocumentClosure, token, writeSecretFileCreateOnly, type EpCaller } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
import { CommandFailure } from "./output.js";
import { identityRecord, type ProcessIdentityRecord } from "./pid.js";
import { decodeLocalJson, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { serviceOperationId, type ServiceAdapterContext } from "./service-adapter.js";

type IdentityContext = Pick<ServiceAdapterContext, "space" | "instanceId" | "launchRequestId" | "stateDirectory">;
export interface NativeServiceIdentity {
  endpoint: string;
  instanceId: string;
  principal: EpCaller;
}
export interface ServiceIdentityBinding {
  schemaVersion: 1;
  space: string;
  instanceId: string;
  launchRequestId: string;
  process: ProcessIdentityRecord;
  native: NativeServiceIdentity;
  observedAt: string;
}
const invalid = (): never => { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private native service identity does not belong to this full owned launch; no other instance or caller was inferred"); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));

export function serviceIdentityPath(context: IdentityContext): string {
  if (!isAbsolute(context.stateDirectory) || context.stateDirectory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(context.stateDirectory) || !context.space || context.space.length > 200 || token(context.space) !== context.space) return invalid();
  protectedLocalDirectory(context.stateDirectory);
  return join(context.stateDirectory, `.${spaceKey(serviceOperationId(context.instanceId))}.${spaceKey(serviceOperationId(context.launchRequestId))}.identity.json`);
}
function nativeIdentity(input: unknown): NativeServiceIdentity {
  if (!object(input) || Object.keys(input).length !== 3 || Object.keys(input).some((key) => !["endpoint", "instanceId", "principal"].includes(key)) || typeof input.endpoint !== "string" || input.endpoint.length > 200 || typeof input.instanceId !== "string") return invalid();
  const principal = input.principal;
  if (!object(principal) || Object.keys(principal).length !== 3 || !["owner", "actor", "uid"].every((key) => typeof principal[key] === "string" && principal[key].length > 0 && principal[key].length <= 200 && token(principal[key]) === principal[key])) return invalid();
  try { endpointToken(input.endpoint); assertLifecycleToken(input.instanceId); assertLifecycleToken(String(principal.uid)); }
  catch { return invalid(); }
  return { endpoint: input.endpoint, instanceId: input.instanceId, principal: { owner: String(principal.owner), actor: String(principal.actor), uid: String(principal.uid) } };
}

/** Publish from the real native child before its endpoint is constructed. This is an immutable
 *  same-UID launch binding, not readiness, an authenticated response or an exported caller grant. */
export function publishServiceIdentity(context: IdentityContext, native: NativeServiceIdentity): void {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "the native process binding requires the supported Linux service driver; no PID-only identity was substituted");
  const self = identityRecord(process.pid);
  if (!("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "the native service has no process creation identity for its launch binding");
  const value: ServiceIdentityBinding = { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: self, native: nativeIdentity(native), observedAt: new Date().toISOString() };
  writeSecretFileCreateOnly(serviceIdentityPath(context), JSON.stringify(value) + "\n");
}

/** The adapter must still make an attributed current query and compare this native incarnation.
 *  Do not turn a selected identity, a file's existence or a recycled PID into serving evidence. */
export function readServiceIdentity(context: IdentityContext, expected: ProcessIdentityRecord): ServiceIdentityBinding | undefined {
  const bytes = readLocalRecordSource(serviceIdentityPath(context), 8192, true);
  if (bytes === undefined) return undefined;
  const value = decodeLocalJson(bytes);
  if (!object(value) || Object.keys(value).length !== 7 || Object.keys(value).some((key) => !["schemaVersion", "space", "instanceId", "launchRequestId", "process", "native", "observedAt"].includes(key)) || value.schemaVersion !== 1 || value.space !== context.space || value.instanceId !== context.instanceId || value.launchRequestId !== context.launchRequestId || typeof value.observedAt !== "string" || value.observedAt.length > 100 || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > Date.now() + 1000) return invalid();
  const process = value.process;
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0 || expected.pid > 2_147_483_647 || typeof expected.token !== "string" || expected.token.length > 128 || !/^[0-9]+$/.test(expected.token) || !object(process) || Object.keys(process).length !== 2 || process.pid !== expected.pid || process.token !== expected.token) return invalid();
  return { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: { pid: expected.pid, token: expected.token }, native: nativeIdentity(value.native), observedAt: value.observedAt };
}

/** The cluster document one native child registered, beside its launch identity. Same-UID launch
 *  evidence of what this incarnation serves; it is verified against the contract store before use. */
export interface ServedContract {
  schemaVersion: 1;
  space: string;
  instanceId: string;
  launchRequestId: string;
  process: ProcessIdentityRecord;
  endpoint: string;
  clusterDigest: string;
  document: unknown;
  observedAt: string;
}

export function servedContractPath(context: IdentityContext): string {
  return serviceIdentityPath(context).replace(/\.identity\.json$/u, ".served-contract.json");
}

/** Write once, from the same cluster artifacts the child published and registered, before its
 *  serving startup receipt. A serving revision-33 child therefore always has this file. */
export function publishServedContract(context: IdentityContext, value: { endpoint: string; clusterDigest: string; document: unknown }): void {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "the served-contract binding requires the supported Linux service driver");
  const self = identityRecord(process.pid);
  if (!("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "the native service has no process creation identity for its served-contract binding");
  try { endpointToken(value.endpoint); } catch { return invalid(); }
  if (singleDocumentClosure(value.document).closureDigest !== value.clusterDigest) return invalid();
  const record: ServedContract = { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: self, endpoint: value.endpoint, clusterDigest: value.clusterDigest, document: value.document, observedAt: new Date().toISOString() };
  writeSecretFileCreateOnly(servedContractPath(context), JSON.stringify(record) + "\n");
}

/** Read only by the preserved-exit capability proof. Absent means the child predates the file.
 *  The document must hash to the closure the record names, so the file cannot carry another one. */
export function readServedContract(context: IdentityContext, expected: ProcessIdentityRecord): ServedContract | undefined {
  const bytes = readLocalRecordSource(servedContractPath(context), 256 * 1024, true);
  if (bytes === undefined) return undefined;
  const value = decodeLocalJson(bytes);
  const keys = ["schemaVersion", "space", "instanceId", "launchRequestId", "process", "endpoint", "clusterDigest", "document", "observedAt"];
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || value.schemaVersion !== 1 || value.space !== context.space || value.instanceId !== context.instanceId || value.launchRequestId !== context.launchRequestId || typeof value.endpoint !== "string" || typeof value.clusterDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.clusterDigest) || typeof value.observedAt !== "string" || value.observedAt.length > 100 || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > Date.now() + 1000 || !object(value.document)) return invalid();
  const pinned = value.process;
  if (!object(pinned) || Object.keys(pinned).length !== 2 || pinned.pid !== expected.pid || pinned.token !== expected.token) return invalid();
  try { endpointToken(value.endpoint); } catch { return invalid(); }
  const closure = singleDocumentClosure(value.document);
  if (closure.manifest.root !== contractDigest(value.document) || closure.closureDigest !== value.clusterDigest) return invalid();
  return { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: { pid: expected.pid, token: expected.token }, endpoint: value.endpoint, clusterDigest: value.clusterDigest, document: value.document, observedAt: value.observedAt };
}
