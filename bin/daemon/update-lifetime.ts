import { lstatSync } from "node:fs";
import { join } from "node:path";
import { homeCotalDir } from "@cotal-ai/workspace";
import { openVerified } from "./client.js";
import { daemonPaths, EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { excludeLifetime, observeLifetimeRecord, processBirth } from "./lifetime.js";

export interface UpdateDaemonLifetime {
  readonly pid: number;
  readonly start: string;
}

/** Authenticate only the local daemon lifetime, without status, Manager discovery or mesh auth. */
export async function observeUpdateDaemon(paths?: DaemonPaths): Promise<UpdateDaemonLifetime | undefined> {
  if (!paths) {
    try { paths = daemonPaths(); }
    catch (error) {
      if (!(error instanceof EndpointRefusal) || error.code !== "NO_RUNTIME_DIR") throw error;
    }
  }
  if (paths) {
    try {
      const before = observeLifetimeRecord(paths.lock).record;
      const socket = await openVerified({ paths });
      try {
        const record = observeLifetimeRecord(paths.lock).record;
        if (!before?.start || !record?.start || before.pid !== record.pid || before.start !== record.start || processBirth(record.pid) !== record.start) throw new Error("machine daemon lifetime changed during update identity observation");
        return { pid: record.pid, start: record.start };
      } finally { socket.destroy(); }
    } catch (error) {
      if (!(error instanceof EndpointRefusal) || error.code !== "NOT_RUNNING") throw error;
    }
  }
  assertUpdateDaemon(undefined, paths);
  return undefined;
}

/** Recheck the authenticated lifetime, or kernel-proven absence, immediately before publication. */
export function assertUpdateDaemon(expected: UpdateDaemonLifetime | undefined, paths?: DaemonPaths): void {
  const lock = paths?.lock ?? join(homeCotalDir(), "daemon", "daemon.lock");
  try {
    const info = lstatSync(lock);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.uid !== process.geteuid!() || (info.mode & 0o077) !== 0))) throw new Error("machine daemon lifetime record is not protected; no update admission was granted");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expected) return; throw error; }
  const observation = observeLifetimeRecord(lock);
  if (expected) {
    if (!sameUpdateDaemon(expected, observation.record?.start ? { pid: observation.record.pid, start: observation.record.start } : undefined) || processBirth(expected.pid) !== expected.start) throw new Error("machine daemon lifetime changed before execution publication");
    return;
  }
  if (!observation.empty && !observation.record?.start) throw new Error("machine daemon lifetime identity is unreadable; no update admission was granted");
  // A missing endpoint is not absence. Only the kernel's exclusive lock can prove
  // that an empty or stale lifetime record has no current holder.
  const exclusion = excludeLifetime(lock);
  exclusion.release();
  return undefined;
}

export function sameUpdateDaemon(left: UpdateDaemonLifetime | undefined, right: UpdateDaemonLifetime | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.pid === right.pid && left.start === right.start;
}
