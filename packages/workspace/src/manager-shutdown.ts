import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalLocalProcessPath, MANAGER_PIDFILE, type LocalProcessContext } from "./local-process.js";
import {
  assertRecordIdentity,
  identityPinPath,
  parsePid,
  parseRecord,
  type ProcessIdentityRecord,
  type ProcessStartTokenReader,
  defaultStartToken,
} from "./pid.js";

/** One-shot policy handoff written by `cotal down --with-agents` before it signals the manager. */
export const MANAGER_SHUTDOWN_INTENT = "manager.{space}.shutdown-intent";
export const MANAGER_SPARE_CAPABILITY = "manager.{space}.spare-capability";

interface ManagerShutdownIntent {
  version: 1;
  policy: "with-agents";
  target: ProcessIdentityRecord;
  stopper: ProcessIdentityRecord;
}

export interface ManagerShutdownDecision {
  withAgents: boolean;
  warning?: string;
}

function exactIntent(value: unknown): ManagerShutdownIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "policy,stopper,target,version") return undefined;
  if (row.version !== 1 || row.policy !== "with-agents") return undefined;
  const exactRecord = (value: unknown): ProcessIdentityRecord | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const process = value as Record<string, unknown>;
    if (Object.keys(process).sort().join(",") !== "pid,token") return undefined;
    if (typeof process.pid !== "number" || parsePid(String(process.pid)) !== process.pid) return undefined;
    if (typeof process.token !== "string" || process.token === "" || /\s/.test(process.token)) return undefined;
    return { pid: process.pid, token: process.token };
  };
  const target = exactRecord(row.target);
  const stopper = exactRecord(row.stopper);
  return target && stopper ? { version: 1, policy: "with-agents", target, stopper } : undefined;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function recordedManagerProcess(context: LocalProcessContext, tokenAt: ProcessStartTokenReader): ProcessIdentityRecord {
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
  const pid = parsePid(readFileSync(pidPath, "utf8"));
  if (pid === undefined) throw new Error(`manager pidfile is unattributable at ${pidPath}`);
  let rawPin: string;
  try {
    rawPin = readFileSync(identityPinPath(pidPath), "utf8");
  } catch {
    throw new Error(`manager at ${pidPath} has no process identity pin`);
  }
  const parsed = parseRecord(rawPin);
  if (parsed.kind !== "record" || parsed.record.pid !== pid)
    throw new Error(`manager process identity pin is malformed or does not match ${pidPath}`);
  const verdict = assertRecordIdentity(parsed.record, tokenAt);
  if (verdict.kind !== "match") throw new Error(`manager process identity is ${verdict.kind}`);
  return parsed.record;
}

function publishAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    syncDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

/** Publish that this exact manager process can release its local runtime custody without reaping. */
export function publishManagerSpareCapability(
  context: LocalProcessContext,
  capable: boolean,
  tokenAt: ProcessStartTokenReader = defaultStartToken,
): void {
  const path = canonicalLocalProcessPath(MANAGER_SPARE_CAPABILITY, context);
  if (!capable) {
    rmSync(path, { force: true });
    return;
  }
  const process = recordedManagerProcess(context, tokenAt);
  publishAtomic(path, { version: 1, process });
}

/** Refuse a bare stop before SIGTERM when this exact manager cannot safely spare its PTY child. */
export function assertManagerCanSpare(
  context: LocalProcessContext,
  tokenAt: ProcessStartTokenReader = defaultStartToken,
): void {
  const expected = recordedManagerProcess(context, tokenAt);
  const path = canonicalLocalProcessPath(MANAGER_SPARE_CAPABILITY, context);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`refusing bare manager stop: ${path} does not prove this manager can detach its agents; use --with-agents or stop the agents explicitly`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`refusing bare manager stop: malformed spare capability at ${path}`);
  const row = value as Record<string, unknown>;
  const process = row.process && typeof row.process === "object" && !Array.isArray(row.process) ? row.process as Record<string, unknown> : undefined;
  if (Object.keys(row).sort().join(",") !== "process,version" || row.version !== 1 || !process ||
      Object.keys(process).sort().join(",") !== "pid,token" || process.pid !== expected.pid || process.token !== expected.token)
    throw new Error(`refusing bare manager stop: spare capability at ${path} is malformed, stale, or belongs to a different manager process`);
}

