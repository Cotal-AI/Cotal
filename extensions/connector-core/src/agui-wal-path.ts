/**
 * Where a principal's event WAL lives on disk, and making that location durable before it is used.
 *
 * The layout is fixed, and `resolveEventWalPath` below is the only place it is spelled:
 *
 * ```
 * <workspaceRoot>/.cotal/events/<h(space)>/<h(principal)>/
 *     .lock                       one emitter per PRINCIPAL (not per thread), HELD not computed
 *     <h(threadId)>/wal.json      ONE file per thread, atomically replaced
 * ```
 *
 * **`.lock` IS ACQUIRED, AND THE WORD "HELD" ABOVE IS THERE BECAUSE IT ONCE WAS NOT.** This comment
 * claimed single-emitter exclusion from the day it was written while `lockPath` was only computed:
 * no acquire anywhere, and the suites asserted the path's SHAPE rather than that anyone held it. A
 * reviewer opened two logs on one file and watched the second one's stale handle rewrite the first
 * one's folded frontier to a tip the broker never assigned. {@link acquirePrincipalLock} is the
 * exclusion; the generation guard in `EventWal.write` is what refuses the stale write itself. Both,
 * because a lock cannot see a handle that predates it and a generation cannot tell an operator that
 * a second emitter is already running.
 *
 * **Every path component is hashed, and none of the unhashed values is a trusted path component.**
 * A space, a principal key and a native session id all come from outside this process, and a
 * sanitiser that has to stay correct is a worse guard than a shape that cannot express traversal at
 * all. Hashing makes containment STRUCTURAL. It does not make the location self-describing, which is
 * why {@link EventWal} stores the unhashed `{space, principal, threadId}` tuple inside the document
 * and refuses one that disagrees: the hash keeps a hostile value from escaping the tree, and the
 * stored tuple turns a collision or a mis-resolved directory into a loud mismatch instead of one
 * thread's frontier being adopted as another's.
 *
 * **This module does no policy.** It does not decide whether events are on, whether a root was
 * threaded, or what to do when one was not; those are the connector's decisions and live at its
 * launch site, where a missing root can still fail loud with something a human can act on.
 */
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { ensureDirNoSymlink } from "@cotal-ai/core";
import { openExclusiveNoFollow } from "./event-wal.js";

/**
 * Thrown when a session that is going to publish events cannot say where its WAL belongs.
 *
 * A distinct type rather than a bare `Error` so a caller can tell "misconfigured launch" from
 * "filesystem said no" without matching on message text.
 */
export class EventsStateRootMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventsStateRootMissing";
  }
}

/**
 * The state root for an events-enabled session, or a loud failure.
 *
 * **THE FAILURE THIS PREVENTS IS SILENT, WHICH IS WHY IT IS A THROW AND NOT A DEFAULT.** The
 * tempting fallback is `process.cwd()`. A WAL written there is not an error anyone sees: the emitter
 * starts, frames publish, and the durable state that makes a restart safe sits in whatever directory
 * the launch happened to begin in — a per-agent working directory that "can point at any repo". The
 * next start resolves the real root, finds no WAL, and reads an already-published thread as VIRGIN:
 * `E := 0`, a fresh epoch, a second frame claiming a sequence the stream has already seen. Nothing
 * reports a problem at any point, and an absence is what a clean board looks like.
 *
 * `env` is a PARAMETER and the root resolves PER CALL. A module-level read would freeze whatever the
 * environment was at first import, and none of what this path is keyed on — space, principal,
 * thread — is process-wide.
 */
export function resolveEventsStateRoot(env: { COTAL_WORKSPACE_ROOT?: string | undefined }): string {
  const root = env.COTAL_WORKSPACE_ROOT;
  if (typeof root !== "string" || root.trim() === "")
    throw new EventsStateRootMissing(
      "events are enabled for this session but COTAL_WORKSPACE_ROOT is not set, so there is nowhere " +
        "to put the event write-ahead log. The launcher forwards it from LaunchOpts.workspaceRoot; a " +
        "session started outside a manager has no workspace root and must not publish events. " +
        "Refusing rather than defaulting to the working directory, which would put the WAL somewhere " +
        "no later start looks.",
    );
  return root;
}

/**
 * One path component from one untrusted value.
 *
 * 16 hex characters of SHA-256, matching the width the channel mapping and the source cursor
 * already use. The width is a containment and collision property, not a secrecy one — nothing here
 * is trying to hide a space name from someone holding the directory.
 */
