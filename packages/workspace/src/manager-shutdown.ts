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
  probeLiveness,
  type ProcessIdentityRecord,
  type ProcessStartTokenReader,
  defaultStartToken,
} from "./pid.js";

/** One-shot policy handoff written by `cotal down --with-agents` before it signals the manager.
 * Version 1 binds stable process-start tokens. Version 2 is the honest legacy/Windows fallback:
 * exact manager pid plus the live stop reservation's inode, so another attempt cannot replay it. */
export const MANAGER_SHUTDOWN_INTENT = "manager.{space}.shutdown-intent";
export const MANAGER_SPARE_CAPABILITY = "manager.{space}.spare-capability";

interface PinnedManagerShutdownIntent {
  version: 1;
  policy: "with-agents";
  target: ProcessIdentityRecord;
  stopper: ProcessIdentityRecord;
}

interface LegacyManagerShutdownIntent {
  version: 2;
  policy: "with-agents";
  target: { pid: number };
  stopper: { pid: number; reservation: string };
}

type ManagerShutdownIntent = PinnedManagerShutdownIntent | LegacyManagerShutdownIntent;

export interface ManagerShutdownDecision {
  withAgents: boolean;
  warning?: string;
}

function exactIntent(value: unknown): ManagerShutdownIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "policy,stopper,target,version") return undefined;
  if (row.policy !== "with-agents") return undefined;
  const exactRecord = (value: unknown): ProcessIdentityRecord | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const process = value as Record<string, unknown>;
    if (Object.keys(process).sort().join(",") !== "pid,token") return undefined;
    if (typeof process.pid !== "number" || parsePid(String(process.pid)) !== process.pid) return undefined;
    if (typeof process.token !== "string" || process.token === "" || /\s/.test(process.token)) return undefined;
    return { pid: process.pid, token: process.token };
  };
  if (row.version === 1) {
    const target = exactRecord(row.target);
    const stopper = exactRecord(row.stopper);
    return target && stopper ? { version: 1, policy: "with-agents", target, stopper } : undefined;
  }
  if (row.version !== 2) return undefined;
  const target = row.target && typeof row.target === "object" && !Array.isArray(row.target) ? row.target as Record<string, unknown> : undefined;
  const stopper = row.stopper && typeof row.stopper === "object" && !Array.isArray(row.stopper) ? row.stopper as Record<string, unknown> : undefined;
  if (!target || Object.keys(target).join(",") !== "pid" || typeof target.pid !== "number" || parsePid(String(target.pid)) !== target.pid) return undefined;
  if (!stopper || Object.keys(stopper).sort().join(",") !== "pid,reservation" ||
      typeof stopper.pid !== "number" || parsePid(String(stopper.pid)) !== stopper.pid ||
      typeof stopper.reservation !== "string" || !/^\d+:\d+$/.test(stopper.reservation)) return undefined;
  return {
    version: 2,
    policy: "with-agents",
    target: { pid: target.pid },
    stopper: { pid: stopper.pid, reservation: stopper.reservation },
  };
}

