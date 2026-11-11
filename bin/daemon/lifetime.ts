/**
 * The daemon's lifetime lock, and the socket generation it correlates with.
 *
 * `serve` holds an exclusive kernel lock on `<state>/daemon.lock` for as long as it runs: `flock(2)`
 * on Linux and macOS, `LockFileEx` on one byte past the record on Windows. The kernel owns that
 * lock's lifetime: it is released when the last descriptor referring to it closes, which includes
 * every way the process can die. A daemon killed with SIGKILL, or taken by
 * the OOM killer, therefore leaves no lock behind, and the next `serve` learns its predecessor is
 * gone from the kernel's own refusal to hold the lock twice, not from a recorded pid it has to
 * judge alive or dead.
 *
 * That is what makes stale-socket recovery safe on Linux and macOS. (A Windows pipe name needs no
 * recovery: it exists only while a process holds an instance of it.) A unix socket's inode outlives its listener, so
 * a crash leaves a published socket nobody is bound to, and a probe-then-unlink of it races with
 * another starter publishing a live one. Holding the lock removes the race: publishing requires the
 * lock, so while this process holds it nobody else can put a socket at the path. The one socket it
 * may then remove is the one its dead predecessor published, which the lock record names by
 * `(dev, ino)` and which nothing listens on any more. Any other socket, or an unreadable record, is
 * refused and left alone.
 *
 * The record is written through the locked descriptor, so it is always the record of the file this
 * process locked. It carries no secret: a pid, its start token, a start time and an inode number.
 * The start token is the kernel's own start time for that pid ({@link processBirth}), so a reused
 * pid never matches it.
 *
 * Two different questions use the two different facts. "May I serve?" is a liveness question, and
 * the kernel answers it by holding the lock for at most one process. "Is the process answering
 * this socket the one that holds the lock?" is an identity question, and the record answers it with
 * the holder's pid and process-start token, which a client checks without touching the lock: a
 * client that took the lock to test it, even for an instant, would make a legitimate start refuse.
 */
import { closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { constants } from "node:fs";
import { createConnection } from "node:net";
import { processStartToken } from "@cotal-ai/core";
import { lockExclusiveNb, processStartTime } from "@cotal-ai/seat";
import { codeSpan, shellPath } from "@cotal-ai/workspace";
import { EndpointRefusal } from "./endpoint.js";

/** The socket a holder published, identified by the inode it is, not by its path alone. */
export interface SocketGeneration {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * The kernel's start token for process `pid`, so a pid reused by a later process never matches:
 * `/proc/<pid>/stat` starttime on Linux, the process table's start time on macOS, the creation
 * time of the process object on Windows (the same value the native pipe open reads for its peer).
 * Undefined when there is no such process.
 */
export function processBirth(pid: number): string | undefined {
  return process.platform === "linux" ? processStartToken(pid) : processStartTime(pid);
}

/** What a holder writes through the locked descriptor. `socket` is absent until it publishes one. */
export interface LockRecord {
  readonly v: 1;
  readonly pid: number;
  /** The holder's {@link processBirth} token, so a client can tell its pid from a reused one. */
  readonly start?: string;
  readonly startedAt: string;
  readonly socket?: SocketGeneration;
}

export interface HeldLifetime {
  /** The record the previous holder left, when it is readable and well-formed. */
  readonly previous: LockRecord | undefined;
  /** Stop preserving a predecessor whose socket was rejected, removed or already absent. */
  discardPrevious(): void;
  /** Record the socket this daemon is about to publish, before it publishes it. */
  publishing(generation: SocketGeneration): void;
  /** Clear the record and release the lock. A failed start may restore its unconsumed predecessor
   *  before closing the descriptor. Idempotent. */
  release(opts?: { preservePrevious?: boolean }): void;
}

function parse(raw: string): LockRecord | undefined {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return undefined; }
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.startedAt !== "string") return undefined;
  const start = typeof r.start === "string" ? { start: r.start } : {};
  if (r.socket === undefined) return { v: 1, pid: r.pid, ...start, startedAt: r.startedAt };
  const s = r.socket as Record<string, unknown>;
  if (!s || typeof s !== "object" || typeof s.path !== "string" || typeof s.dev !== "number" || typeof s.ino !== "number") return undefined;
  return { v: 1, pid: r.pid, ...start, startedAt: r.startedAt, socket: { path: s.path, dev: s.dev, ino: s.ino } };
}

/** The record at `path`, for a client deciding whether the process answering a socket is its
 *  holder. Undefined when there is none, when it is unreadable, or when it is not one of ours. */
export function readLifetimeRecord(path: string): LockRecord | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.trim() ? parse(raw) : undefined;
  } catch { return undefined; }
}

/** Exclude new starters during uninstall without writing or clearing the holder's record. */
export function excludeLifetime(path: string): { release(): void } {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    if (!lockExclusiveNb(fd)) throw new EndpointRefusal("LOCK_HELD", "the daemon lifetime is still held; uninstall retained its source and receipt");
  } catch (error) { closeSync(fd); throw error; }
  let released = false;
  return { release() { if (!released) { released = true; closeSync(fd); } } };
}

