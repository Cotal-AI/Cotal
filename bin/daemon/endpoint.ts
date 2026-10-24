/**
 * The local control endpoint of `cotal daemon`, Linux only.
 *
 * Trust boundary, stated as it is: the kernel separates OS users, not processes of one user. The
 * runtime directory is owned by the daemon's uid with mode 0700, the socket is 0600, and both ends
 * read `SO_PEERCRED` through the stock `@cotal-ai/seat` helper and require the peer to be that same
 * uid. Any process running as that uid can still reach the daemon and read its files; that user is
 * the trust principal (see docs/connect-jcode.md, "Security limits").
 *
 * Nothing here repairs a path into shape. A pre-existing directory that is a symlink, not owned by
 * this uid, or not exactly 0700 is refused, never chmod-ed. Any pre-existing entry at the socket
 * path is refused, never removed, so this code never unlinks a socket it did not create.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";

/** Wire protocol version. A request naming any other version is refused before any effect. */
export const DAEMON_PROTOCOL_VERSION = 1;
/** Largest accepted request or response line, in bytes, including its newline. */
export const MAX_LINE_BYTES = 64 * 1024;

export type EndpointProblemCode =
  | "UNSUPPORTED_PLATFORM"
  | "NO_RUNTIME_DIR"
  | "DIR_NOT_DIRECTORY"
  | "DIR_SYMLINK"
  | "DIR_WRONG_OWNER"
  | "DIR_WRONG_MODE"
  | "SOCKET_NOT_SOCKET"
  | "SOCKET_WRONG_OWNER"
  | "SOCKET_WRONG_MODE"
  | "ALREADY_RUNNING"
  | "PEER_UID_MISMATCH"
  | "PEER_NOT_LOCK_OWNER"
  | "LOCK_HELD"
  | "NOT_RUNNING";

/** A refusal at the local endpoint, typed so callers and tests can count it. */
export class EndpointRefusal extends Error {
  readonly code: EndpointProblemCode;
  constructor(code: EndpointProblemCode, message: string) {
    super(message);
    this.name = "EndpointRefusal";
    this.code = code;
  }
}

export interface DaemonPaths {
  readonly dir: string;
  readonly socket: string;
  /** Explicit daemon home only: the shared runtime directory `dir` lives in, created and checked first. */
  readonly parent?: string;
  /** Explicit daemon home only: its lifetime lock. `serve` holds it while it runs; a client sends
   *  nothing unless the process answering at `socket` is this lock's live owner. */
  readonly lock?: string;
}

/** The fixed endpoint location for this user: `$XDG_RUNTIME_DIR/cotal/daemon.sock`. */
export function daemonPaths(env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime) {
    throw new EndpointRefusal(
      "NO_RUNTIME_DIR",
      "XDG_RUNTIME_DIR is not set, so there is no per-user runtime directory to hold the daemon socket",
    );
  }
  const dir = join(runtime, "cotal");
  return { dir, socket: join(dir, "daemon.sock") };
}

/**
 * The endpoint of the daemon whose home is `daemonHome` (an absolute, canonical path):
 * `$XDG_RUNTIME_DIR/cotal/home-<16 hex of sha256(daemonHome)>/daemon.sock`, with its lifetime lock
 * at `<daemonHome>/daemon.lock`. Derived, so client and server agree with no extra record, and
 * disjoint from the legacy socket.
 */
export function daemonPathsFor(daemonHome: string, env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const base = daemonPaths(env);
  const dir = join(base.dir, `home-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}`);
  return { parent: base.dir, dir, socket: join(dir, "daemon.sock"), lock: join(daemonHome, "daemon.lock") };
}

export function assertLinux(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux") {
    throw new EndpointRefusal("UNSUPPORTED_PLATFORM", `the local daemon endpoint is Linux only (this is ${platform})`);
  }
}

function euid(): number {
  if (typeof process.geteuid !== "function") throw new EndpointRefusal("UNSUPPORTED_PLATFORM", "this platform has no effective uid");
  return process.geteuid();
}

/** Refuse unless `dir` is a real directory owned by this uid with mode exactly 0700. */
export function checkDir(dir: string, uid: number = euid()): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new EndpointRefusal("DIR_SYMLINK", `${dir} is a symlink; the daemon directory must be a real directory`);
  if (!st.isDirectory()) throw new EndpointRefusal("DIR_NOT_DIRECTORY", `${dir} exists and is not a directory`);
  if (st.uid !== uid) throw new EndpointRefusal("DIR_WRONG_OWNER", `${dir} is owned by uid ${st.uid}, not ${uid}`);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) throw new EndpointRefusal("DIR_WRONG_MODE", `${dir} has mode ${mode.toString(8).padStart(4, "0")}, not 0700`);
}

/** Refuse unless `path` is a socket owned by this uid with mode exactly 0600. */
export function checkSocket(path: string, uid: number = euid()): void {
  const st = lstatSync(path);
  if (!st.isSocket()) throw new EndpointRefusal("SOCKET_NOT_SOCKET", `${path} exists and is not a socket`);
  if (st.uid !== uid) throw new EndpointRefusal("SOCKET_WRONG_OWNER", `${path} is owned by uid ${st.uid}, not ${uid}`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new EndpointRefusal("SOCKET_WRONG_MODE", `${path} has mode ${mode.toString(8).padStart(4, "0")}, not 0600`);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Create the directory 0700 if absent; if present, check it and never change it. */
export function ensureDir(dir: string, uid: number = euid()): "created" | "existing" {
  if (!exists(dir)) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      checkDir(dir, uid);
      return "created";
    } catch (e) {
      // A concurrent creator won the race: fall through and check what is there now.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  checkDir(dir, uid);
  return "existing";
}

/**
 * Refuse any pre-existing entry at the public socket path. There is no automatic stale-socket
 * reclamation: a leftover socket from a crashed daemon is reported, never removed, because probing
 * then unlinking is a race that can delete another starter's live socket. The operator removes a
 * known-stale socket by hand; `link(2)` at bind time then gives exactly one winner.
 */
export function refuseExisting(path: string): void {
  if (!exists(path)) return;
  const st = lstatSync(path);
  if (!st.isSocket()) throw new EndpointRefusal("SOCKET_NOT_SOCKET", `${path} exists and is not a socket; nothing was removed`);
  throw new EndpointRefusal("ALREADY_RUNNING", `${path} already exists (uid ${st.uid}); a daemon may be running, or a previous one exited without cleanup. Nothing was removed`);
}

/** The peer's uid on a connected unix socket, read by the kernel via the stock seat helper. */
export type PeerUid = (sock: Socket) => number;
/** The peer's pid on a connected unix socket, read the same way. */
export type PeerPid = (sock: Socket) => number;
