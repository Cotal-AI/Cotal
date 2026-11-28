import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homeCotalDir, isDiskFull, readUpdateSettings, saveUpdateSettings } from "@cotal-ai/workspace";
import { DAEMON_PROTOCOL_VERSION } from "./endpoint.js";
import type { DaemonStatus } from "./protocol.js";

export type ObserveDiskFull = (error: unknown, folder: string) => void;

function makeProbeDirectory(folder: string): string {
  try { return mkdtempSync(join(folder, ".disk-full-probe-")); }
  catch (error) {
    // A failed mkdir can leave part of the record path absent. Probe its nearest parent.
    const parent = dirname(folder);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === folder) throw error;
    return makeProbeDirectory(parent);
  }
}

function probeWrite(folder: string): void {
  const probe = makeProbeDirectory(folder);
  try { writeFileSync(join(probe, "probe"), "1", { mode: 0o600, flag: "wx" }); }
  finally { rmSync(probe, { recursive: true, force: true }); }
}

/** One flag on the wire, backed by the destinations that could not be written. An unrelated
 * successful write, free-space estimate or read is not evidence that a destination recovered. */
export function createDiskFullState(notify: () => void) {
  const pending = new Set<string>();
  const full = () => pending.size > 0;
  const observe: ObserveDiskFull = (error, folder) => {
    if (!isDiskFull(error)) return;
    const wasFull = full();
    pending.add(folder);
    if (!wasFull) notify();
  };
  const wrote = (folder: string) => { if (pending.delete(folder) && !full()) notify(); };
  const recheck = () => {
    for (const folder of pending) {
      try { probeWrite(folder); }
      catch { continue; }
      wrote(folder);
    }
  };
  return {
    full, observe, wrote, recheck,
    guard<T>(folder: string, write: () => T): T {
      try {
        const result = write();
        wrote(folder);
        return result;
      } catch (error) {
        observe(error, folder);
        throw error;
      }
    },
    startRecheck(): () => void {
      const timer = setInterval(recheck, 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

type DiskFullState = ReturnType<typeof createDiskFullState>;

/** For request-level fallback observation, prefer a real failing path to an inferred directory. */
export function writeFailureFolder(error: unknown, fallback: string): string {
  for (let depth = 0; error && typeof error === "object" && depth < 4; depth++) {
    const source = error as NodeJS.ErrnoException & { cause?: unknown; dest?: string };
    const path = source.dest ?? source.path;
    if (typeof path === "string" && isAbsolute(path)) return dirname(path);
    error = source.cause;
  }
  return fallback;
}

/** One atomic publication for a request that changes either or both preferences. */
export function updateDaemonSettings(disk: DiskFullState, { auto, notify }: { auto?: boolean; notify?: boolean }): void {
  const settings = readUpdateSettings();
  if (auto === undefined && notify === undefined) return;
  disk.guard(homeCotalDir(), () => saveUpdateSettings({ v: 1, auto: auto ?? settings.auto, notify: notify ?? settings.notify }));
}

export function diskFullRefusal(op: string) {
  const message = op === "name" || op === "update-settings"
    ? "The disk is full, so this change wasn't saved. Free up space on this computer, then try again."
    : ["status", "manager-status", "update-check", "connect-check"].includes(op)
      ? "Cotal couldn't complete this because the disk is full. Free up space on this computer, then try again."
      : "Cotal couldn't confirm this change because the disk is full. Free up space on this computer, then try again.";
  return { code: "OPERATION_FAILED" as const, message };
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