/**
 * Take the lifetime lock at `path`, or refuse `LOCK_HELD`. The file is created 0600 if absent and
 * is never replaced, so the descriptor every holder locks is the same inode.
 */
export function holdLifetime(path: string): HeldLifetime {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  let held: boolean;
  try {
    held = lockExclusiveNb(fd);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  if (!held) {
    // Read the live holder's record only to name it. The lock, not the record, is the proof.
    let holder: LockRecord | undefined;
    try { holder = parse(readFileSync(path, "utf8")); } catch { /* naming is best effort */ }
    closeSync(fd);
    throw new EndpointRefusal(
      "LOCK_HELD",
      `${path} is held by a live process${holder ? ` (pid ${holder.pid}, started ${holder.startedAt})` : ""}: this daemon is already being served. Nothing was changed`,
    );
  }
  // The lock is ours, so whatever the file holds was left by a holder the kernel has already
  // released: a predecessor that exited without clearing it, which is exactly a crash.
  let previous: LockRecord | undefined;
  try {
    const size = fstatSync(fd).size;
    if (size > 0 && size <= 4096) previous = parse(readFileSync(path, "utf8"));
  } catch { /* an unreadable record names no generation, so nothing is recovered */ }

  const startedAt = new Date().toISOString();
  const token = processBirth(process.pid);
  const identity = { v: 1 as const, pid: process.pid, ...(token !== undefined ? { start: token } : {}), startedAt };
  let released = false;
  let recoverable = previous;
  const write = (record: LockRecord): void => {
    const bytes = `${JSON.stringify(record)}\n`;
    ftruncateSync(fd, 0);
    writeSync(fd, bytes, 0);
  };
  write(identity);
  return {
    previous,
    discardPrevious() {
      recoverable = undefined;
    },
    publishing(generation) {
      recoverable = undefined;
      write({ ...identity, socket: generation });
    },
    release(opts = {}) {
      if (released) return;
      released = true;
      // A startup preflight failure has not consumed the dead socket. Keep its evidence under
      // the lock so another attempt can recover it. Clean shutdown still leaves no generation.
      try {
        if (opts.preservePrevious && recoverable?.socket) write(recoverable);
        else {
          try { ftruncateSync(fd, 0); } catch { /* closing still releases the lock */ }
        }
      } finally { closeSync(fd); }
    },
  };
}

/** The generation of the socket already bound at `path`, read from the file itself. */
export function generationOf(path: string): SocketGeneration {
  const st = lstatSync(path);
  return { path, dev: st.dev, ino: st.ino };
}

/** How a connect to the unix socket at `path` ends: `ECONNREFUSED` when nothing listens on it,
 *  `answered` when a process accepts it, or the error code the kernel gave. Nothing is written. */
function connectOutcome(path: string): Promise<string> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once("connect", () => { s.destroy(); resolve("answered"); });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  });
}

/**
 * Decide what to do with whatever sits at the public socket path, holding the lifetime lock.
 *
 * `clear` means nothing is there. `recover` means the socket there is the exact inode the dead
 * predecessor's record names and nothing listens on it, so this daemon may remove it. Anything else
 * refuses: a non-socket entry, a socket this home's last daemon did not publish, or one a process
 * answers on, is reported and left in place.
 */
export async function claimSocketPath(path: string, previous: SocketGeneration | undefined): Promise<"clear" | "recover"> {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "clear";
    throw e;
  }
  if (!st.isSocket()) throw new EndpointRefusal("SOCKET_NOT_SOCKET", `${path} exists and is not a socket; nothing was removed`);
  if (previous && previous.path === path && previous.dev === st.dev && previous.ino === st.ino) {
    // A filesystem can give a new file the inode number of one it freed, so equal numbers alone do
    // not prove this is the dead predecessor's socket. Its listener died with it, so the kernel
    // refuses a connect; a socket anything still answers on belongs to a live process.
    const outcome = await connectOutcome(path);
    if (outcome === "ECONNREFUSED") return "recover";
    if (outcome === "answered")
      throw new EndpointRefusal(
        "ALREADY_RUNNING",
        `${path} has the device and inode numbers this daemon home's last daemon published, but a connect to it was answered: another process is listening at that path, and serve does not start until that process releases it; nothing was removed`,
        `find that process with \`ss -xlp\` or ${codeSpan(`fuser ${shellPath(path)}`)}, and stop it; then run \`cotal daemon serve\` again`,
      );
    throw new EndpointRefusal(
      "ALREADY_RUNNING",
      `${path} has the device and inode numbers this daemon home's last daemon published, but a connect to it failed with ${outcome}, so it is not that daemon's dead socket; nothing was removed`,
    );
  }
  // A rejected socket claim clears the record as a clean stop does, so the next attempt does
  // not reuse evidence that failed this check.
  throw new EndpointRefusal(
    "ALREADY_RUNNING",
    previous
      ? `${path} already exists (uid ${st.uid}) and is not the socket this daemon home's last daemon published; nothing was removed`
      : `${path} already exists (uid ${st.uid}), and this daemon home's lock record names no socket to compare it with: a clean stop or a refused socket check clears that record; nothing was removed`,
  );
}
