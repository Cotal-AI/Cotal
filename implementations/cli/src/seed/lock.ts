import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { reconcileCursorPath, reconcileLockPath, readJsonFile, writeJsonAtomic } from "./paths.js";

/**
 * The reconcile-wide lock and the crash cursor.
 *
 * ONE lock guards a whole reconcile (not each `ext add` child) so an operator `ext add`/`remove`
 * cannot interleave between seed children and strand a half-applied refresh decision. It is
 * nonce-bearing and acquired atomically (O_EXCL): the nonce defeats PID reuse — a reclaimed lock
 * re-created by another process carries a different nonce, so our release only removes a lock still
 * ours. A dead owner (ESRCH) is reclaimed; a live one fails loud.
 *
 * The cursor is the SIGKILL floor: before each connector mutation the reconcile journals
 * `{nonce, package, phase}`, and clears it only after the stamp commits. A crash mid-reconcile
 * leaves the cursor behind, so the next boot's health preamble sees a partial reconcile and fails
 * loud (naming the package) instead of silently proceeding on a torn prefix.
 */

export interface ReconcileLock {
  readonly nonce: string;
  release(): void;
}

type LockOwner = { readonly pid: number; readonly nonce: string } | "absent" | "stale";

function inspectLock(path: string): LockOwner {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  let owner: { pid?: unknown; nonce?: unknown };
  try {
    owner = JSON.parse(raw);
  } catch {
    return "stale"; // a torn/empty lock file left by a crash between create and write
  }
  const pid = owner.pid;
  const nonce = owner.nonce;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof nonce !== "string") return "stale";
  try {
    process.kill(pid, 0);
    return { pid, nonce };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "stale";
    if (code === "EPERM") return { pid, nonce }; // owned by another user but alive
    throw e;
  }
}

/** Acquire the reconcile lock, reclaiming a dead owner's. Throws (loud) if a live reconcile holds it. */
export function acquireReconcileLock(): ReconcileLock {
  const path = reconcileLockPath();
  mkdirSync(dirname(path), { recursive: true });
  const nonce = randomBytes(12).toString("hex");
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = inspectLock(path);
      if (owner === "absent") continue; // raced with the owner's release
      if (owner === "stale") {
        rmSync(path, { force: true }); // dead owner — reclaim
        continue;
      }
      throw new Error(
        `another connector reconcile is in progress (pid ${owner.pid}) - retry once it finishes, or \`cotal ext seed --repair\` if it died`,
      );
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      nonce,
      release() {
        if (released) return;
        released = true;
        const owner = inspectLock(path);
        if (owner !== "absent" && owner !== "stale" && owner.nonce === nonce) rmSync(path, { force: true });
      },
    };
  }
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
