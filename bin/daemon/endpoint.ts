/**
 * The local control endpoint of `cotal daemon`, Linux only.
 *
 * Trust boundary, stated as it is: the kernel separates OS users, not processes of one user. The
 * runtime directory is owned by the daemon's uid with mode 0700, the socket is 0600, and both ends
 * read `SO_PEERCRED` through the stock `@cotal-ai/seat` helper and require the peer to be that same
 * uid. Any process running as that uid can still reach the daemon and read its files; that user is
 * the trust principal (see docs/connect-jcode.mdx, "Security limits").
 *
 * Nothing here repairs a path into shape. A pre-existing directory that is a symlink, not owned by
 * this uid, or not exactly 0700 is refused, never chmod-ed. A pre-existing entry at the socket path
 * is removed only when it is the exact socket this daemon home's dead predecessor published, which
 * the lifetime lock's record names; see lifetime.ts. Every other entry there is refused.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { mkSecretDir } from "@cotal-ai/core";
import { homeCotalDir } from "@cotal-ai/workspace";

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

/** A refusal at the local endpoint, typed so callers and tests can count it. `remedy` replaces the
 *  next step its code gives, for a case of that code that has its own. */
export class EndpointRefusal extends Error {
  readonly code: EndpointProblemCode;
  readonly remedy?: string;
  constructor(code: EndpointProblemCode, message: string, remedy?: string) {
    super(message);
    this.name = "EndpointRefusal";
    this.code = code;
    if (remedy !== undefined) this.remedy = remedy;
  }
}

export interface DaemonPaths {
  readonly dir: string;
  readonly socket: string;
  /** Explicit daemon home only: the shared runtime directory `dir` lives in, created and checked first. */
  readonly parent?: string;
  /** This daemon's lifetime lock. `serve` holds an exclusive `flock(2)` on it while it runs, and a
   *  client sends nothing unless the process answering at `socket` is this lock's live owner. Both
   *  daemon forms have one: the default daemon's lives beside its own state. */
  readonly lock: string;
  /** The directory `lock` lives in, created 0700 before the lock is taken. */
  readonly state: string;
}

/** The fixed endpoint location for this user: `$XDG_RUNTIME_DIR/cotal/daemon.sock`. */
export function daemonPaths(env: NodeJS.ProcessEnv = process.env, home: string = homeCotalDir()): DaemonPaths {
  const runtime = env.XDG_RUNTIME_DIR;
  if (!runtime) {
    throw new EndpointRefusal(
      "NO_RUNTIME_DIR",
      "XDG_RUNTIME_DIR is not set, so there is no per-user runtime directory to hold the daemon socket",
    );
  }
  const dir = join(runtime, "cotal");
  const state = join(home, "daemon");
  return { dir, socket: join(dir, "daemon.sock"), state, lock: join(state, "daemon.lock") };
}

/**
 * The endpoint of the daemon whose home is `daemonHome` (an absolute, canonical path):
 * `$XDG_RUNTIME_DIR/cotal/home-<16 hex of sha256(daemonHome)>/daemon.sock`, with its lifetime lock
 * at `<daemonHome>/daemon.lock`. Derived, so client and server agree with no extra record, and
 * disjoint from the legacy socket.
 */
export function daemonPathsFor(daemonHome: string, env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const base = daemonPaths(env, daemonHome);
  const dir = join(base.dir, `home-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}`);
  return { parent: base.dir, dir, socket: join(dir, "daemon.sock"), state: daemonHome, lock: join(daemonHome, "daemon.lock") };
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
 * The directory holding this daemon's lifetime lock, created 0700 when it is the default daemon's
 * own state directory under the Cotal home. An explicit `--daemon-home` is the operator's directory
 * and was already checked by {@link checkDir}, so nothing is created or repaired there.
 */
export function ensureStateDir(paths: DaemonPaths, uid: number = euid()): void {
  if (paths.state === paths.lock) throw new EndpointRefusal("DIR_NOT_DIRECTORY", `${paths.state} cannot hold its own lock`);
  if (!exists(paths.state)) mkSecretDir(paths.state);
  checkDir(paths.state, uid);
}

/** The peer's uid on a connected unix socket, read by the kernel via the stock seat helper. */
export type PeerUid = (sock: Socket) => number;
/** The peer's pid on a connected unix socket, read the same way. */
export type PeerPid = (sock: Socket) => number;
