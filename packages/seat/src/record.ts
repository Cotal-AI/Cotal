import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const RECORD_VERSION = 1;

/** Read the kernel boot id from /proc, or undefined when unavailable. A custody record pins this
 *  at launch so a successor that rebooted between the spawn and the reap cannot signal a pid whose
 *  start identity coincidentally matches across boots. */
export function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

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
  /** The kernel boot id at launch time (`/proc/sys/kernel/random/boot_id`). A reap that sees a
   *  different boot id refuses: pid + starttime pairs can collide across reboots. */
  bootId?: string;
}

export function seatId(): string {
  return randomBytes(16).toString("hex");
}

const SEAT_ID = /^[0-9a-f]{32}$/;

/** Every seat id names a directory under the custody root, so it is checked against the shape
 *  {@link seatId} mints before it is ever joined to a path. A reference reaches `reapSeat` and
 *  `loadSeat` from a durable slot row, and an id carrying `..` or a separator would address a
 *  record outside the root. Refuse rather than resolve: an unaddressable reference must not be
 *  reported as a seat that is already forgotten. */
export function assertSeatId(id: string): string {
  if (!SEAT_ID.test(id)) throw new Error(`seat id ${JSON.stringify(id)} is not 32 lowercase hex characters; it names a directory under the custody root`);
  return id;
}

export function capabilityToken(): string {
  return randomBytes(32).toString("hex");
}

export function recordPath(root: string, id: string): string {
  return join(root, assertSeatId(id), "record.json");
}

export function socketPath(root: string, id: string): string {
  return join(root, assertSeatId(id), "seat.sock");
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
  if (raw.bootId !== undefined && (typeof raw.bootId !== "string" || raw.bootId.length === 0))
    throw new Error("seat record bootId is not a valid boot identifier");
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
    ...(raw.bootId !== undefined ? { bootId: raw.bootId } : {}),
  };
}
