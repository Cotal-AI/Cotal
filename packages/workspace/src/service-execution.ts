import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { token, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
import { executionIdentity, type ExecutionIdentity } from "./execution-identity.js";
import { CommandFailure } from "./output.js";
import { identityRecord, type ProcessIdentityRecord } from "./pid.js";
import { decodeLocalJson, localRecordObject, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { serviceOperationId, type ServiceAdapterContext } from "./service-adapter.js";

type Context = Pick<ServiceAdapterContext, "space" | "instanceId" | "launchRequestId" | "stateDirectory">;
export interface ServiceExecutionBinding {
  schemaVersion: 1;
  space: string;
  instanceId: string;
  launchRequestId: string;
  process: ProcessIdentityRecord;
  execution: ExecutionIdentity;
  node: { path: string; version: string; dev: string; ino: string; bytes: number; mtimeNs: string; ctimeNs: string };
  /** Null names a canonical install without a native retained-generation inventory. */
  generationInventory: { path: string; bytes: number; sha256: string } | null;
  observedAt: string;
}
const invalid = (): never => { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private execution receipt does not bind this full native launch; no current package or runtime was substituted"); };
const pathValue = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^\d+$/.test(value);
const stamp = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^-?\d+$/.test(value);
const closed = (value: unknown, keys: string[]) => { const record = localRecordObject(value, keys); if (Object.keys(record).length !== keys.length) return invalid(); return record; };
const inventoryPath = (entry: string) => join(dirname(dirname(dirname(entry))), "inventory.json");

export function serviceExecutionPath(context: Context): string {
  if (!pathValue(context.stateDirectory) || !context.space || context.space.length > 200 || token(context.space) !== context.space) return invalid();
  protectedLocalDirectory(context.stateDirectory);
  return join(context.stateDirectory, `.${spaceKey(serviceOperationId(context.instanceId))}.${spaceKey(serviceOperationId(context.launchRequestId))}.execution.json`);
}

/** Publish from the built native child on Linux, alongside its unchanged startup/identity receipt.
 * This same-UID observation is not remote authority, a complete software snapshot or activation. */
export function publishServiceExecution(context: Context): void {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "native execution receipts require Linux");
  const execution = executionIdentity(), self = identityRecord(process.pid);
  if (!execution || !("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "native execution custody needs the built bootstrap identity and process creation identity");
  const path = realpathSync.native(process.execPath), source = lstatSync(path, { bigint: true }), kernel = statSync("/proc/self/exe", { bigint: true });
  if (!source.isFile() || source.size < 1n || source.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      (["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(key => source[key] !== kernel[key])) return invalid();
  let generationInventory: ServiceExecutionBinding["generationInventory"] = null;
  if (execution.loadedEntry !== execution.logicalEntry) {
    const path = inventoryPath(execution.loadedEntry), bytes = readLocalRecordSource(path, 16 * 1024 * 1024);
    if (!bytes?.length) return invalid();
    generationInventory = { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const record: ServiceExecutionBinding = {
    schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: self,
    execution, node: { path, version: process.version, dev: String(source.dev), ino: String(source.ino), bytes: Number(source.size), mtimeNs: String(source.mtimeNs), ctimeNs: String(source.ctimeNs) },
    generationInventory, observedAt: new Date().toISOString(),
  };
  writeSecretFileCreateOnly(serviceExecutionPath(context), JSON.stringify(record) + "\n");
}

/** Bind stored observations to the original instance and process without resolving old source paths.
 * Absent means unsupported original-software custody, not permission to use the coordinator's code.
 * The capturer still verifies actual Node bytes and the native generation inventory/complete package. */
export function readServiceExecution(context: Context, expected: ProcessIdentityRecord): ServiceExecutionBinding | undefined {
  const bytes = readLocalRecordSource(serviceExecutionPath(context), 32 * 1024, true);
  if (bytes === undefined) return undefined;
  const row = closed(decodeLocalJson(bytes), ["schemaVersion", "space", "instanceId", "launchRequestId", "process", "execution", "node", "generationInventory", "observedAt"]);
  const process = closed(row.process, ["pid", "token"]);
  if (row.schemaVersion !== 1 || row.space !== context.space || row.instanceId !== context.instanceId || row.launchRequestId !== context.launchRequestId ||
      !Number.isSafeInteger(expected.pid) || expected.pid <= 0 || !decimal(expected.token) || process.pid !== expected.pid || process.token !== expected.token ||
      typeof row.observedAt !== "string" || row.observedAt.length > 100 || !Number.isFinite(Date.parse(row.observedAt)) || Date.parse(row.observedAt) > Date.now() + 1000) return invalid();
  const execution = localRecordObject(row.execution, ["logicalEntry", "loadedEntry", "launchEntry"]);
  if (Object.keys(execution).length !== (execution.launchEntry === undefined ? 2 : 3) || !pathValue(execution.logicalEntry) || !pathValue(execution.loadedEntry) ||
      execution.launchEntry !== undefined && !pathValue(execution.launchEntry)) return invalid();
  const node = closed(row.node, ["path", "version", "dev", "ino", "bytes", "mtimeNs", "ctimeNs"]);
  if (!pathValue(node.path) || typeof node.version !== "string" || node.version.length > 100 || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(node.version) ||
      !decimal(node.dev) || !decimal(node.ino) || !Number.isSafeInteger(node.bytes) || Number(node.bytes) < 1 || !stamp(node.mtimeNs) || !stamp(node.ctimeNs)) return invalid();
  let generationInventory: ServiceExecutionBinding["generationInventory"] = null;
  if (row.generationInventory !== null) {
    const inventory = closed(row.generationInventory, ["path", "bytes", "sha256"]);
    if (execution.logicalEntry === execution.loadedEntry || inventory.path !== inventoryPath(execution.loadedEntry) ||
        !Number.isSafeInteger(inventory.bytes) || Number(inventory.bytes) < 1 || Number(inventory.bytes) > 16 * 1024 * 1024 ||
        typeof inventory.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(inventory.sha256)) return invalid();
    generationInventory = { path: String(inventory.path), bytes: Number(inventory.bytes), sha256: inventory.sha256 };
  } else if (execution.logicalEntry !== execution.loadedEntry) return invalid();
  return { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId,
    process: { pid: expected.pid, token: expected.token }, execution: { logicalEntry: execution.logicalEntry, loadedEntry: execution.loadedEntry,
      ...(execution.launchEntry === undefined ? {} : { launchEntry: execution.launchEntry as string }) },
    node: { path: node.path, version: node.version, dev: node.dev, ino: node.ino, bytes: Number(node.bytes), mtimeNs: node.mtimeNs, ctimeNs: node.ctimeNs },
    generationInventory, observedAt: row.observedAt };
}
