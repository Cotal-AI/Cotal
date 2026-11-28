import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { lockExclusiveNb } from "./host.js";
import { validSharedGeneration } from "./shared-controller-claim.js";
import { darwinSharedIdentity, validDarwinBirth, validDarwinBoot, validDarwinPid, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import { readPrivateRecord, sharedControllerClaim, writePrivateRecord } from "./shared-record.js";

export interface DarwinControllerClaim extends DarwinSharedIdentity { readonly generation: string }

function checkLineage(lineage: string, uid: number): void {
  const stat = lstatSync(lineage);
  if (process.platform !== "darwin" || uid !== process.getuid?.() || uid === 0 || !/^[a-f0-9]{32}$/.test(basename(lineage)) ||
      !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700 || realpathSync.native(lineage) !== lineage)
    throw new Error("unverified Darwin PTY controller lineage");
}

export function readDarwinControllerClaim(lineage: string, uid: number): DarwinControllerClaim | undefined {
  checkLineage(lineage, uid);
  try {
    const row = readPrivateRecord(sharedControllerClaim(lineage), 1024) as Partial<DarwinControllerClaim & { version: number }> | null;
    if (!row || row.version !== 1 || !validSharedGeneration(row.generation) || !validDarwinPid(row.pid) ||
        !validDarwinBirth(row.start) || !validDarwinBoot(row.bootId)) throw new Error("unverified Darwin PTY controller claim");
    return { pid: row.pid, start: row.start, bootId: row.bootId, generation: row.generation, uid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Compare the already-observed predecessor under the claim lock and preserve its selected
 * generation. A missing claim or a live/unknown predecessor is not recovery authority. The caller
 * must independently verify host, seat and installation custody before invoking this helper. */
export function replaceDarwinControllerClaim(lineage: string, expected: Readonly<DarwinControllerClaim>): boolean {
  const current = darwinSharedIdentity.current();
  if (!current) return false;
  const path = join(lineage, "controller.lock");
  try {
    checkLineage(lineage, current.uid);
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const held = fstatSync(fd, { bigint: true });
      if (!held.isFile() || held.uid !== BigInt(current.uid) || (held.mode & 0o777n) !== 0o600n || held.nlink !== 1n ||
          !lockExclusiveNb(fd)) return false;
      const entry = lstatSync(path, { bigint: true });
      if (entry.dev !== held.dev || entry.ino !== held.ino || entry.mode !== held.mode || entry.uid !== held.uid || entry.nlink !== 1n)
        return false;
      const prior = readDarwinControllerClaim(lineage, current.uid);
      if (!prior || prior.generation !== expected.generation || !darwinSharedIdentity.same(prior, expected) ||
          darwinSharedIdentity.observe(prior) !== "gone") return false;
      const { pid, start, bootId } = current;
      writePrivateRecord(sharedControllerClaim(lineage), { version: 1, pid, start, bootId, generation: prior.generation });
      return true;
    } finally { closeSync(fd); }
  } catch { return false; }
}