/**
 * Durably arm a destructive shutdown for the exact manager and the exact live `cotal down` process
 * holding its `.stopping` reservation. This is called only from stopLocalProcess's before-signal
 * hook. If that stopper crashes, its intent cannot poison a later bare stop.
 */
export function armManagerShutdownIntent(
  context: LocalProcessContext,
  tokenAt: ProcessStartTokenReader = defaultStartToken,
): void {
  let managerProcess: ProcessIdentityRecord;
  try { managerProcess = recordedManagerProcess(context, tokenAt); }
  catch (e) { throw new Error(`cannot arm --with-agents: ${(e as Error).message}; destructive policy was not published`); }
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
  let stopperPid: number | undefined;
  try { stopperPid = parsePid(readFileSync(`${pidPath}.stopping`, "utf8")); } catch { stopperPid = undefined; }
  if (stopperPid === undefined)
    throw new Error("cannot arm --with-agents: manager stop reservation is absent or unattributable; destructive policy was not published");
  const stopperToken = tokenAt(stopperPid);
  if (stopperToken === undefined)
    throw new Error("cannot arm --with-agents: manager stop reservation owner has no verifiable process identity; destructive policy was not published");
  const stopper = { pid: stopperPid, token: stopperToken };
  const path = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, context);
  publishAtomic(path, { version: 1, policy: "with-agents", target: managerProcess, stopper } satisfies ManagerShutdownIntent);
}

/** Remove an armed intent when SIGTERM could not be delivered. */
export function disarmManagerShutdownIntent(context: LocalProcessContext): void {
  const path = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, context);
  rmSync(path, { force: true });
  syncDirectory(path);
}

/**
 * Claim and consume the one-shot intent before choosing the signal shutdown policy. Malformed,
 * stale, symlinked, or process-mismatched files are consumed as spare decisions, never replayed.
 */
export function consumeManagerShutdownIntent(
  context: LocalProcessContext,
  pid: number = process.pid,
  tokenAt: ProcessStartTokenReader = defaultStartToken,
): ManagerShutdownDecision {
  const path = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, context);
  const claimed = `${path}.${pid}.${randomBytes(6).toString("hex")}.consuming`;
  try {
    renameSync(path, claimed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { withAgents: false };
    return { withAgents: false, warning: `could not claim manager shutdown intent: ${(e as Error).message}` };
  }

  try {
    const stat = lstatSync(claimed);
    if (!stat.isFile() || stat.isSymbolicLink())
      return { withAgents: false, warning: "ignored manager shutdown intent because it is not a regular file" };
    let parsed: ManagerShutdownIntent | undefined;
    try {
      parsed = exactIntent(JSON.parse(readFileSync(claimed, "utf8")));
    } catch {
      parsed = undefined;
    }
    if (!parsed)
      return { withAgents: false, warning: "ignored malformed manager shutdown intent; managed agents were spared" };
    if (parsed.target.pid !== pid)
      return { withAgents: false, warning: "ignored stale manager shutdown intent for a different process; managed agents were spared" };
    const targetVerdict = assertRecordIdentity(parsed.target, tokenAt);
    if (targetVerdict.kind !== "match")
      return { withAgents: false, warning: `ignored manager shutdown intent with ${targetVerdict.kind} target identity; managed agents were spared` };
    const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
    let reservationOwner: number | undefined;
    try { reservationOwner = parsePid(readFileSync(`${pidPath}.stopping`, "utf8")); } catch { reservationOwner = undefined; }
    if (reservationOwner !== parsed.stopper.pid)
      return { withAgents: false, warning: "ignored stale manager shutdown intent from a different stop attempt; managed agents were spared" };
    const stopperVerdict = assertRecordIdentity(parsed.stopper, tokenAt);
    if (stopperVerdict.kind !== "match")
      return { withAgents: false, warning: `ignored manager shutdown intent with ${stopperVerdict.kind} stopper identity; managed agents were spared` };
    return { withAgents: true };
  } finally {
    rmSync(claimed, { force: true });
  }
}
