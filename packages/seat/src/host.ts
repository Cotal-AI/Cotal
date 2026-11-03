/**
 * Host primitives for an authenticated same-user local endpoint on Linux, macOS and Windows, from
 * the same native helper as {@link peerCredentials}. Seat custody stays Linux only; these do not.
 * Each throws when this platform or arch has no helper, or when the call does not apply to it.
 */
import type { Socket } from "node:net";
import { loadNativeHelper, socketFd, type PeerCredentials } from "./peercred.js";

/** A pipe connection the native side authenticated: a libuv descriptor for `net.Socket({ fd })`,
 *  and the peer process's pid, token user SID and creation time, read through one process handle. */
export interface PipePeer {
  readonly fd: number;
  readonly pid: number;
  readonly user: string;
  readonly birth: string;
}

/** A connection the native side closed unread because its peer's identity could not be read. */
export interface PipeRefused {
  readonly refused: string;
  readonly pid: number;
}

export interface PipeListener {
  /** The next client: authenticated, or refused unread. Rejects with code `ECANCELED` once closed. */
  accept(): Promise<PipePeer | PipeRefused>;
  /** Stop accepting and close every instance not yet handed off. Idempotent. */
  close(): void;
}

/** One ACE of a Windows DACL. `sid` is null for ACE types other than allow (0) and deny (1). */
export interface WindowsAce {
  readonly type: number;
  readonly flags: number;
  readonly mask: number;
  readonly sid: string | null;
}

/** A Windows directory as read through a handle that does not follow reparse points. `aces` is null
 *  for a NULL DACL, which grants everyone everything. */
export interface WindowsDirSecurity {
  readonly directory: boolean;
  readonly reparse: boolean;
  readonly owner: string | null;
  readonly aces: readonly WindowsAce[] | null;
}

/** A loaded launchd job as `SMJobCopyDictionary` reports it, each field present only when the
 *  dictionary carries it readably. Apple documents those contents as not wholly representative of
 *  the on-disk plist and not stable between releases, so an absent field proves nothing. */
export interface DarwinLaunchdJob {
  readonly label?: string;
  readonly program?: string;
  readonly programArguments?: readonly string[];
  readonly workingDirectory?: string;
}

/** What a launchd lookup established: the job as loaded, that no job has the label, or that the
 *  lookup itself could not be made (not macOS, no helper, or the deprecated API is gone). */
export type DarwinLaunchdLookup =
  | { readonly state: "loaded"; readonly job: DarwinLaunchdJob }
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly reason: string };

type HostNative = {
  peercred?: (fd: number) => PeerCredentials;
  flockExclusiveNb?: (fd: number) => boolean;
  lockExclusiveNb?: (fd: number) => boolean;
  processStartTime?: (pid: number) => string | undefined;
  userCacheDir?: () => string;
  currentUserSid?: () => string;
  inspectDir?: (path: string) => WindowsDirSecurity;
  pipeListen?: (name: string) => object;
  pipeAccept?: (listener: object) => Promise<PipePeer | PipeRefused>;
  pipeClose?: (listener: object) => void;
  pipeConnect?: (name: string, timeoutMs: number) => Promise<PipePeer>;
  launchdJob?: (label: string) => DarwinLaunchdJob | { unavailable: string } | null;
};

function native<K extends keyof HostNative>(name: K): NonNullable<HostNative[K]> {
  const fn = loadNativeHelper<HostNative>()[name];
  if (typeof fn !== "function") throw new Error(`@cotal-ai/seat: ${name} is not available on ${process.platform}`);
  return fn as NonNullable<HostNative[K]>;
}

/** The kernel's credentials for the peer of a connected unix socket: `SO_PEERCRED` on Linux,
 *  `LOCAL_PEERCRED` (the uid getpeereid(3) reads) and `LOCAL_PEERPID` on macOS. */
export function localPeerCredentials(sock: Socket): PeerCredentials {
  return native("peercred")(socketFd(sock));
}

/**
 * Take an exclusive kernel lock on the open file `fd` without blocking. True when this process now
 * holds it, false when another open file does. `flock(2)` on Linux and macOS; on Windows
 * `LockFileEx` on one byte at 1 GiB, past any content, so readers of the file are never blocked.
 * Either way the system releases it when the holder's last handle closes, including at its death.
 */
export function lockExclusiveNb(fd: number): boolean {
  return process.platform === "win32" ? native("lockExclusiveNb")(fd) : native("flockExclusiveNb")(fd);
}

/** The kernel's start time of process `pid` (macOS and Windows), or undefined when it does not
 *  exist. A reused pid has a different value. Linux reads `/proc/<pid>/stat` instead. */
export function processStartTime(pid: number): string | undefined {
  return native("processStartTime")(pid);
}

/** macOS: `confstr(_CS_DARWIN_USER_CACHE_DIR)`, this user's 0700 cache directory, which no
 *  environment variable changes and the system never cleans. */
export function darwinUserCacheDir(): string {
  return native("userCacheDir")();
}

/**
 * macOS: the job launchd has loaded under `label` in this process's per-user domain
 * (`kSMDomainUserLaunchd`), read with `SMJobCopyDictionary` and changing nothing. That domain is
 * the caller's own session: a process in the desktop session reads its GUI domain. Never throws
 * for an unavailable lookup; it reports one.
 */
export function darwinLaunchdJob(label: string): DarwinLaunchdLookup {
  if (process.platform !== "darwin") return { state: "unavailable", reason: `launchd exists only on macOS (this is ${process.platform})` };
  let lookup: NonNullable<HostNative["launchdJob"]>;
  try {
    lookup = native("launchdJob");
  } catch (e) {
    return { state: "unavailable", reason: (e as Error).message };
  }
  const found = lookup(label);
  if (found === null) return { state: "absent" };
  if ("unavailable" in found) return { state: "unavailable", reason: found.unavailable };
  return { state: "loaded", job: found };
}

/** Windows: this process's token user SID, as `S-1-...`. */
export function windowsUserSid(): string {
  return native("currentUserSid")();
}

/** Windows: the owner and DACL of `path`, read without following a reparse point. */
export function windowsDirSecurity(path: string): WindowsDirSecurity {
  return native("inspectDir")(path);
}

/** Windows: serve pipe `name` to this user only. Throws code `EADDRINUSE` when anything already
 *  serves the name. See native/peercred_win32.c for every flag. */
export function listenPipe(name: string): PipeListener {
  const handle = native("pipeListen")(name);
  const accept = native("pipeAccept");
  const close = native("pipeClose");
  return { accept: () => accept(handle), close: () => close(handle) };
}

/** Windows: open pipe `name`, authenticate its server process, and write nothing. Rejects with code
 *  `ENOENT` when nothing serves it and `ETIMEDOUT` when every instance stayed busy. */
export function connectPipe(name: string, timeoutMs: number): Promise<PipePeer> {
  return native("pipeConnect")(name, timeoutMs);
}
