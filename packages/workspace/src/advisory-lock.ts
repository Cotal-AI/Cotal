import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * A machine-local, crash-safe advisory file lock, shared by every serialized workstation mutation
 * (the `cotal ext` add/remove path, the built-in-connector seeding reconcile, and the materialize
 * read-side probe). One primitive so ownership, liveness, and reclaim are decided identically
 * everywhere.
 *
 * The lock is a DIRECTORY (`mkdir` is the portable atomic create-exclusive — no empty-file window a
 * racer could misread as stale), with the fully-written owner record in `owner.json` beside it
 * (temp-then-rename, so a reader never sees a half-written owner). Liveness is the owner PID being
 * alive AND, where the OS makes it cheap (Linux `/proc`, macOS/BSD `ps`), its process-start token
 * still matching — so a PID reused by an unrelated process is NOT mistaken for the original holder.
 * A dead owner is reclaimed; a live one is waited on up to a bound, then fails loud (never a silent
 * infinite deadlock, and never a stolen active lock). Release removes the lock only while it still
 * carries our nonce, so a lock reclaimed out from under us is never deleted by our own release.
 */

/** The fully-written owner record published inside the lock dir. */
export interface LockOwner {
  readonly pid: number;
  /** Best-effort process-start token (PID-reuse guard); absent where the OS makes it unobtainable. */
  readonly start?: string;
  /** Per-acquire nonce: release only removes a lock still carrying it (defeats reclaim-then-release). */
  readonly nonce: string;
  /** Acquire time (epoch ms) — diagnostic. */
  readonly ts: number;
  /** Human label naming the holder in contention errors (e.g. "connector reconcile"). */
  readonly label?: string;
}

export type LockInspection =
  | { readonly state: "absent" }
  | { readonly state: "stale" }
  | { readonly state: "active"; readonly owner: LockOwner };

export interface HeldLock {
  readonly nonce: string;
  release(): void;
}

export interface AcquireOptions {
  /** Naming the holder in a contention error. */
  readonly label?: string;
  /** Max ms to wait on a live holder before failing loud (default 300000). */
  readonly waitMs?: number;
  /** Poll interval while waiting (default 200). */
  readonly pollMs?: number;
  /** The loud error thrown when the wait bound elapses with the lock still live-held. */
  readonly onTimeout?: (owner: LockOwner) => Error;
}

const OWNER_FILE = "owner.json";
/** How long a dir-exists-but-owner-absent state is tolerated as a mid-acquire window before it is
 *  judged a crash between `mkdir` and the owner write (→ stale, reclaim). */
const ACQUIRE_GRACE_MS = 1500;

function ownerPath(dir: string): string {
  return join(dir, OWNER_FILE);
}

/** A best-effort, OS-cheap process-start token used ONLY to detect PID reuse. Undefined ⇒ the check
 *  is skipped for that platform and the bounded wait is the sole backstop (never a hard dependency). */
export function processStartToken(pid: number): string | undefined {
  try {
    // Linux: /proc/<pid>/stat field 22 (starttime). comm (field 2) may hold spaces/parens, so parse
    // after the final ')': the remainder begins at field 3 (state), so starttime is index 19.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after >= 0) {
      const token = stat.slice(after + 2).split(" ")[19];
      if (token) return token;
    }
  } catch {
    /* not Linux, or the process is gone — fall through */
  }
  try {
    // macOS/BSD: the process start date is stable for the life of the PID.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Sleep synchronously without spawning a process (safe inside a sync acquire loop). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // another user's live process
    throw e;
  }
}

