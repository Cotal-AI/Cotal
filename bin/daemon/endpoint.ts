/**
 * The local control endpoint of `cotal daemon`, on Linux, macOS and Windows.
 *
 * Trust boundary, stated as it is: the kernel separates OS users, not processes of one user. Any
 * process running as the daemon's user can reach the daemon and read its files; that user is the
 * trust principal (see docs/connect-jcode.mdx, "Security limits"). Each platform enforces that
 * boundary with its own kernel mechanism, read through the stock `@cotal-ai/seat` helper:
 *
 *  - Linux: a 0600 unix socket in a 0700 directory under `$XDG_RUNTIME_DIR`, and `SO_PEERCRED`.
 *  - macOS: the same socket layout under `confstr(_CS_DARWIN_USER_CACHE_DIR)`, which no environment
 *    variable changes, so a LaunchAgent and a terminal reach the same path; and `LOCAL_PEERCRED`
 *    (the uid getpeereid(3) reads) with `LOCAL_PEERPID`.
 *  - Windows: a named pipe whose instances carry a protected DACL granting only this user's SID,
 *    created first-instance-only and rejecting remote clients; each side reads the other's process
 *    token user and creation time before a byte moves (native/peercred_win32.c in the seat package).
 *
 * Both ends require the peer to be this same user, and a client additionally requires the answering
 * process to be the live holder of the daemon's lifetime lock (lifetime.ts).
 *
 * Nothing here repairs a path into shape. A pre-existing directory that is a symlink, not owned by
 * this user, or not private (exactly 0700; on Windows, a DACL granting only this user, SYSTEM and
 * Administrators) is refused, never changed. A pre-existing entry at the socket path is removed only
 * when it is the exact socket this daemon home's dead predecessor published, which the lifetime
 * lock's record names; see lifetime.ts. Every other entry there is refused. A Windows pipe name
 * needs no cleanup: it exists only while a process holds an instance of it.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { mkSecretDir } from "@cotal-ai/core";
import { darwinUserCacheDir, localPeerCredentials, windowsDirSecurity, windowsUserSid } from "@cotal-ai/seat";
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
  /** The 0700 directory holding the socket. Absent on Windows, where `socket` is a pipe name. */
  readonly dir?: string;
  /** The endpoint: a unix socket path, or on Windows the pipe name `\\.\pipe\cotal-daemon-<SID>[-home-<16 hex>]`. */
  readonly socket: string;
  /** Explicit daemon home on Linux and macOS: the shared runtime directory `dir` lives in, created and checked first. */
  readonly parent?: string;
  /** This daemon's lifetime lock. `serve` holds an exclusive kernel lock on it while it runs, and a
   *  client sends nothing unless the process answering at `socket` is this lock's live owner. Both
   *  daemon forms have one: the default daemon's lives beside its own state. */
  readonly lock: string;
  /** The directory `lock` lives in, created private before the lock is taken. */
  readonly state: string;
}

/** The largest unix socket path the kernel accepts: `sun_path` less its terminator. */
const SUN_PATH_MAX: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };

/** Refuse a unix socket path the kernel cannot bind, before anything is created at it. */
export function assertSocketPathFits(path: string, platform: NodeJS.Platform = process.platform): void {
  const max = SUN_PATH_MAX[platform];
  if (max !== undefined && Buffer.byteLength(path) > max) {
    throw new EndpointRefusal("NO_RUNTIME_DIR", `${path} is ${Buffer.byteLength(path)} bytes, longer than the ${max} a unix socket path may have here`, "use a daemon home or Cotal home with a shorter path");
  }
}

/** Run a call into the platform's native helper, turning a missing or unloadable helper into a typed refusal. */
function host<T>(what: string, call: () => T): T {
  try {
    return call();
  } catch (e) {
    throw new EndpointRefusal("UNSUPPORTED_PLATFORM", `${what} needs this platform's native daemon helper: ${(e as Error).message}`);
  }
}

/**
 * The fixed endpoint for this user. Linux: `$XDG_RUNTIME_DIR/cotal/daemon.sock`. macOS:
 * `<user cache dir>/cotal/daemon.sock`, the env-independent directory `confstr` names. Windows: the
 * pipe `\\.\pipe\cotal-daemon-<this user's SID>`. `env` is read on Linux only.
 */
export function daemonPaths(env: NodeJS.ProcessEnv = process.env, home: string = homeCotalDir()): DaemonPaths {
  const state = join(home, "daemon");
  const lock = join(state, "daemon.lock");
  if (process.platform === "win32") {
    return { socket: `\\\\.\\pipe\\cotal-daemon-${host("the daemon pipe name", windowsUserSid)}`, state, lock };
  }
  let runtime: string;
  if (process.platform === "darwin") {
    runtime = host("the daemon runtime directory", darwinUserCacheDir);
  } else {
    assertSupportedPlatform();
    if (!env.XDG_RUNTIME_DIR) {
      throw new EndpointRefusal(
        "NO_RUNTIME_DIR",
        "XDG_RUNTIME_DIR is not set, so there is no per-user runtime directory to hold the daemon socket",
      );
    }
    runtime = env.XDG_RUNTIME_DIR;
  }
  const dir = join(runtime, "cotal");
  const socket = join(dir, "daemon.sock");
  assertSocketPathFits(socket);
  return { dir, socket, state, lock };
}