function h(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The resolved locations for one `(space, principal, threadId)`. Pure: computes, touches nothing. */
export interface EventWalLocation {
  /** `<workspaceRoot>/.cotal/events/<h(space)>/<h(principal)>` — the lock's directory. */
  principalDir: string;
  /** The single-emitter-per-principal lock. One emitter per PRINCIPAL, not per thread. */
  lockPath: string;
  /** `<principalDir>/subject.json` — the PRINCIPAL-scoped subject frontier, shared by every thread
   *  of this principal because the subject is. Declared here so the layout has one owner. */
  subjectPath: string;
  /** `<principalDir>/<h(threadId)>` — the directory holding exactly one `wal.json`. */
  threadDir: string;
  /** The WAL document itself. */
  walPath: string;
}

/** What {@link ensureEventWalDir} returns: the location, plus the lock it actually took for it. */
export interface HeldEventWalLocation extends EventWalLocation {
  lock: PrincipalLock;
}

/**
 * Resolve where this principal's WAL for this thread lives. Pure — no IO, no side effects.
 *
 * `workspaceRoot` is taken as given rather than defaulted. A default here would be a silent fallback
 * onto whatever directory the process happened to start in, which is precisely the scattering the
 * root exists to prevent; the caller that cannot resolve one must fail loud instead.
 */
export function eventWalLocation(opts: {
  workspaceRoot: string;
  space: string;
  principal: string;
  threadId: string;
}): EventWalLocation {
  const principalDir = join(opts.workspaceRoot, ".cotal", "events", h(opts.space), h(opts.principal));
  const threadDir = join(principalDir, h(opts.threadId));
  return {
    principalDir,
    lockPath: join(principalDir, ".lock"),
    subjectPath: join(principalDir, "subject.json"),
    threadDir,
    walPath: join(threadDir, "wal.json"),
  };
}

/** Every refusal on the lock path is one of these, so a caller never mistakes it for an I/O blip. */
export class PrincipalLockError extends Error {
  constructor(readonly path: string, readonly invariant: string, detail: string) {
    super(`event WAL principal lock at ${path} (${invariant}): ${detail}`);
    this.name = "PrincipalLockError";
  }
}

/** A HELD lock. It exists as an object only while this process owns the file. */
export interface PrincipalLock {
  readonly path: string;
  /** Close the handle and remove the file. Idempotent: releasing twice is not an error. */
  release(): Promise<void>;
}

/**
 * Locks this process holds, keyed by path.
 *
 * **Acquiring the same principal's lock twice IN THIS PROCESS returns the SAME lock rather than
 * refusing**, and that is a decision, not an oversight. The lock is per PRINCIPAL while the WAL
 * directory chain is per THREAD, so a session that moves from one thread to the next under one
 * principal calls {@link ensureEventWalDir} again — and the documented shape is one emitter per
 * principal, one thread at a time. Refusing there would break the sequencing the design asks for.
 * What that leaves uncovered inside one process, two `EventWal` objects open on one file, is not
 * covered by a lock at all: it is refused on the write path by the generation guard in
 * `EventWal.write`, which is where it has to be refused anyway, because a lock cannot see a stale
 * handle that already holds it.
 */
const held = new Map<string, PrincipalLock>();

/** Alive means "this pid resolves to a process", INCLUDING one this user may not signal. `EPERM` is
 *  a live process owned by somebody else, and reading it as dead would reclaim a held lock. */
function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Create the lock file exclusively, or report that somebody already holds it. Never adopts. */
async function createLockFile(path: string): Promise<FileHandle | undefined> {
  try {
    return await openExclusiveNoFollow(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
}

/**
 * Remove a lock whose owner is PROVABLY gone, or refuse.
 *
 * **A CRASH MUST NOT WEDGE THE PRINCIPAL FOREVER, AND A RECLAIM MUST NOT BE A GUESS.** An emitter
 * that dies leaves its lock file behind; a lock that is never reclaimable turns one crash into a
 * permanently unstartable principal, which is a worse failure than the one the lock prevents. So a
 * reclaim is allowed, and it is fenced on three refusals rather than on optimism:
 *
 *  - an unreadable or unowned record is refused outright, never reclaimed. A file we cannot read is
 *    not evidence that nobody holds it.
 *  - a record naming ANOTHER HOST is refused: this process cannot observe liveness on a machine it
 *    is not running on, and a shared filesystem is exactly where guessing would be wrong.
 *  - a record naming a LIVE pid on this host is refused, which is the ordinary "already running"
 *    answer an operator needs to see.
 *
 * The residual is pid reuse: a dead owner's pid can be re-issued to an unrelated process, so
 * liveness is evidence and not proof. That residual is bounded rather than argued away, because the
 * generation guard on the WAL's write path refuses a stale writer's clobber whether or not the lock
 * was judged correctly. The lock decides who STARTS; the generation guard decides who may WRITE.
 */
async function reclaimIfOwnerIsGone(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    // Gone between the failed create and this read: somebody released it. The create that follows
    // is what decides, and it decides by trying, not by assuming.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new PrincipalLockError(path, "the lock names its owner", "the file is not readable JSON, so its owner cannot be checked; refusing rather than reclaiming a lock that may be held");
  }
  const r = record as { pid?: unknown; host?: unknown };
  if (!Number.isSafeInteger(r.pid) || (r.pid as number) <= 0 || typeof r.host !== "string" || r.host.length === 0)
    throw new PrincipalLockError(path, "the lock names its owner", `the record carries pid=${String(r.pid)} host=${String(r.host)}, which names nobody checkable`);

  const here = hostname();
  if (r.host !== here)
    throw new PrincipalLockError(path, "the recorded owner is on THIS host", `held by pid ${r.pid} on ${r.host} while this process runs on ${here}; liveness on another machine is not observable from here`);
  if (ownerIsAlive(r.pid as number))
    throw new PrincipalLockError(path, "the recorded owner is gone", `pid ${r.pid} on ${here} is still running and holds this principal's emitter`);

  // The owner is gone. Removing the file is the reclaim; whether THIS process gets the lock is
  // decided by the exclusive create that follows, so a second reclaimer racing here loses there.
  await unlink(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}

/**
 * Take this principal's lock and HOLD IT for the life of the process.
 *
 * The handle stays open deliberately. A lock released at the end of the acquiring function is a
 * lock that was never held, and the layout comment above has claimed single-emitter exclusion since
 * this module was written while `lockPath` was only ever COMPUTED — a path in a struct standing in
 * for a guarantee. This is that claim made real.
 */
export async function acquirePrincipalLock(lockPath: string): Promise<PrincipalLock> {
  const already = held.get(lockPath);
  if (already) return already;

  let fh = await createLockFile(lockPath);
  if (fh === undefined) {
    await reclaimIfOwnerIsGone(lockPath);
    fh = await createLockFile(lockPath);
    if (fh === undefined)
      throw new PrincipalLockError(lockPath, "the reclaimed lock is free when this process takes it", "another process created the lock between the reclaim and this open, and now holds this principal");
  }

  const record = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), acquiredAt: new Date().toISOString() });
  try {
    await fh.writeFile(record, "utf8");
    await fh.sync();
  } catch (e) {
    // A lock whose record never landed names nobody, and the refusals above would then refuse every
    // later start rather than reclaim it. Undo the create before rethrowing.
    await fh.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw e;
  }

  const lock: PrincipalLock = {
    path: lockPath,
    async release(): Promise<void> {
      if (held.get(lockPath) !== lock) return;
      held.delete(lockPath);
      await fh.close().catch(() => {});
      await unlink(lockPath).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
  };
  held.set(lockPath, lock);
  return lock;
}

/**
 * `fsync` one directory, so its own entries are durable.
 *
 * Opened read-only: fsync on a directory handle is the portable way to flush the entries, and a
 * directory cannot be opened for writing anyway. `EBADF`/`EINVAL`/`EPERM` are TOLERATED rather than
 * fatal — some filesystems refuse to fsync a directory handle at all, and failing an emitter start
 * on a platform that simply does not offer the guarantee would trade a durability improvement for
 * an availability regression. Every other error propagates.
 */
export async function fsyncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, "r");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return;
    throw e;
  }
  try {
    await fh.sync();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EBADF" && code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") throw e;
  } finally {
    await fh.close();
  }
}

