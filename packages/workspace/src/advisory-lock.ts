import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/**
 * A machine-local, crash-safe advisory file lock, shared by every serialized workstation mutation
 * (the `cotal ext` add/remove path, the built-in-connector seeding reconcile, and the materialize
 * read-side probe). One primitive so ownership, liveness, and reclaim are decided identically
 * everywhere.
 *
 * Correctness rests on two invariants that together defeat the empty-lock and reclaim-ABA races:
 *
 *  1. **No canonical lock is ever visible before its complete owner record.** The owner JSON is
 *     written to a unique temp file and `link()`ed onto the canonical path — an atomic create-if-absent
 *     that either publishes the fully-written record or fails `EEXIST`. There is no `mkdir`-then-write
 *     window a racer could misread as stale, and the canonical file is immutable once created (nobody
 *     rewrites it; it is only removed by a reclaimer).
 *  2. **Reclaim is serialized by a sentinel.** A stale lock is removed only by the process that first
 *     wins a `.reclaim` sentinel (same atomic `link` claim). While it holds the sentinel it re-checks
 *     the exact owner+inode and unlinks ONLY that generation, then releases. Because the canonical file
 *     blocks any new publish while it exists, no `inspect→unlink` can ever target a later generation,
 *     and two reclaimers can never both remove. A dead sentinel holder is fail-loud (manual cleanup),
 *     never a recursive unsafe reclaim.
 *
 * Liveness is the owner PID being alive AND, where the OS makes it cheap (Linux `/proc`, macOS/BSD
 * `ps`), its process-start token still matching. When the token is unobtainable the lock is treated as
 * active/unknown (bounded-wait → fail loud), NEVER reclaimed on the missing token alone; only a
 * PID-dead owner is reclaimable.
 */

/** The fully-written owner record published inside the canonical lock file. */
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

function readOwner(path: string): { owner?: LockOwner; ino?: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // A directory (EISDIR) or an unreadable file (EACCES/EPERM) where a lock file belongs is not a
    // holder we can reason about — fail loud fast, never busy-spin trying to reclaim it.
    if (code === "EISDIR" || code === "EACCES" || code === "EPERM")
      throw new Error(`advisory lock path ${path} is unreadable (${code}) - remove the stray file or directory there and retry`);
    throw e;
  }
  let ino: number | undefined;
  try {
    ino = statSync(path).ino;
  } catch {
    /* raced removal */
  }
  try {
    return { owner: JSON.parse(raw) as LockOwner, ino };
  } catch {
    return { ino }; // torn/legacy content
  }
}

/** Inspect a lock file: absent, stale (dead/aborted owner or torn record), or active with the owner. */
export function inspectLock(path: string): LockInspection {
  const found = readOwner(path);
  if (found === undefined) return { state: "absent" };
  const owner = found.owner;
  if (
    !owner ||
    typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== "string"
  ) {
    return { state: "stale" };
  }
  if (!pidAlive(owner.pid)) return { state: "stale" };
  // PID alive — but is it still the SAME process? A recorded start token that no longer matches means
  // the PID was recycled: the original owner is gone (stale). A token we simply cannot obtain is NOT
  // grounds to reclaim — the live PID keeps the lock active/unknown.
  if (owner.start !== undefined) {
    const now = processStartToken(owner.pid);
    if (now !== undefined && now !== owner.start) return { state: "stale" };
  }
  return { state: "active", owner };
}

/** Publish `content` at `path` iff nothing is there — atomic (temp write + hard link). Returns true on
 *  success, false if the path already exists. */
