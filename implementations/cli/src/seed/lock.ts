import { rmSync } from "node:fs";
import { acquireLock, inspectLock, processStartToken, type HeldLock } from "@cotal-ai/workspace";
import { reconcileChildPath, reconcileCursorPath, reconcileLockPath, readJsonFile, writeJsonAtomic } from "./paths.js";

/**
 * The reconcile-wide lock and the crash cursor.
 *
 * ONE lock guards a whole reconcile (not each `ext add` child) so an operator `ext add`/`remove`
 * cannot interleave between seed children and strand a half-applied refresh decision. It rides the
 * shared crash-safe advisory-lock primitive (atomic `mkdir` publish so a racer never misreads an
 * empty file as stale; PID + process-start liveness so a recycled PID isn't mistaken for the holder;
 * a bounded wait on a live holder rather than a false "interrupted"; nonce-guarded release).
 *
 * The cursor is the SIGKILL floor: before each connector mutation the reconcile journals
 * `{nonce, package, phase}`, and clears it only after the stamp commits. A crash mid-reconcile leaves
 * the cursor behind; the next boot distinguishes a LIVE reconcile (lock still actively held → wait)
 * from a DEAD one (lock stale + cursor present → fail loud, `--repair`).
 */

export interface ReconcileLock {
  readonly nonce: string;
  release(): void;
}

/** Acquire the reconcile lock, waiting (bounded) on a live reconcile and reclaiming a dead owner's.
 *  A reconcile installs four connectors via npm, so the wait bound is generous. */
export function acquireReconcileLock(): ReconcileLock {
  const held: HeldLock = acquireLock(reconcileLockPath(), {
    label: "a connector reconcile",
    waitMs: 300000,
    onTimeout: (owner) =>
      new Error(
        `another connector reconcile has held the lock for over 5 minutes (pid ${owner.pid}) - retry once it finishes, or \`cotal ext seed --repair\` if it is wedged`,
      ),
  });
  return { nonce: held.nonce, release: () => held.release() };
}

/** True while a LIVE process holds the reconcile lock (distinguishes an in-flight reconcile from a
 *  crashed one when a cursor is present). */
export function reconcileLockActive(): boolean {
  return inspectLock(reconcileLockPath()).state === "active";
}

/**
 * True iff THIS process is a genuine seed child: it carries `COTAL_EXT_SEEDING=<nonce>` +
 * `COTAL_EXT_SEEDING_PARENT=<pid>`, and a LIVE reconcile actually holds the lock under exactly that
 * PID and nonce. A user cannot forge this to skip the mutation lock for an arbitrary `ext add` — the
 * bare-`=1` bypass is gone; the marker must match the live lock the parent published.
 */
export function isAuthenticSeedChild(): boolean {
  const nonce = process.env.COTAL_EXT_SEEDING;
  const parent = Number(process.env.COTAL_EXT_SEEDING_PARENT);
  if (!nonce || nonce === "1" || !Number.isInteger(parent) || parent <= 0) return false;
  const found = inspectLock(reconcileLockPath());
  return found.state === "active" && found.owner.pid === parent && found.owner.nonce === nonce;
}

/** The mid-reconcile journal: which package is being mutated, in which phase, under which lock nonce. */
export interface ReconcileCursor {
  readonly nonce: string;
  readonly package: string;
  readonly phase: "copy" | "add";
}

export function writeCursor(cursor: ReconcileCursor): void {
  writeJsonAtomic(reconcileCursorPath(), cursor);
}

export function readCursor(): ReconcileCursor | undefined {
  return readJsonFile<ReconcileCursor>(reconcileCursorPath());
}

export function clearCursor(): void {
  rmSync(reconcileCursorPath(), { force: true });
}

/** A seed child's liveness marker: its PID + process-start token, written before it mutates. */
export interface ChildMarker {
  readonly pid: number;
  readonly start?: string;
  readonly ts: number;
}

export function writeChildMarker(): void {
  writeJsonAtomic(reconcileChildPath(), { pid: process.pid, start: processStartToken(process.pid), ts: Date.now() });
}

export function clearChildMarker(): void {
  rmSync(reconcileChildPath(), { force: true });
}

/** The PID of a still-alive seed child (parent SIGKILL'd mid-install → orphan), else undefined. A
 *  reused PID is NOT treated as the child: the recorded start token must still match. */
export function liveSeedChildPid(): number | undefined {
  const marker = readJsonFile<ChildMarker>(reconcileChildPath());
  if (!marker || typeof marker.pid !== "number") return undefined;
  try {
    process.kill(marker.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    // EPERM ⇒ alive under another user; fall through to the start-token check.
  }
  if (marker.start !== undefined) {
    const now = processStartToken(marker.pid);
    if (now !== undefined && now !== marker.start) return undefined; // recycled PID
  }
  return marker.pid;
}