/**
 * Create the directory chain for a thread's WAL and make it durable: **once, before the
 * first transition.**
 *
 * The WAL's own replace protocol fsyncs `wal.json` and the thread directory that holds it. That is
 * not sufficient on its own: a newly created `<h(threadId)>/` directory's NAME is an entry in its
 * PARENT, and `ensureDirNoSymlink` only `mkdir`s each missing component with no fsync anywhere. On a
 * filesystem that honours the distinction, a crash after the first transition and after the publish
 * can come back with the directory link itself lost — no WAL, no pending record — and boot then
 * reads a thread that has already published as VIRGIN: `E := 0`, a fresh epoch, and a second frame
 * claiming a sequence the stream has already seen.
 *
 * So every component from the workspace root down is fsynced, parents included, rather than the leaf
 * alone. It runs once at emitter start; the cost is a handful of directory syncs against a session
 * that is about to do real work.
 *
 * Returns the WAL path, so a caller cannot resolve the location by one route and create it by
 * another — and the HELD principal lock with it, for the same reason. Handing back a location whose
 * lock the caller then has to remember to take is how the lock came to be a path and nothing else.
 */
export async function ensureEventWalDir(opts: {
  workspaceRoot: string;
  space: string;
  principal: string;
  threadId: string;
}): Promise<HeldEventWalLocation> {
  const loc = eventWalLocation(opts);

  // `ensureDirNoSymlink` refuses a symlinked component rather than following it — the WAL is written
  // at 0600 under directories created 0700, and a symlink anywhere in the chain would redirect that
  // write outside the tree the mode bits are protecting.
  ensureDirNoSymlink(opts.workspaceRoot, ".cotal", "events", h(opts.space), h(opts.principal), h(opts.threadId));

  // Bottom-up to the root: each fsync makes THIS directory's entries durable, so the thread dir's
  // own name only becomes durable when its parent is synced. Syncing the leaf alone is the exact
  // gap above.
  for (let dir = loc.threadDir; ; dir = dirname(dir)) {
    await fsyncDir(dir);
    if (dir === opts.workspaceRoot || dirname(dir) === dir) break;
  }

  // AFTER the chain exists, because the lock is a file inside the principal directory, and BEFORE
  // the caller can open a WAL under it, because a lock taken after the first transition is a lock
  // that was not held when it mattered.
  const lock = await acquirePrincipalLock(loc.lockPath);
  return { ...loc, lock };
}