/** Inspect a lock dir: absent, stale (dead/aborted owner), or active with the live owner record. */
export function inspectLock(dir: string): LockInspection {
  let raw: string;
  try {
    raw = readFileSync(ownerPath(dir), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT: no owner file (no lock, or a dir mid-acquire / crashed between mkdir and the owner
    // write). ENOTDIR: the lock path is a plain file — a legacy or torn lock — reclaim it.
    if (code === "ENOENT" || code === "ENOTDIR") {
      let pathExists = true;
      try {
        statSync(dir);
      } catch (se) {
        if ((se as NodeJS.ErrnoException).code === "ENOENT") pathExists = false;
      }
      return pathExists ? { state: "stale" } : { state: "absent" };
    }
    throw e;
  }
  let owner: LockOwner;
  try {
    owner = JSON.parse(raw) as LockOwner;
  } catch {
    return { state: "stale" }; // torn owner record
  }
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== "string") {
    return { state: "stale" };
  }
  if (!pidAlive(owner.pid)) return { state: "stale" };
  // PID is alive — but is it still the SAME process? A recorded start token that no longer matches
  // means the PID was recycled: the original owner is gone (stale), not this unrelated process.
  if (owner.start !== undefined) {
    const now = processStartToken(owner.pid);
    if (now !== undefined && now !== owner.start) return { state: "stale" };
  }
  return { state: "active", owner };
}

function writeOwner(dir: string, owner: LockOwner): void {
  const tmp = join(dir, `.${OWNER_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, ownerPath(dir));
}

/** Reclaim a lock judged stale, but re-confirm the owner is still not live right before removal — so
 *  a reclaimer never deletes a lock another racer has meanwhile reacquired. */
function reclaimStale(dir: string): void {
  if (inspectLock(dir).state === "active") return; // someone reacquired — do not remove a live lock
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Acquire the lock at `dir`. Returns a handle whose {@link HeldLock.release} removes it (idempotent,
 * nonce-guarded). Reclaims a dead owner; waits up to `waitMs` on a live one, then throws.
 */
export function acquireLock(dir: string, opts: AcquireOptions = {}): HeldLock {
  const waitMs = opts.waitMs ?? 300000;
  const pollMs = opts.pollMs ?? 200;
  mkdirSync(dirname(dir), { recursive: true });
  const nonce = randomBytes(12).toString("hex");
  const owner: LockOwner = {
    pid: process.pid,
    start: processStartToken(process.pid),
    nonce,
    ts: Date.now(),
    ...(opts.label ? { label: opts.label } : {}),
  };

  const deadline = Date.now() + waitMs;
  let graceUntil = 0;
  for (;;) {
    try {
      mkdirSync(dir); // atomic create-exclusive: EEXIST ⇒ already held
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const found = inspectLock(dir);
      if (found.state === "absent") continue; // raced with the holder's release
      if (found.state === "stale") {
        // A dir-without-owner may be a live holder mid-acquire; tolerate it briefly before reclaiming.
        const ownerMissing = readOwnerRaw(dir) === undefined;
        if (ownerMissing) {
          if (graceUntil === 0) graceUntil = Date.now() + ACQUIRE_GRACE_MS;
          if (Date.now() < graceUntil) {
            sleepSync(Math.min(pollMs, 100));
            continue;
          }
        }
        reclaimStale(dir);
        graceUntil = 0;
        continue;
      }
      // Live holder — wait up to the bound, then fail loud.
      if (Date.now() >= deadline) {
        throw (opts.onTimeout?.(found.owner)) ??
          new Error(
            `${opts.label ?? "a lock"} is held by a live process (pid ${found.owner.pid}) and did not release within ${Math.round(waitMs / 1000)}s - retry, or if it is wedged, remove ${dir}`,
          );
      }
      sleepSync(pollMs);
      continue;
    }
    // We created the dir — publish our fully-written owner record before returning.
    try {
      writeOwner(dir, owner);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    let released = false;
    return {
      nonce,
      release() {
        if (released) return;
        released = true;
        const raw = readOwnerRaw(dir);
        if (raw === undefined) return; // already reclaimed
        try {
          if ((JSON.parse(raw) as LockOwner).nonce === nonce) rmSync(dir, { recursive: true, force: true });
        } catch {
          /* torn/foreign owner — not ours to remove */
        }
      },
    };
  }
}

function readOwnerRaw(dir: string): string | undefined {
  try {
    return readFileSync(ownerPath(dir), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** True when a live process currently holds the lock at `dir` (used by read-side probes). */
export function lockIsActive(dir: string): boolean {
  return inspectLock(dir).state === "active";
}

/** The owning PID of a live lock at `dir`, else undefined (used for diagnostics). */
export function liveLockOwnerPid(dir: string): number | undefined {
  const found = inspectLock(dir);
  return found.state === "active" ? found.owner.pid : undefined;
}
