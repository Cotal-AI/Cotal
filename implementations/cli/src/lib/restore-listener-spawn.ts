import {
  NATS_PIDFILE,
  acquireMaintenanceLock,
  parsePid,
  readMaintenanceJournal,
  readPidfile,
  releaseMaintenanceLock,
  setRestoreListenerSpawn,
  verifyIdentityPin,
  type MaintenanceLock,
  type PinVerdict,
} from "@cotal-ai/workspace";
import { displayCmd } from "./self-exec.js";
import { cotalPath } from "./paths.js";

/**
 * Sync the unbound restore's spawn mark. A start that is not an unbound restore is left untouched.
 * The maintenance lock is not re-entrant. A caller that already holds it passes that lock; acquiring
 * another would see this process as the live owner and refuse.
 */
export function recordRestoreListenerSpawn(
  root: string,
  listenerSpawn: "not-started" | "started",
  heldLock?: MaintenanceLock,
): void {
  const current = readMaintenanceJournal(root);
  if (!current || current.state !== "commit-intent" || !("restore" in current) || current.listenerProof) return;
  if (current.launch.listenerSpawn === listenerSpawn) return;
  const lock = heldLock ?? acquireMaintenanceLock(root);
  try {
    setRestoreListenerSpawn(lock, listenerSpawn);
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

/** Spawn after `started` is durable. If the spawn itself throws, no listener exists, so the mark is cleared. */
export function spawnMarkedListener<T>(root: string, marked: boolean, spawn: () => T, heldLock?: MaintenanceLock): T {
  if (marked) recordRestoreListenerSpawn(root, "started", heldLock);
  try {
    return spawn();
  } catch (error) {
    if (marked) recordRestoreListenerSpawn(root, "not-started", heldLock);
    throw error;
  }
}

/** Stop the child before it can listen. The smoke exit that follows publishes no pid. */
export function freezeSmokeRestoreListener(child: { pid?: number | undefined }): void {
  if (process.env.COTAL_SMOKE_EXIT_BEFORE_RESTORE_LISTENER_PID !== "1" || process.platform === "win32") return;
  if (child.pid === undefined) return;
  try { process.kill(child.pid, "SIGSTOP"); } catch { /* the child has already exited */ }
}

function listenerSpawnMark(root: string): string | undefined {
  const journal = readMaintenanceJournal(root);
  if (!journal || !("restore" in journal) || !("launch" in journal)) return undefined;
  const value = journal.launch.listenerSpawn;
  return typeof value === "string" ? value : undefined;
}

function publishedPid(): number | undefined {
  const text = readPidfile(cotalPath(NATS_PIDFILE));
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
  const mark = listenerSpawnMark(root);
  const pin = verifyIdentityPin(cotalPath(NATS_PIDFILE));
  const blocked = pin.kind !== "no-pid" && pin.kind !== "gone" && pin.kind !== "mismatch";
  // A journal with no listenerSpawn was written by an older release, which can have spawned without recording it.
  if (mark !== "not-started" && mark !== "started") return oldRecordRefusal(attemptId, serverName, why, blocked ? publishedPid() : undefined);
  if (mark === "not-started") return blocked ? livePidRefusal(attemptId, serverName, why, pin) : undefined;
  if (pin.kind === "gone" || pin.kind === "mismatch") return undefined;
  if (pin.kind === "no-pid") return unpublishedRefusal(attemptId, serverName, why);
  return livePidRefusal(attemptId, serverName, why, pin);
}

function unpublishedRefusal(attemptId: string, serverName: string, why: string): string {
  return `${prefix(attemptId, why)} A listener may already be opening this store. It is ${listenerName(serverName)}. Stop that process if it is running. This attempt does not start another listener while it cannot show that one is gone; preserving recovery state`;
}

function livePidRefusal(attemptId: string, serverName: string, why: string, pin: PinVerdict): string {
  const pid = publishedPid();
  if (pid === undefined) return unpublishedRefusal(attemptId, serverName, why);
  const identity = pin.kind === "match"
    ? `Published listener pid ${pid} matches the recorded creation time.`
    : `Published listener pid ${pid} is not proven dead. This host cannot tell a reused pid from the listener, so this refusal stays until that process ends.`;
  return `${prefix(attemptId, why)} It is ${listenerName(serverName)}. ${identity} Stop it if it is the restore listener, then run \`${displayCmd()} up\` again; preserving recovery state`;
}

function oldRecordRefusal(attemptId: string, serverName: string, why: string, pid: number | undefined): string {
  const recorded = pid === undefined ? "" : ` Published listener pid ${pid} is still recorded.`;
  return `${prefix(attemptId, why)}${recorded} This attempt's record does not say whether a listener was spawned, so this attempt does not start one. A listener would be ${listenerName(serverName)}. Stop that process if it is running; preserving recovery state`;
}
