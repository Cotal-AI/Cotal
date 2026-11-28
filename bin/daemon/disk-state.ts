/** The daemon's view of "the disk is full": one flag, set by a failed write, cleared by reality.
 *  Every surface reads the same flag from {@link DaemonStatus.diskFull}, so the window, the pill,
 *  the tray and `cotal daemon status` cannot disagree about it.
 */
import { statfs } from "node:fs/promises";
import { isDiskFull } from "@cotal-ai/workspace";
import { DAEMON_PROTOCOL_VERSION } from "./endpoint.js";
import type { DaemonStatus } from "./protocol.js";

/** A free-space headroom under which the disk counts as full for the recheck: ENOSPC can strike
 *  with a few blocks still nominally free (the write needs a full page), and a recheck that waits
 *  for literal zero would report health while writes still fail. */
const FREE_HEADROOM_BYTES = 4096;

export interface DiskFullState {
  /** Whether the last observed write failed because the disk was full. */
  full(): boolean;
  /** Mark the state from a failed write's error; a non-storage error leaves the flag alone. */
  observe(error: unknown): boolean;
  /** Clear the state after a write this daemon performed succeeded. */
  clear(): void;
  /** Run a write, mark the flag from its outcome, and return its result or rethrow its error. */
  guard<T>(write: () => T): T;
  /** Re-read the filesystem: free space beyond the headroom clears the flag, nothing else sets it. */
  recheck(path: string): Promise<boolean>;
}

/** Create the shared disk-full state. {@link DiskFullState.recheck} re-reads any path on the
 *  filesystem whose health decides the flag. */
export function createDiskFullState(): DiskFullState {
  let full = false;
  return {
    full: () => full,
    observe(error) {
      if (isDiskFull(error)) full = true;
      return full;
    },
    clear() { full = false; },
    guard(write) {
      try {
        const result = write();
        full = false;
        return result;
      } catch (error) {
        if (isDiskFull(error)) full = true;
        throw error;
      }
    },
    async recheck(target: string) {
      if (!full) return full;
      try {
        const fs = await statfs(target, { bigint: true });
        if (BigInt(fs.bsize) * BigInt(fs.bfree) > BigInt(FREE_HEADROOM_BYTES)) full = false;
      } catch { /* The recheck is advisory; a failed read keeps the last observed state. */ }
      return full;
    },
  };
}

/** Mark the state from a failed operation's error and notify the daemon's status watchers at once:
 *  a write that failed for space is the one fact status must carry right away. */
export function observeDiskFullWith(state: DiskFullState, notify: () => void): (error: unknown) => void {
  return (error: unknown) => {
    state.observe(error);
    if (state.full()) notify();
  };
}

/** Re-read the filesystem once a minute so the flag clears within a minute when nobody is
 *  watching. Unref'd: the timer never keeps the daemon alive on its own. */
export function startDiskFullRecheck(state: DiskFullState, path: string, notify: () => void): void {
  const timer = setInterval(() => { void state.recheck(path).then(full => { if (!full) notify(); }); }, 60_000);
  timer.unref();
}

/** A status read that first rechecks the disk. Rule 1: every answer about the disk is re-derived
 *  from the filesystem at the moment it is asked, so a person who frees space and reads status
 *  again sees the state clear without a restart. */
export function diskFullAwareRead<T>(state: DiskFullState, path: string, read: () => Promise<T>): () => Promise<T> {
  return async () => {
    await state.recheck(path);
    return read();
  };
}

/** Assemble the one DaemonStatus frame every surface reads, keeping the disk-full field with the
 *  rest of the shared state so no caller computes it separately. */
export function daemonStatusFrame(parts: {
  diskFull: boolean;
  update: (() => NonNullable<DaemonStatus["update"]>) | undefined;
  version: string;
  startedAt: Date;
  generation: DaemonStatus["generation"];
  vitals: DaemonStatus["vitals"];
  vitalsError: string | undefined;
  computer: string | undefined;
  computerNameWarning: string | undefined;
  managers: NonNullable<DaemonStatus["managers"]>;
  account: DaemonStatus["account"];
}): DaemonStatus {
  return {
    vitals: parts.vitals,
    vitalsError: parts.vitalsError,
    computer: parts.computer,
    ...(parts.computerNameWarning ? { computerNameWarning: parts.computerNameWarning } : {}),
    ...(parts.diskFull ? { diskFull: true } : {}),
    state: "ready",
    protocol: DAEMON_PROTOCOL_VERSION,
    version: parts.version,
    pid: process.pid,
    startedAt: parts.startedAt.toISOString(),
    uptimeMs: Date.now() - parts.startedAt.getTime(),
    managers: parts.managers,
    account: parts.account,
    ...(parts.update ? { update: parts.update() } : {}),
    ...(parts.generation ? { generation: parts.generation } : {}),
  };
}
