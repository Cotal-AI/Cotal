import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertSeatId, bootToken, processStatFields, seatId, type SeatRecord } from "./record.js";

export const SHARED_MULTIPLEX_VERSION = 2;

export interface SharedHostRecord {
  version: typeof SHARED_MULTIPLEX_VERSION;
  protocol: typeof SHARED_MULTIPLEX_VERSION;
  pid: number;
  start: string;
  bootId: string;
  scope: string;
  token: string;
}

export interface SharedSeatRecord extends SeatRecord {
  protocol: typeof SHARED_MULTIPLEX_VERSION;
  scope: string;
  bootId: string;
  custodianStart: string;
  childStart?: string;
}

export const sharedHostRecord = (root: string): string => join(root, "host.json");
export const sharedHostSocket = (root: string): string => join(root, "host.sock");
export const sharedControllerClaim = (root: string): string => join(root, "controller.json");
export const sharedSeatRecord = (root: string, id: string): string => join(root, assertSeatId(id), "shared.json");
const sharedSeatRefusal = (root: string, id: string): string => join(dirname(sharedSeatRecord(root, id)), "not-admitted.json");

export function writeSharedSeatRefusal(root: string, id: string, host: SharedHostRecord): void {
  writePrivateRecord(sharedSeatRefusal(root, id), { pid: host.pid, start: host.start, bootId: host.bootId, scope: host.scope });
}

export function sharedSeatWasRefused(root: string, id: string, host: SharedHostRecord): boolean {
  try {
    const row = readPrivateRecord(sharedSeatRefusal(root, id), 1024) as Partial<SharedHostRecord> | null;
    return row?.pid === host.pid && row.start === host.start && row.bootId === host.bootId && row.scope === host.scope;
  } catch { return false; }
}

/** Linux Unix sockets have a short sockaddr path even when the underlying directory is deep. */
export function shortSocketPath(path: string): { path: string; close(): void } {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return { path: `/proc/self/fd/${fd}/${basename(path)}`, close: () => closeSync(fd) };
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("custody directory is not a private directory owned by this user");
}

function openPrivateRead(path: string, bound: number): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > bound)
      throw new Error("custody record is not a bounded private file owned by this user");
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}

export function readPrivateRecord(path: string, bound = 64 * 1024): unknown {
  const fd = openPrivateRead(path, bound);
  try {
    const bytes = Buffer.allocUnsafe(bound + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > bound) throw new Error("custody record exceeds its read bound");
    return JSON.parse(bytes.toString("utf8", 0, count));
  }
  finally { closeSync(fd); }
}

export function writePrivateRecord(path: string, value: unknown): void {
  const temp = join(dirname(path), `.record-${seatId()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function readSharedHost(root: string): SharedHostRecord {
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700)
    throw new Error("unknown shared PTY host directory");
  const record = readPrivateRecord(sharedHostRecord(root)) as Partial<SharedHostRecord> | null;
  if (!record || record.version !== SHARED_MULTIPLEX_VERSION || record.protocol !== SHARED_MULTIPLEX_VERSION ||
      !Number.isSafeInteger(record.pid) || record.pid! <= 1 || !/^\d+$/.test(record.start ?? "") ||
      !/^[0-9a-f-]{36}$/.test(record.bootId ?? "") || !isSharedScope(record.scope) || !/^[0-9a-f]{64}$/.test(record.token ?? ""))
    throw new Error("unknown shared PTY host record");
  return record as SharedHostRecord;
}

export function readSharedSeat(root: string, id: string): SharedSeatRecord {
  const directory = lstatSync(dirname(sharedSeatRecord(root, id)));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700)
    throw new Error("unknown shared PTY seat directory");
  const record = readPrivateRecord(sharedSeatRecord(root, id)) as Partial<SharedSeatRecord> | null;
  if (!record || record.version !== 1 || record.protocol !== SHARED_MULTIPLEX_VERSION || record.id !== id ||
      typeof record.name !== "string" || !record.name || record.socket !== sharedHostSocket(root) || !/^[0-9a-f]{64}$/.test(record.token ?? "") ||
      !Number.isSafeInteger(record.custodianPid) || record.custodianPid! <= 1 || !Number.isSafeInteger(record.childPid) || record.childPid! <= 1 ||
      !/^\d+$/.test(record.custodianStart ?? "") || (record.childStart !== undefined && !/^\d+$/.test(record.childStart)) ||
      !/^[0-9a-f-]{36}$/.test(record.bootId ?? "") || !isSharedScope(record.scope)) throw new Error("unknown shared PTY seat record");
  return record as SharedSeatRecord;
}

// Persisted unit names are part of the cross-release contract in shared-linux.ts.
export function isSharedScope(scope: unknown): scope is string {
  return typeof scope === "string" && /^cotal-pty-[0-9a-f]{32}\.service$/.test(scope);
}

/** Undefined means the kernel evidence could not be read, not that the process is gone. */
export function recordedProcess(pid: number, start: string, boot: string): "live" | "gone" | undefined {
  const current = bootToken();
  if (!current) return undefined;
  if (boot !== current) return "gone";
  const fields = processStatFields(pid);
  if (fields) return fields[19] !== start || fields[0] === "Z" || fields[0] === "X" ? "gone" : "live";
  try { lstatSync(`/proc/${pid}`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone"; }
  return undefined;
}

export function sharedScopeMatches(pid: number, scope: string): boolean {
  try {
    const path = /^0::([^\n]+)\n?$/m.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"))?.[1];
    const uid = process.getuid?.();
    const base = `/user.slice/user-${uid}.slice/user@${uid}.service/`;
    return path === `${base}app.slice/${scope}/host`;
  } catch { return false; }
}
