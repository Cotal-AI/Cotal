import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { lockExclusiveNb } from "./host.js";
import { bootToken, processStartToken } from "./record.js";
import { privateDirectory, readPrivateRecord, recordedProcess, sharedControllerClaim, writePrivateRecord } from "./shared-record.js";
import type { SharedManagerIdentity } from "./shared-control-server.js";

export interface SharedControllerClaim extends SharedManagerIdentity {
  version: 1;
  generation: string;
}

export function validSharedGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function sharedGenerationAcceptsLaunch(claim: SharedControllerClaim | undefined, generation: string): claim is SharedControllerClaim {
  return claim?.generation === generation && recordedProcess(claim.pid, claim.start, claim.bootId) === "live";
}

export function readControllerClaim(lineage: string): SharedControllerClaim | undefined {
  try {
    const row = readPrivateRecord(sharedControllerClaim(lineage), 1024) as Partial<SharedControllerClaim> | null;
    if (!row || row.version !== 1 || !validSharedGeneration(row.generation) || !Number.isSafeInteger(row.pid) || row.pid! <= 1 ||
        typeof row.start !== "string" || !/^\d+$/.test(row.start) || typeof row.bootId !== "string" || !/^[a-f0-9-]{36}$/.test(row.bootId))
      throw new Error("unknown shared PTY controller claim");
    return row as SharedControllerClaim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A claim can pass to a replacement process only when its predecessor is proved gone. */
export function publishControllerClaim(lineage: string, generation?: string): boolean {
  if (generation !== undefined && !validSharedGeneration(generation)) return false;
  privateDirectory(lineage);
  const start = processStartToken(process.pid), bootId = bootToken();
  if (!start || !bootId) return false;
  const fd = openSync(join(lineage, "controller.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || !lockExclusiveNb(fd)) return false;
    const old = readControllerClaim(lineage);
    const selected = generation ?? old?.generation;
    if (!selected) return false;
    if (old && (old.pid !== process.pid || old.start !== start || old.bootId !== bootId) && recordedProcess(old.pid, old.start, old.bootId) !== "gone") return false;
    if (!old || old.pid !== process.pid || old.start !== start || old.bootId !== bootId || old.generation !== selected)
      writePrivateRecord(sharedControllerClaim(lineage), { version: 1, pid: process.pid, start, bootId, generation: selected });
    return true;
  } finally { closeSync(fd); }
}
