/**
 * Where a principal's event WAL lives on disk, and making that location durable before it is used.
 *
 * The layout is fixed by `agui-events.md:683-687`:
 *
 * ```
 * <workspaceRoot>/.cotal/events/<h(space)>/<h(principal)>/
 *     .lock                       one emitter per PRINCIPAL (not per thread)
 *     <h(threadId)>/wal.json      ONE file per thread, atomically replaced
 * ```
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
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDirNoSymlink } from "@cotal-ai/core";

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
  /** `<principalDir>/<h(threadId)>` — the directory holding exactly one `wal.json`. */
  threadDir: string;
  /** The WAL document itself. */
  walPath: string;
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
    threadDir,
    walPath: join(threadDir, "wal.json"),
  };
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
async function fsyncDir(dir: string): Promise<void> {
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
 * Create the directory chain for a thread's WAL and make it durable — **`[P10]`, once, before the
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
 * another.
 */
export async function ensureEventWalDir(opts: {
  workspaceRoot: string;
  space: string;
  principal: string;
  threadId: string;
}): Promise<EventWalLocation> {
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

  return loc;
}
