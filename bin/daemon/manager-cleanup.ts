import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertLifecycleToken, mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { spaceSegment, workspaceSecretStore } from "@cotal-ai/workspace";

export interface ManagerCleanupRecord {
  version: 1;
  space: string;
  provider: string;
  root: string;
  storeIdentity: { kind: "fs"; root: string; id: string };
  instanceId?: string;
  phase: "hosted" | "pending" | "unknown";
}

export function managerCleanupFile(home: string, space: string): string {
  return join(home, "daemon", spaceSegment(space), "manager-cleanup.json");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Manager cleanup record must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)))
    throw new Error("Manager cleanup record has unsupported fields");
  return result;
}

function validate(value: unknown, space: string): ManagerCleanupRecord {
  const o = object(value, ["version", "space", "provider", "root", "storeIdentity", "instanceId", "phase"]);
  spaceSegment(space);
  if (o.version !== 1 || o.space !== space || typeof o.space !== "string")
    throw new Error("Manager cleanup record has an invalid version or space");
  if (typeof o.provider !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(o.provider))
    throw new Error("Manager cleanup record has an invalid provider");
  if (typeof o.root !== "string" || !isAbsolute(o.root) || o.root.includes("\0"))
    throw new Error("Manager cleanup record requires an absolute participant root");
  const identity = object(o.storeIdentity, ["kind", "root", "id"]);
  if (identity.kind !== "fs" || identity.root !== o.root || typeof identity.id !== "string" || !UUID.test(identity.id))
    throw new Error("Manager cleanup record has an invalid store identity");
  if (o.phase !== "hosted" && o.phase !== "pending" && o.phase !== "unknown")
    throw new Error("Manager cleanup record has an invalid phase");
  if (Object.hasOwn(o, "instanceId")) {
    if (typeof o.instanceId !== "string") throw new Error("Manager cleanup record has an invalid instanceId");
    assertLifecycleToken(o.instanceId, "Manager cleanup instanceId");
  } else if (o.phase !== "hosted") {
    throw new Error("Pending or unknown Manager cleanup requires an instanceId");
  }
  return {
    version: 1, space, provider: o.provider, root: o.root,
    storeIdentity: { kind: "fs", root: o.root, id: identity.id },
    ...(typeof o.instanceId === "string" ? { instanceId: o.instanceId } : {}),
    phase: o.phase,
  };
}

function regularFile(file: string): boolean {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error(`Manager cleanup refuses nonregular file: ${file}`);
  return true;
}

export function readManagerCleanup(home: string, space: string): ManagerCleanupRecord | undefined {
  const file = managerCleanupFile(home, space);
  if (!regularFile(file)) return undefined;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Manager cleanup refuses nonregular file: ${file}`);
    return validate(JSON.parse(readFileSync(fd, "utf8")), space);
  } catch (error) {
    throw new Error(`Invalid Manager cleanup record at ${file}`, { cause: error });
  } finally {
    closeSync(fd);
  }
}

export function writeManagerCleanup(home: string, record: ManagerCleanupRecord): void {
  const saved = validate(record, record.space);
  const file = managerCleanupFile(home, saved.space);
  const previous = readManagerCleanup(home, saved.space);
  if (previous?.instanceId && previous.instanceId !== saved.instanceId)
    throw new Error(`Manager cleanup instance cannot change while ${previous.phase}: ${file}`);
  mkSecretDir(dirname(file));
  writeSecretFileAtomic(file, `${JSON.stringify(saved)}\n`);
}

export function bindManagerCleanup(home: string, space: string, instanceId: string): ManagerCleanupRecord {
  assertLifecycleToken(instanceId, "Manager cleanup instanceId");
  const record = readManagerCleanup(home, space);
  if (!record) throw new Error(`Missing Manager cleanup record: ${managerCleanupFile(home, space)}`);
  const bound = { ...record, instanceId };
  writeManagerCleanup(home, bound);
  return bound;
}

/** Check retained authority explicitly, without creating a missing store identity. */
export function validateManagerCleanupAuthority(record: ManagerCleanupRecord): void {
  const saved = validate(record, record.space);
  const file = join(saved.root, ".cotal", "store.id");
  if (!regularFile(file)) throw new Error(`Missing original Manager cleanup store identity: ${file}`);
  const identity = workspaceSecretStore(saved.root).identity;
  if (identity.kind !== saved.storeIdentity.kind || identity.root !== saved.storeIdentity.root || identity.id !== saved.storeIdentity.id)
    throw new Error(`Manager cleanup store identity changed: ${file}`);
}

export function clearManagerCleanup(home: string, space: string): void {
  const file = managerCleanupFile(home, space);
  if (regularFile(file)) unlinkSync(file);
}