function publishAtomic(path: string, content: string): boolean {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/** Serialized reclaim of a stale canonical lock at `path`, via a `.reclaim` sentinel that only one
 *  reclaimer can hold. Under the sentinel the exact stale generation is re-confirmed and removed. A
 *  live sentinel is waited on; a dead sentinel holder fails loud (never a recursive unsafe reclaim). */
function reclaimStale(path: string, inspectedIno: number | undefined): void {
  const sentinel = `${path}.reclaim`;
  const mine = JSON.stringify({ pid: process.pid, start: processStartToken(process.pid), nonce: randomBytes(8).toString("hex"), ts: Date.now() });
  if (!publishAtomic(sentinel, mine)) {
    // Lost the sentinel race. Only a STALE (dead-owner) sentinel is fail-loud — a live one is a
    // reclaim in progress and an absent one is a reclaim that just finished; both mean "let the acquire
    // loop retry", never "proceed to unlink" (an EEXIST loser must not fall through to remove G1).
    if (inspectLock(sentinel).state === "stale")
      throw new Error(
        `a lock reclaim was interrupted and its sentinel remains (${sentinel}) - if no cotal process is running, remove it and retry`,
      );
    return; // active or absent — retry acquisition
  }
  try {
    // Under the sentinel the canonical file is immutable (publish is blocked while it exists), so a
    // re-inspect that is still stale AND the same inode is exactly the generation we set out to reclaim.
    const found = readOwner(path);
    if (found === undefined) return; // already gone
    const state = inspectLock(path).state;
    if (state === "active") return; // reacquired under us (should not happen while it exists) — leave it
    if (inspectedIno !== undefined && found.ino !== undefined && found.ino !== inspectedIno) return; // a different generation
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  } finally {
    try {
      unlinkSync(sentinel);
    } catch {
      /* released */
    }
  }
}

/**
 * Acquire the lock at `path`. Returns a handle whose {@link HeldLock.release} removes it (idempotent,
 * nonce-guarded). Reclaims a dead owner (serialized); waits up to `waitMs` on a live one, then throws.
 */
export function acquireLock(path: string, opts: AcquireOptions = {}): HeldLock {
  const waitMs = opts.waitMs ?? 300000;
  const pollMs = opts.pollMs ?? 200;
  mkdirSync(dirname(path), { recursive: true });
  const nonce = randomBytes(12).toString("hex");
  const owner: LockOwner = {
    pid: process.pid,
    start: processStartToken(process.pid),
    nonce,
    ts: Date.now(),
    ...(opts.label ? { label: opts.label } : {}),
  };
  const content = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + waitMs;

  for (;;) {
    if (publishAtomic(path, content)) {
      let released = false;
      return {
        nonce,
        release() {
          if (released) return;
          released = true;
          const found = readOwner(path);
          if (found?.owner?.nonce === nonce) {
            try {
              unlinkSync(path);
            } catch {
              /* already reclaimed */
            }
          }
        },
      };
    }
    // Held — inspect and either wait (live) or reclaim (dead).
    const found = readOwner(path);
    const inspection = inspectLock(path);
    if (inspection.state === "absent") continue; // raced with a release
    if (inspection.state === "stale") {
      reclaimStale(path, found?.ino);
      sleepSync(Math.min(pollMs, 50));
      continue;
    }
    if (Date.now() >= deadline) {
      throw (opts.onTimeout?.(inspection.owner)) ??
        new Error(
          `${opts.label ?? "a lock"} is held by a live process (pid ${inspection.owner.pid}) and did not release within ${Math.round(waitMs / 1000)}s - retry, or if it is wedged, remove ${path}`,
        );
    }
    sleepSync(pollMs);
  }
}

/** True when a live process currently holds the lock at `path` (used by read-side probes). */
export function lockIsActive(path: string): boolean {
  return inspectLock(path).state === "active";
}

/** The owning PID of a live lock at `path`, else undefined (used for diagnostics). */
export function liveLockOwnerPid(path: string): number | undefined {
  const found = inspectLock(path);
  return found.state === "active" ? found.owner.pid : undefined;
}

/** Force-remove a lock path and any reclaim sentinel (operator recovery for a wedged lock). */
export function breakLock(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.reclaim`, { force: true });
}
