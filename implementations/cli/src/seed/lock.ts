import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { acquireLock, inspectLock, processStartToken, type HeldLock } from "@cotal-ai/workspace";
import { SEED_BUILTINS, reconcileChildPath, reconcileCursorPath, reconcileLockPath, reconcileRecoveryPath, readJsonFile, writeJsonAtomic } from "./paths.js";

/**
 * The reconcile-wide lock and the crash cursor.
 *
 * ONE lock guards a whole reconcile (not each `ext add` child) so an operator `ext add`/`remove`
 * cannot interleave between seed children and strand a half-applied refresh decision. It rides the
 * shared crash-safe advisory-lock primitive (atomic link publish so a racer never sees a canonical
 * lock before its owner record; serialized reclaim so no inspect→remove targets a later generation;
 * PID + process-start liveness so a recycled PID isn't mistaken for the holder; a bounded wait on a
 * live holder rather than a false "interrupted"; nonce-guarded release).
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

/** The mid-reconcile journal: which package is being mutated, in which phase, under which lock nonce.
 *  `failed` is why the run that wrote it failed; a cursor without it was left by a run that stopped. */
export interface ReconcileCursor {
  readonly nonce: string;
  readonly package: string;
  readonly phase: "copy" | "add";
  readonly failed?: string;
}

export function writeCursor(cursor: ReconcileCursor): void {
  writeJsonAtomic(reconcileCursorPath(), cursor);
}

/** Record on the cursor the run under `nonce` wrote that the run failed, and why. A cursor another run
 *  left is kept as it is. */
export function markCursorFailed(nonce: string, reason: string): void {
  const cursor = readCursor();
  if (cursor?.nonce === nonce) writeCursor({ ...cursor, failed: reason });
}

/** Read + SCHEMA-validate the cursor: a torn write, or a parsed-but-malformed one (missing/invalid
 *  nonce, a non-official package, an unknown phase — e.g. `{}`) is corrupt, never a silent "no target"
 *  that lets a repair clear the journal and report success while a connector is still torn. */
export function readCursor(): ReconcileCursor | undefined {
  const cursor = readJsonFile<ReconcileCursor>(reconcileCursorPath());
  if (cursor === undefined) return undefined;
  if (
    typeof cursor.nonce !== "string" ||
    !SEED_BUILTINS.includes(cursor.package) ||
    (cursor.phase !== "copy" && cursor.phase !== "add") ||
    (cursor.failed !== undefined && typeof cursor.failed !== "string")
  ) {
    throw new Error(`corrupt seed cursor ${reconcileCursorPath()}: unexpected shape - repair with \`cotal ext seed --repair\` (or --reset)`);
  }
  return cursor;
}

export function clearCursor(): void {
  rmSync(reconcileCursorPath(), { force: true });
}

/**
 * A seed child's liveness marker. The PARENT records `pending` BEFORE it spawns (so the window never
 * opens ownerless); the CHILD upgrades it to `live` with its own PID + start token as its first act;
 * the parent clears it after the child exits. On Linux a dead parent's pending marker is stale only
 * after a process census finds no child carrying its unique seed nonce. Other platforms fail loud.
 */
export type ChildMarker =
  | { readonly state: "pending"; readonly parentPid: number; readonly parentStart?: string; readonly nonce: string; readonly ts: number }
  | { readonly state: "live"; readonly childPid: number; readonly childStart?: string; readonly parentPid: number; readonly parentStart?: string; readonly nonce: string; readonly ts: number };

/** Parent: record intent to spawn a seed child before `spawnSync`, so a crash never leaves a gap a
 *  concurrent repair could race through unaware. */
export function writePendingChildMarker(nonce: string): void {
  writeJsonAtomic(reconcileChildPath(), { state: "pending", parentPid: process.pid, parentStart: processStartToken(process.pid), nonce, ts: Date.now() });
}

/** Child: upgrade the parent's pending marker to a live one carrying this child's identity. */
export function markSeedChildLive(nonce: string, parentPid: number): void {
  writeJsonAtomic(reconcileChildPath(), {
    state: "live",
    childPid: process.pid,
    childStart: processStartToken(process.pid),
    parentPid,
    parentStart: readJsonFile<ChildMarker>(reconcileChildPath())?.parentStart,
    nonce,
    ts: Date.now(),
  });
}

export function clearChildMarker(): void {
  rmSync(reconcileChildPath(), { force: true });
}

export type SeedChildStatus =
  | { readonly kind: "none" }
  | { readonly kind: "stale" }
  | { readonly kind: "live"; readonly pid: number }
  | { readonly kind: "ambiguous"; readonly path: string };

/** Inspect the recorded process identities. Linux can also identify a not-yet-published child by
 * its inherited seed nonce. An unreadable census or malformed marker remains ambiguous. */
