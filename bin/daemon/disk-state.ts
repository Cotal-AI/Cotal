/** The daemon's view of "the disk is full": one flag, set by a failed write, cleared by a
 *  write that succeeds. Every surface reads the same flag from {@link DaemonStatus.diskFull},
 *  so the window, the pill, the tray and `cotal daemon status` cannot disagree about it.
 *
 *  The flag is never cleared by a free-space number: reserved blocks, a quota or a failed write
 *  on another filesystem can all leave gigabytes free to a number while writes still fail, and
 *  a quota is invisible to any of them. Only a real write to the same filesystem the daemon
 *  writes its records to clears it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDiskFull } from "@cotal-ai/workspace";
import { DAEMON_PROTOCOL_VERSION } from "./endpoint.js";
import type { DaemonStatus } from "./protocol.js";

export interface DiskFullState {
  /** Whether the last observed write failed because the disk was full. */
  full(): boolean;
  /** Mark the state from a failed write's error; a non-storage error leaves the flag alone. */
  observe(error: unknown): boolean;
  /** Clear the state after a write this daemon performed succeeded. */
  clear(): void;
  /** Run a write, mark the flag from its outcome, and return its result or rethrow its error. */
  guard<T>(write: () => T): T;
  /** Try one real write in the folder the daemon writes its records to: only its success
   *  clears the flag; its failure leaves the flag as it was. Returns the flag. */
  recheck(): Promise<boolean>;
}

/** A write the daemon can attempt anywhere its records live: one small file, created and
 *  removed again, whose failure is a full disk exactly as a record write would see it. */
async function probeWrite(folder: string): Promise<void> {
  const probe = mkdtempSync(join(folder, "disk-full-probe-"));
  try {
    writeFileSync(join(probe, "probe"), "1");
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** Create the shared disk-full state. {@link DiskFullState.recheck} writes a small temporary
 *  file in `folder`, the folder the daemon's own records live in. */
export function createDiskFullState(folder: string): DiskFullState {
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
    async recheck() {
      if (!full) return full;
      try {
        await probeWrite(folder);
        full = false;
      } catch { /* A probe that cannot write leaves the last observed state. */ }
      return full;
    },
  };
}

/** Mark the state from a failed operation's error and notify the daemon's status watchers at
 *  once: a write that failed for space is the one fact status must carry right away. */
export function observeDiskFullWith(state: DiskFullState, notify: () => void): (error: unknown) => void {
  return (error: unknown) => {
    state.observe(error);
    if (state.full()) notify();
  };
}

/** Re-attempt the probe write once a minute so the flag clears within a minute when nobody is
 *  reading. Unref'd: the timer never keeps the daemon alive on its own. Returns the stop
 *  handle; `close()` must call it on every exit path. */
export function startDiskFullRecheck(state: DiskFullState, notify: () => void): () => void {
  const timer = setInterval(() => {
    void state.recheck().then(was => { if (!was) notify(); });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** A status read that first re-attempts the probe write, so a person who frees space and reads
 *  status again sees the state clear without a restart or a new request. */
export function diskFullAwareRead<T>(state: DiskFullState, read: () => Promise<T>): () => Promise<T> {
  return async () => {
    await state.recheck();
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
