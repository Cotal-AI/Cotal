import { join } from "node:path";
import {
  NATS_PIDFILE,
  acquireMaintenanceLock,
  parsePid,
  readMaintenanceJournal,
  readPidfile,
  rearmUnboundRestoreCommitIntent,
  releaseMaintenanceLock,
  removePidPair,
  verifyIdentityPin,
  type MaintenanceLock,
  type PinVerdict,
} from "@cotal-ai/workspace";
import { displayCmd } from "./self-exec.js";

/**
 * Sync the unbound restore's spawn mark. A start that is not an unbound restore is left untouched.
 * The maintenance lock is not re-entrant. A caller that already holds it passes that lock; acquiring
 * another would see this process as the live owner and refuse.
 */
export function recordRestoreListenerSpawn(
  root: string,
  spawn: { serverNonce: string } | "not-started",
  heldLock?: MaintenanceLock,
): void {
  if (!heldLock && spawn === "not-started" && readMaintenanceJournal(root)?.state !== "commit-intent") return;
  const lock = heldLock ?? acquireMaintenanceLock(root);
  try {
    const current = readMaintenanceJournal(root);
    if (!current || current.state !== "commit-intent" || current.listenerProof) return;
    if (spawn !== "not-started") clearPriorListenerPid(root);
    else if (current.launch.listenerSpawn === spawn) return;
    rearmUnboundRestoreCommitIntent(lock, spawn);
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

// A crash before publishing the next pid must not leave the dead prior pid as proof of exit.
function clearPriorListenerPid(root: string): void {
  const path = join(root, ".cotal", NATS_PIDFILE);
  const recorded = readPidfile(path);
  if (recorded === undefined) return;
  if (!removePidPair(path, recorded, "stale")) {
    throw new Error(`the listener record at ${path} is not proven stale; preserving recovery state`);
  }
}

/** Spawn after `started` is durable. If the spawn itself throws, no listener exists, so the mark is cleared. */
export function spawnMarkedListener<T extends { pid?: number | undefined }>(
  root: string, listener: { serverNonce: string } | undefined, spawn: () => T, heldLock?: MaintenanceLock,
): T {
  if (listener) recordRestoreListenerSpawn(root, listener, heldLock);
  let child: T;
  try {
    child = spawn();
  } catch (error) {
    if (listener) recordRestoreListenerSpawn(root, "not-started", heldLock);
    throw error;
  }
  if (listener && child.pid === undefined) recordRestoreListenerSpawn(root, "not-started", heldLock);
  return child;
}

/** Stop the child before it can listen. The smoke exit that follows publishes no pid. */
export function freezeSmokeRestoreListener(child: { pid?: number | undefined }): void {
  if (process.env.COTAL_SMOKE_EXIT_BEFORE_RESTORE_LISTENER_PID !== "1" || process.platform === "win32") return;
  if (child.pid === undefined) return;
  try { process.kill(child.pid, "SIGSTOP"); } catch { /* the child has already exited */ }
}

function publishedPid(path: string): number | undefined {
  const text = readPidfile(path);
  return text === undefined ? undefined : parsePid(text);
}

function prefix(attemptId: string, why: string): string {
  return `restore attempt ${attemptId} re-entry has no bound listener proof, and this host cannot show that no listener it started still runs (${why}).`;
}

function listenerName(serverName: string): string {
  return `nats-server with --name ${serverName} in its command line`;
}

/**
 * The refusal for an unbound restore whose process command lines cannot be read.
 * `not-started` may launch. `started` with no published pid, and a journal with no mark, may not.
 * A creation-time pin that does not match is a reused pid and does not block. Where the pin cannot
 * separate that pid from the listener, a live pid still blocks.
 */
export function unreadableUnboundRestoreRefusal(root: string, attemptId: string, serverName: string, why: string): string | undefined {
  const journal = readMaintenanceJournal(root);
  const launch = journal && "restore" in journal && "launch" in journal ? journal.launch : undefined;
  const mark = launch?.listenerSpawn;
  if (typeof launch?.serverName === "string") serverName = launch.serverName;
  const path = join(root, ".cotal", NATS_PIDFILE);
  const pin = verifyIdentityPin(path);
  const pid = publishedPid(path);
  const blocked = pin.kind !== "no-pid" && pin.kind !== "gone" && pin.kind !== "mismatch";
  // A journal with no listenerSpawn was written by an older release, which can have spawned without recording it.
  if (mark !== "not-started" && mark !== "started") return oldRecordRefusal(attemptId, why, blocked ? pid : undefined);
  if (mark === "not-started") return blocked ? livePidRefusal(attemptId, serverName, why, pin, pid) : undefined;
  if (pin.kind === "gone" || pin.kind === "mismatch") return undefined;
  if (pin.kind === "no-pid") return unpublishedRefusal(attemptId, serverName, why);
  return livePidRefusal(attemptId, serverName, why, pin, pid);
}

function unpublishedRefusal(attemptId: string, serverName: string, why: string): string {
  return `${prefix(attemptId, why)} No listener PID was published. Check whether ${listenerName(serverName)} is running. A closed port does not prove the listener is gone. This attempt does not start another listener without that proof; preserving recovery state`;
}

function livePidRefusal(attemptId: string, serverName: string, why: string, pin: PinVerdict, pid: number | undefined): string {
  if (pid === undefined) return unpublishedRefusal(attemptId, serverName, why);
  const identity = pin.kind === "match"
    ? `Published listener pid ${pid} matches the recorded creation time.`
    : `Published listener pid ${pid} is not proven dead. This host cannot tell a reused pid from the listener, so this refusal stays until that process ends.`;
  return `${prefix(attemptId, why)} It is ${listenerName(serverName)}. ${identity} Stop it if it is the restore listener, then run \`${displayCmd()} up\` again; preserving recovery state`;
}

function oldRecordRefusal(attemptId: string, why: string, pid: number | undefined): string {
  const recorded = pid === undefined ? "" : ` Published listener pid ${pid} is still recorded.`;
  return `${prefix(attemptId, why)}${recorded} This attempt's record does not say whether a listener was spawned. Check for a nats-server process whose --name starts with ${attemptId}. This attempt does not start another listener without proof that the earlier listener is gone; preserving recovery state`;
}