/**
 * The endpoint of the daemon whose home is `daemonHome` (an absolute, canonical path):
 * `<runtime>/cotal/home-<16 hex of sha256(daemonHome)>/daemon.sock`, or on Windows the pipe
 * `\\.\pipe\cotal-daemon-<SID>-home-<16 hex>`, with its lifetime lock at `<daemonHome>/daemon.lock`.
 * Derived, so client and server agree with no extra record, and disjoint from the default endpoint.
 */
export function daemonPathsFor(daemonHome: string, env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const base = daemonPaths(env, daemonHome);
  const tag = `home-${createHash("sha256").update(daemonHome).digest("hex").slice(0, 16)}`;
  const lock = join(daemonHome, "daemon.lock");
  if (base.dir === undefined) return { socket: `${base.socket}-${tag}`, state: daemonHome, lock };
  const dir = join(base.dir, tag);
  const socket = join(dir, "daemon.sock");
  assertSocketPathFits(socket);
  return { parent: base.dir, dir, socket, state: daemonHome, lock };
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new EndpointRefusal("UNSUPPORTED_PLATFORM", `the local daemon endpoint supports Linux, macOS and Windows (this is ${platform})`);
  }
}

function euid(): number {
  if (typeof process.geteuid !== "function") throw new EndpointRefusal("UNSUPPORTED_PLATFORM", "this platform has no effective uid");
  return process.geteuid();
}

/** The principals a private Windows directory may grant anything to: this user, SYSTEM and
 *  Administrators, the set core's `mkSecretDir` leaves on a directory it hardens. */
function windowsTrusted(): Set<string> {
  return new Set([host("the directory check", windowsUserSid), "S-1-5-18", "S-1-5-32-544"]);
}

/** Windows: refuse unless `dir` is a real directory (no junction or symlink) owned by a trusted
 *  principal, whose DACL grants nothing to anyone else. */
function checkWindowsDir(dir: string): void {
  const trusted = windowsTrusted();
  const sec = windowsDirSecurity(dir);
  if (sec.reparse) throw new EndpointRefusal("DIR_SYMLINK", `${dir} is a junction or symlink; the daemon directory must be a real directory`);
  if (!sec.directory) throw new EndpointRefusal("DIR_NOT_DIRECTORY", `${dir} exists and is not a directory`);
  if (sec.owner === null || !trusted.has(sec.owner)) throw new EndpointRefusal("DIR_WRONG_OWNER", `${dir} is owned by ${sec.owner ?? "nobody"}, not this user, SYSTEM or Administrators`);
  const remedy = "inspect its access list with icacls; the daemon never changes the access list of an existing directory";
  if (sec.aces === null) throw new EndpointRefusal("DIR_WRONG_MODE", `${dir} has a NULL DACL, which grants everyone full access`, remedy);
  for (const ace of sec.aces) {
    if (ace.type === 1) continue;
    if (ace.type !== 0 || ace.sid === null) throw new EndpointRefusal("DIR_WRONG_MODE", `${dir} has an access entry of type ${ace.type}, which this check does not accept`, remedy);
    if (ace.mask !== 0 && !trusted.has(ace.sid)) throw new EndpointRefusal("DIR_WRONG_MODE", `${dir} grants access to ${ace.sid}; only this user, SYSTEM and Administrators may have any`, remedy);
  }
}

/** Refuse unless `dir` is a real directory owned by this uid with mode exactly 0700 (on Windows,
 *  owned and accessible only as {@link checkWindowsDir} requires; `uid` is not used there). */
export function checkDir(dir: string, uid?: number): void {
  if (process.platform === "win32") return checkWindowsDir(dir);
  uid ??= euid();
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
export function ensureStateDir(paths: DaemonPaths, uid?: number): void {
  if (paths.state === paths.lock) throw new EndpointRefusal("DIR_NOT_DIRECTORY", `${paths.state} cannot hold its own lock`);
  if (!exists(paths.state)) mkSecretDir(paths.state);
  checkDir(paths.state, uid);
}

/** The peer's uid on a connected unix socket, read by the kernel via the stock seat helper. */
export type PeerUid = (sock: Socket) => number;
/** The peer's pid on a connected unix socket, read the same way. */
export type PeerPid = (sock: Socket) => number;
/** The readers a client and server use unless a test passes its own (Linux and macOS; Windows reads
 *  the peer inside the native pipe open and accept). */
export const defaultPeerUid: PeerUid = (sock) => localPeerCredentials(sock).uid;
export const defaultPeerPid: PeerPid = (sock) => localPeerCredentials(sock).pid;

/** Wrap a pipe connection the native layer authenticated (Windows). Node reopens 0-2 at startup on
 *  Windows, so an adopted descriptor is never a standard stream; one that is would get stdout's
 *  synchronous writes from `net.Socket`, so it is closed and refused. */
export function adoptPipe(fd: number): Socket {
  if (fd <= 2) {
    closeSync(fd);
    throw new Error(`the native pipe layer returned standard descriptor ${fd}; it was closed`);
  }
  try {
    return new Socket({ fd, readable: true, writable: true });
  } catch (e) {
    try { closeSync(fd); } catch { /* the open that failed may already have released it */ }
    throw e;
  }
}