function reservationIdentity(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("manager stop reservation is not a regular file");
  return `${stat.dev}:${stat.ino}`;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } catch (error) {
    // Windows does not support opening/fsyncing a directory. Keep the file fsync + atomic rename,
    // while preserving the parent-directory durability barrier as a correctness requirement on
    // every platform that implements it. This mirrors maintenance's established portability rule.
    if (process.platform !== "win32") throw error;
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
  target?: ProcessIdentityRecord,
): void {
  const expected = recordedManagerProcess(context, tokenAt);
  if (target && (target.pid !== expected.pid || target.token !== expected.token))
    throw new Error("refusing bare manager stop: stop attempt target does not match the recorded manager process");
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
 * holding its `.stopping` reservation. Pinned targets use start tokens for both processes. A legacy
 * target has no token by definition, so it binds the recorded pid plus the reservation inode and a
 * live reservation owner. This is called only from stopLocalProcess's before-signal hook. If that
 * stopper crashes, or another attempt replaces the reservation inode, the intent cannot replay.
 */
export function armManagerShutdownIntent(
  context: LocalProcessContext,
  attempt: { target: { pid: number; token?: string }; stopper: { pid: number; marker: string } },
  tokenAt: ProcessStartTokenReader = defaultStartToken,
): void {
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
  if (attempt.stopper.marker !== `${pidPath}.stopping`)
    throw new Error("cannot arm --with-agents: stop reservation marker is not this manager's; destructive policy was not published");
  let stopperPid: number | undefined;
  try { stopperPid = parsePid(readFileSync(attempt.stopper.marker, "utf8")); } catch { stopperPid = undefined; }
  if (stopperPid === undefined)
    throw new Error("cannot arm --with-agents: manager stop reservation is absent or unattributable; destructive policy was not published");
  if (stopperPid !== attempt.stopper.pid)
    throw new Error("cannot arm --with-agents: stop reservation owner is not this process; destructive policy was not published");
  const path = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, context);
  if (attempt.target.token === undefined) {
    const recordedPid = parsePid(readFileSync(pidPath, "utf8"));
    if (recordedPid !== attempt.target.pid)
      throw new Error("cannot arm --with-agents: stop attempt target does not match the recorded legacy manager process; destructive policy was not published");
    publishAtomic(path, {
      version: 2,
      policy: "with-agents",
      target: { pid: attempt.target.pid },
      stopper: { pid: stopperPid, reservation: reservationIdentity(attempt.stopper.marker) },
    } satisfies LegacyManagerShutdownIntent);
    return;
  }
  const managerProcess = { pid: attempt.target.pid, token: attempt.target.token };
  let recorded: ProcessIdentityRecord;
  try { recorded = recordedManagerProcess(context, tokenAt); }
  catch (e) { throw new Error(`cannot arm --with-agents: ${(e as Error).message}; destructive policy was not published`); }
  if (recorded.pid !== managerProcess.pid || recorded.token !== managerProcess.token)
    throw new Error("cannot arm --with-agents: stop attempt target does not match the recorded manager process; destructive policy was not published");
  const stopperToken = tokenAt(stopperPid);
  if (stopperToken === undefined)
    throw new Error("cannot arm --with-agents: manager stop reservation owner has no verifiable process identity; destructive policy was not published");
  const stopper = { pid: stopperPid, token: stopperToken };
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
    const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
    if (parsed.version === 2) {
      let recordedPid: number | undefined;
      try { recordedPid = parsePid(readFileSync(pidPath, "utf8")); } catch { recordedPid = undefined; }
      if (recordedPid !== pid)
        return { withAgents: false, warning: "ignored legacy manager shutdown intent because the manager pid record changed; managed agents were spared" };
      let reservationOwner: number | undefined;
      try { reservationOwner = parsePid(readFileSync(`${pidPath}.stopping`, "utf8")); } catch { reservationOwner = undefined; }
      if (reservationOwner !== parsed.stopper.pid)
        return { withAgents: false, warning: "ignored stale legacy manager shutdown intent from a different stop attempt; managed agents were spared" };
      let reservation: string | undefined;
      try { reservation = reservationIdentity(`${pidPath}.stopping`); } catch { reservation = undefined; }
      if (reservation !== parsed.stopper.reservation)
        return { withAgents: false, warning: "ignored legacy manager shutdown intent because its stop reservation inode changed; managed agents were spared" };
      if (probeLiveness(parsed.stopper.pid) === "dead")
        return { withAgents: false, warning: "ignored legacy manager shutdown intent because its stop reservation owner exited; managed agents were spared" };
      return { withAgents: true };
    }
    const targetVerdict = assertRecordIdentity(parsed.target, tokenAt);
    if (targetVerdict.kind !== "match")
      return { withAgents: false, warning: `ignored manager shutdown intent with ${targetVerdict.kind} target identity; managed agents were spared` };
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