export function seedChildStatus(): SeedChildStatus {
  const path = reconcileChildPath();
  let marker: ChildMarker | undefined;
  try {
    marker = readJsonFile<ChildMarker>(path);
  } catch {
    return { kind: "ambiguous", path }; // corrupt marker — never silently ignore
  }
  if (!marker) return { kind: "none" };
  if (!Number.isInteger(marker.parentPid) || marker.parentPid <= 0 ||
      (marker.parentStart !== undefined && typeof marker.parentStart !== "string")) return { kind: "ambiguous", path };
  if (marker.state === "live") {
    if (typeof marker.childPid !== "number") return { kind: "ambiguous", path };
    if (pidAliveMatching(marker.parentPid, marker.parentStart)) return { kind: "live", pid: marker.parentPid };
    return pidAliveMatching(marker.childPid, marker.childStart) ? { kind: "live", pid: marker.childPid } : { kind: "none" };
  }
  if (marker.state === "pending" && typeof marker.parentPid === "number") {
    if (pidAliveMatching(marker.parentPid, marker.parentStart)) return { kind: "live", pid: marker.parentPid };
    // Before ext add publishes its PID, the re-exec still carries the parent's unique nonce.
    // Inspect that identity, not elapsed time or a process name. Unknown custody stays fail-loud.
    if (process.platform !== "linux" || typeof marker.nonce !== "string" || !marker.nonce) return { kind: "ambiguous", path };
    try {
      const ancestors = new Set<number>();
      let ancestor = process.pid;
      while (ancestor > 0 && !ancestors.has(ancestor)) {
        ancestors.add(ancestor);
        const status = readFileSync(`/proc/${ancestor}/status`, "utf8");
        ancestor = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      }
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry) || ancestors.has(Number(entry))) continue;
        const started = processStartToken(Number(entry));
        if (marker.parentStart && /^\d+$/.test(marker.parentStart) && started &&
            /^\d+$/.test(started) && BigInt(started) < BigInt(marker.parentStart)) continue;
        try {
          const env = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
          if (env.includes(`COTAL_EXT_SEEDING=${marker.nonce}`)) return { kind: "live", pid: Number(entry) };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ESRCH" && code !== "EACCES" && code !== "EPERM") throw error;
          // Other users cannot inherit this private seed child's environment.
          if (code === "EACCES" || code === "EPERM") {
            const status = readFileSync(`/proc/${entry}/status`, "utf8");
            // A changed real/effective/saved UID is a privileged session, not an inherited
            // unprivileged npm child. Same-identity processes must remain inspectable.
            const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status)?.slice(1);
            if (!ids || (ids.every((id) => id === String(process.getuid?.())) &&
                !/^Kthread:\s+1$/m.test(status))) return { kind: "ambiguous", path };
          }
        }
      }
      return { kind: "stale" };
    } catch {
      return { kind: "ambiguous", path };
    }
  }
  return { kind: "ambiguous", path };
}

function pidAliveMatching(pid: number, start: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM ⇒ alive under another user; fall through to the start-token check.
  }
  if (start !== undefined) {
    const now = processStartToken(pid);
    if (now !== undefined && now !== start) return false; // recycled PID
  }
  return true;
}

/**
 * The durable maintenance-recovery obligation. A `--repair`/`--reset` writes it BEFORE it
 * destructively quarantines a corrupt manifest/cursor, and clears it only at the final commit — so a
 * SIGKILL after the quarantine but before the reinstalls is not forgotten: the next boot fails loud
 * and the next repair re-derives the same obligation (rebuild the built-ins from on-disk truth, and/or
 * reinstall+verify every seeded built-in) instead of stamping success over missing connectors.
 */
export interface RecoveryObligation {
  readonly rebuildFromDisk?: boolean;
  readonly repairAllSeeded?: boolean;
}

export function writeRecovery(obligation: RecoveryObligation): void {
  writeJsonAtomic(reconcileRecoveryPath(), obligation);
}

/** Read + SCHEMA-validate the recovery obligation. A parsed-but-malformed marker (`{}`, `null`, an
 *  array, non-boolean fields, or an all-false obligation the writer never emits) is CORRUPT, not an
 *  empty valid obligation — it must throw so `recoveryPending()` stays true and maintenance recovers
 *  conservatively, never silently clearing the journal over still-damaged state. */
export function readRecovery(): RecoveryObligation | undefined {
  const recovery = readJsonFile<RecoveryObligation>(reconcileRecoveryPath());
  if (recovery === undefined) return undefined;
  const shapeOk =
    typeof recovery === "object" &&
    recovery !== null &&
    !Array.isArray(recovery) &&
    (recovery.rebuildFromDisk === undefined || typeof recovery.rebuildFromDisk === "boolean") &&
    (recovery.repairAllSeeded === undefined || typeof recovery.repairAllSeeded === "boolean");
  if (!shapeOk || !(recovery.rebuildFromDisk === true || recovery.repairAllSeeded === true)) {
    throw new Error(
      `corrupt recovery journal ${reconcileRecoveryPath()}: expected { rebuildFromDisk?/repairAllSeeded?: boolean, at least one true } - repair with \`cotal ext seed --repair\` (or --reset)`,
    );
  }
  return recovery;
}

/** True iff a recovery obligation is outstanding (any read failure counts — never silently ignored). */
export function recoveryPending(): boolean {
  try {
    return readRecovery() !== undefined;
  } catch {
    return true;
  }
}

export function clearRecovery(): void {
  rmSync(reconcileRecoveryPath(), { force: true });
}

/** Quarantine a CORRUPT (unparseable) crash CURSOR aside, so a `--repair`/`--reset` read of it can't
 *  wedge. The cursor is a journal, not a liveness signal, so moving it aside is safe; a corrupt CHILD
 *  MARKER is deliberately NOT touched here — it is resolved by {@link seedChildStatus}'s fail-loud
 *  (a marker we can't read might mean an installer is running). Returns the quarantine path(s). */
export function sanitizeCorruptCrashState(): string[] {
  const aside: string[] = [];
  const path = reconcileCursorPath();
  if (existsSync(path)) {
    try {
      readCursor(); // schema-validating read: catches torn JSON AND parsed-but-malformed (e.g. `{}`)
    } catch {
      const dest = `${path}.corrupt.${randomBytes(4).toString("hex")}`;
      renameSync(path, dest);
      aside.push(dest);
    }
  }
  return aside;
}
