import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertMaintenanceLock, localRecordObject, protectedLocalDirectory, protectedLocalEntry, readLocalRecordSource, type MaintenanceLock } from "@cotal-ai/workspace";
import { copyPinnedFile } from "./backup-artifact.js";

export interface MigrationNodeRecord {
  sourcePath: string;
  retainedPath: string;
  version: string;
  bytes: number;
  sha256: string;
}
const same = (a: BigIntStats, b: BigIntStats) => (["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"] as const).every(key => a[key] === b[key]);
function directory(path: string): void {
  if (process.platform !== "linux") throw new Error(`migration Node custody is unsupported on ${process.platform}; Linux is required`);
  protectedLocalDirectory(path, "the execution generation directory");
  if (resolve(path) !== path || realpathSync.native(path) !== path || lstatSync(path).uid !== process.getuid!())
    throw new Error("migration Node custody requires its canonical owned generation directory");
}
function nodeFile(path: string, privateCopy = false): BigIntStats {
  protectedLocalEntry(path, "the migration Node executable");
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER) || (stat.mode & 0o6000n) !== 0n ||
      privateCopy && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n))
    throw new Error("migration Node custody requires a regular single-link executable, with an owned private copy");
  return stat;
}
function version(path: string): string {
  const result = spawnSync(path, ["--version"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 3_000 });
  if (result.status !== 0 || result.error || !/^v\d+\.\d+\.\d+\n$/.test(result.stdout)) throw new Error("the retained executable did not report a stable Node version");
  return result.stdout.trim();
}
function sync(path: string, isDirectory = false): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Retain this process's Node beside a native execution generation. The composition root holds
 * the installation lock as well as this maintenance lock and binds the returned record before
 * releasing either. Failed copies stay as unreferenced orphans; no existing copy is overwritten. */
export function captureMigrationNode(lock: MaintenanceLock, generationDirectory: string): MigrationNodeRecord {
  assertMaintenanceLock(lock); directory(generationDirectory);
  const sourcePath = realpathSync.native(process.execPath), before = nodeFile(sourcePath);
  const running = statSync("/proc/self/exe", { bigint: true });
  if (before.dev !== running.dev || before.ino !== running.ino) throw new Error("the source path no longer names this running Node executable");
  const bytes = readLocalRecordSource(sourcePath, Number(before.size));
  if (!bytes || bytes.length !== Number(before.size) || !same(before, nodeFile(sourcePath)) || version(sourcePath) !== process.version)
    throw new Error("the source Node executable changed during capture");
  const record: MigrationNodeRecord = { sourcePath, retainedPath: join(generationDirectory, "node"), version: process.version,
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  copyPinnedFile(sourcePath, record.retainedPath, { path: "node", size: record.bytes, sha256: record.sha256 });
  chmodSync(record.retainedPath, 0o700); sync(record.retainedPath); sync(generationDirectory);
  if (!same(before, nodeFile(sourcePath))) throw new Error("the source Node executable changed before its receipt was bound");
  verifyMigrationNode(lock, generationDirectory, record);
  return record;
}

/** Verify the retained copy without reading or resolving its original source. This proves the
 * Node file only; generation verification and journal closure belong to the composition root. */
export function verifyMigrationNode(lock: MaintenanceLock, generationDirectory: string, record: MigrationNodeRecord): void {
  assertMaintenanceLock(lock); directory(generationDirectory);
  localRecordObject(record, ["sourcePath", "retainedPath", "version", "bytes", "sha256"]);
  if (Object.keys(record).length !== 5 || typeof record.sourcePath !== "string" || !isAbsolute(record.sourcePath) || resolve(record.sourcePath) !== record.sourcePath ||
      record.retainedPath !== join(generationDirectory, "node") || typeof record.version !== "string" || !/^v\d+\.\d+\.\d+$/.test(record.version) ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 1 || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256))
    throw new Error("the migration Node record differs from its generation or has invalid fields");
  const before = nodeFile(record.retainedPath, true);
  copyPinnedFile(record.retainedPath, undefined, { path: "node", size: record.bytes, sha256: record.sha256 });
  if (version(record.retainedPath) !== record.version || !same(before, nodeFile(record.retainedPath, true)))
    throw new Error("the retained Node executable changed during verification");
  assertMaintenanceLock(lock);
}
