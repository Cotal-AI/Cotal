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
  return {
    version: RECORD_VERSION,
    id: raw.id,
    name: raw.name,
    socket: raw.socket,
    token: raw.token,
    custodianPid: raw.custodianPid,
    childPid: raw.childPid,
  };
}
