import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const RECORD_VERSION = 1;

export interface SeatRecord {
  version: number;
  id: string;
  name: string;
  socket: string;
  token: string;
  custodianPid: number;
  childPid: number;
  /** The custodian's process start identity (`/proc/<pid>/stat` starttime), so a later reader can
   *  tell this custodian from an unrelated process that inherited its pid. Absent on a record a
   *  custodian wrote before identity pinning; such a record is never signalled. */
  custodianStart?: string;
  /** The child's process start identity, same rule. Absent on a pinned record when the child had
   *  already exited before the custodian could read it (a failed exec); a reader takes that as gone. */
  childStart?: string;
}

export function seatId(): string {
  return randomBytes(16).toString("hex");
}

export function capabilityToken(): string {
  return randomBytes(32).toString("hex");
}

export function recordPath(root: string, id: string): string {
  return join(root, id, "record.json");
}

export function socketPath(root: string, id: string): string {
  return join(root, id, "seat.sock");
}

/** The Linux process start token: `/proc/<pid>/stat` field 22 (starttime, in clock ticks since
 *  boot), parsed after the final `)` because comm may hold spaces and parentheses. A zombie still
 *  reports it, so a child that exited before its custodian reaped it is still readable. Undefined
 *  when the pid has no `/proc` entry. */
export function processStartToken(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after < 0) return undefined;
    const token = stat.slice(after + 2).split(" ")[19];
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function writeRecord(path: string, record: SeatRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "w" });
  chmodSync(path, 0o600);
  chmodSync(dirname(path), 0o700);
}

export function readRecord(path: string): SeatRecord {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SeatRecord>;
  if (raw.version !== RECORD_VERSION) throw new Error(`unsupported seat record version ${String(raw.version)}`);
  if (typeof raw.id !== "string" || raw.id.length === 0) throw new Error("seat record missing id");
  if (typeof raw.name !== "string" || raw.name.length === 0) throw new Error("seat record missing name");
  if (typeof raw.socket !== "string" || raw.socket.length === 0) throw new Error("seat record missing socket");
  if (typeof raw.token !== "string" || raw.token.length === 0) throw new Error("seat record missing token");
  if (typeof raw.custodianPid !== "number" || !Number.isInteger(raw.custodianPid)) throw new Error("seat record missing custodianPid");
  if (typeof raw.childPid !== "number" || !Number.isInteger(raw.childPid)) throw new Error("seat record missing childPid");
  if (raw.custodianStart !== undefined && (typeof raw.custodianStart !== "string" || raw.custodianStart.length === 0))
    throw new Error("seat record custodianStart is not a start token");
  if (raw.childStart !== undefined && (typeof raw.childStart !== "string" || raw.childStart.length === 0))
    throw new Error("seat record childStart is not a start token");
  return {
    version: RECORD_VERSION,
    id: raw.id,
    name: raw.name,
    socket: raw.socket,
    token: raw.token,
    custodianPid: raw.custodianPid,
    childPid: raw.childPid,
    ...(raw.custodianStart !== undefined ? { custodianStart: raw.custodianStart } : {}),
    ...(raw.childStart !== undefined ? { childStart: raw.childStart } : {}),
  };
}
