import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { userAppConfigDir, userJcodeHome } from "@1jehuang/jcode-sdk";
import { hardenPrivate } from "@cotal-ai/core";

const MAX_API_SOCKET_BYTES = 100;
const JCODE_CREDENTIAL_FILES = [
  "auth.json",
  "openai-auth.json",
  "antigravity_oauth.json",
  "gemini_oauth.json",
  "google_oauth.json",
  "google_credentials.json",
  "config.toml",
];
const EXTERNAL_CREDENTIAL_FILES = [
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  ".cursor/auth.json",
  ".config/cursor/auth.json",
  "AppData/Roaming/Cursor/auth.json",
  ".config/Cursor/User/globalStorage/state.vscdb",
  ".config/cursor/User/globalStorage/state.vscdb",
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  "Library/Application Support/cursor/User/globalStorage/state.vscdb",
  "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
  "AppData/Roaming/cursor/User/globalStorage/state.vscdb",
  ".config/github-copilot/hosts.json",
  ".config/github-copilot/apps.json",
  ".copilot/config.json",
  ".hermes/auth.json",
  ".pi/agent/auth.json",
  ".openclaw/agent/auth.json",
  ".openclaw/credentials/oauth.json",
  ".local/share/opencode/auth.json",
];

function assertRelative(relativePath: string): void {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes(".."))
    throw new Error(`unsafe Jcode credential mirror path: ${relativePath}`);
}

function privateDirectory(
  path: string,
  { replaceSymlink = false, requireOwner = false, beforeEnsure, pin }: { replaceSymlink?: boolean; requireOwner?: boolean; beforeEnsure?: () => void; pin: boolean },
): void {
  if (pin) {
    ensurePinnedPrivateDirectory(path, { replaceSymlink, requireOwner, beforeEnsure });
    return;
  }
  ensureUnpinnedPrivateDirectory(path, { replaceSymlink, requireOwner, beforeEnsure });
}

function ensureUnpinnedPrivateDirectory(path: string, { replaceSymlink = false, requireOwner = false, beforeEnsure }: { replaceSymlink?: boolean; requireOwner?: boolean; beforeEnsure?: () => void }): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      if (!replaceSymlink) throw new Error(`refusing symlinked Jcode private directory: ${path}`);
      beforeEnsure?.();
      rmSync(path, { force: true });
      mkdirSync(path, { mode: 0o700 });
    } else if (!stats.isDirectory()) {
      throw new Error(`Jcode private path is not a directory: ${path}`);
    } else if (requireOwner) {
      assertCurrentUserOwns(path, stats.uid);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    beforeEnsure?.();
    mkdirSync(path, { mode: 0o700 });
  }
  hardenPrivate(path, "dir");
  // Verify owner after creation and hardening as well. On POSIX a privileged process can chmod an
  // attacker-owned /tmp directory, so permissions alone never establish namespace ownership.
  if (requireOwner) assertCurrentUserOwns(path, lstatSync(path).uid);
}

/** Ensure one directory through a pinned parent fd. `beforeEnsure` runs after the parent is
 * pinned and the leaf is classified, before unlink/mkdir, so the smoke can swap that parent. */
export function ensurePinnedPrivateDirectory(
  path: string,
  { replaceSymlink = false, requireOwner = false, beforeEnsure }: { replaceSymlink?: boolean; requireOwner?: boolean; beforeEnsure?: () => void } = {},
): void {
  const parent = dirname(path);
  const name = basename(path);
  if (name === "" || name === "." || name === "..") throw new Error(`unsafe Jcode private directory: ${path}`);
  const pin = PinnedParent.open(parent);
  try {
    const leaf = pin.leaf(name);
    try {
      const stats = lstatSync(leaf);
      if (stats.isSymbolicLink()) {
        if (!replaceSymlink) throw new Error(`refusing symlinked Jcode private directory: ${path}`);
        beforeEnsure?.();
        unlinkSync(leaf);
        mkdirSync(leaf, { mode: 0o700 }); // pin-mkdir-replace-symlink
      } else if (!stats.isDirectory()) {
        throw new Error(`Jcode private path is not a directory: ${path}`);
      } else if (requireOwner) {
        assertCurrentUserOwns(path, stats.uid);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      beforeEnsure?.();
      mkdirSync(leaf, { mode: 0o700 }); // pin-mkdir-absent
    }
    hardenPrivate(leaf, "dir");
    if (requireOwner) assertCurrentUserOwns(path, lstatSync(leaf).uid);
  } finally {
    pin.close();
  }
}

function assertCurrentUserOwns(path: string, uid: number): void {
  // Jcode's connector refuses Windows before this helper is reachable: its released Harness API
  // integration is a Unix-socket surface. Do not manufacture an extra ownership failure there.
  if (process.platform === "win32") return;
  const currentUid = process.getuid?.();
  if (currentUid === undefined)
    throw new Error(`cannot determine effective UID for Jcode short API socket directory: ${path}`);
  if (uid !== currentUid)
    throw new Error(`refusing Jcode short API socket directory owned by uid ${uid}, not effective uid ${currentUid}: ${path}`);
}

function credentialDestination(home: string, destinationRelative: string): string {
  assertRelative(destinationRelative);
  const destination = join(home, destinationRelative);
  if (!resolve(destination).startsWith(resolve(home) + sep)) throw new Error(`Jcode credential mirror escapes its private home: ${destination}`);
  return destination;
}

const PIN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY;

/** How this platform names a child of a directory it already holds. */
type PinMode = "procfs-fd" | "cwd-inode";

function assertComponent(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0"))
    throw new Error(`unsafe Jcode credential mirror path component: ${name}`);
}

function pinUnsupportedMessage(detail: string): string {
  return `Jcode credential mirroring requires a directory pin to name each parent by inode (${detail})`;
}

function pinMode(): PinMode {
  if (process.platform === "linux") return "procfs-fd";
  // Windows is refused in buildLaunch: Jcode's released Harness API bridge is a Unix socket. This
  // stays a backstop, because chdir there resolves through a drive-relative namespace and the
  // O_NOFOLLOW guard below does not exist.
  if (process.platform === "win32") throw new Error(pinUnsupportedMessage(`platform ${process.platform}`));
  return "cwd-inode";
}

/** Existence of `/dev/fd` is not enough: macOS mounts it, but lookup of `/dev/fd/<n>/<name>` is an
 * error. Probe traversal through an already-open directory fd before treating ENOENT as "absent". */
function assertPinnedFdTraversal(dirFd: number): void {
  const probe = `/dev/fd/${dirFd}/.`;
  let probeFd: number;
  try {
    probeFd = openSync(probe, OPEN_DIRECTORY);
  } catch (error) {
    throw new Error(pinUnsupportedMessage(`opening ${probe} failed with ${(error as NodeJS.ErrnoException).code ?? "unknown"}`));
  }
  closeSync(probeFd);
}

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * One pinned directory. Every leaf operation names a child of the directory this object holds, so
 * an ancestor swapped after the pin cannot redirect it. Two mechanisms, one contract.
 *
 * `procfs-fd` (Linux): `/dev/fd/<fd>/<name>` is the openat/unlinkat equivalent Node does not
 * expose. It names the pinned inode rather than re-walking the original path.
 *
 * `cwd-inode` (macOS, BSD): macOS mounts `/dev/fd`, but a lookup under a descriptor is ENOENT, so
 * the Linux spelling has nothing to name. The working directory is the other reference Node can
 * hold to a directory *inode*: after `chdir`, a single-component relative name resolves from that
 * inode and no ancestor is walked again, which is the same guarantee spelled differently. `chdir` takes a
 * path, so entry is verified rather than trusted: the cwd's inode must equal the inode of the
 * descriptor opened a moment before, which closes the open→chdir window. Every mirror call is
 * synchronous and restores the previous directory in `close()`, so no other code observes the move.
 */
class PinnedParent {
  #mode: PinMode;
  #fd: number;
  #entryCwd: string | undefined;
  #closed = false;

  private constructor(mode: PinMode, fd: number, entryCwd: string | undefined) {
    this.#mode = mode;
    this.#fd = fd;
    this.#entryCwd = entryCwd;
  }

  /** Pin `directory`. Throws its raw ENOENT so callers keep distinguishing "absent" from "unsafe".
   * Optional `beforeEnter` runs after the descriptor is open and before the directory is entered,
   * so the smoke can swap the directory inside that window; production callers omit it. */
  static open(directory: string, beforeEnter?: () => void): PinnedParent {
    const mode = pinMode();
    const fd = openSync(directory, OPEN_DIRECTORY);
    if (mode === "procfs-fd") {
      try {
        assertPinnedFdTraversal(fd);
        beforeEnter?.();
      } catch (error) {
        closeSync(fd);
        throw error;
      }
      return new PinnedParent(mode, fd, undefined);
    }
    let entryCwd: string;
    try {
      entryCwd = process.cwd();
    } catch (error) {
      closeSync(fd);
      throw new Error(pinUnsupportedMessage(`the working directory is unreadable: ${(error as Error).message}`));
    }
    const pin = new PinnedParent(mode, fd, entryCwd);
    try {
      beforeEnter?.();
      process.chdir(directory);
      pin.#assertCwdIsPinned(directory);
    } catch (error) {
      pin.close();
      throw error;
    }
    return pin;
  }

  /** A path naming `name` inside the pinned directory. Valid only until this pin moves or closes. */
  leaf(name: string): string {
    assertComponent(name);
    return this.#mode === "procfs-fd" ? `/dev/fd/${this.#fd}/${name}` : name;
  }

  /** Descend into the child `name`, which becomes the pinned directory. */
  descend(name: string, displayPath: string, create: boolean): void {
    const next = create ? this.#openOrCreateChild(name, displayPath) : this.#openChild(name);
    if (this.#mode === "procfs-fd") {
      closeSync(this.#fd);
      this.#fd = next;
      return;
    }
    const previous = this.#fd;
    try {
      process.chdir(name);
    } catch (error) {
      closeSync(next);
      throw error;
    }
    this.#fd = next;
    try {
      this.#assertCwdIsPinned(displayPath);
    } finally {
      closeSync(previous);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#entryCwd !== undefined) process.chdir(this.#entryCwd);
    } finally {
      closeSync(this.#fd);
    }
  }

  #openChild(name: string): number {
    return openSync(this.leaf(name), PIN_DIRECTORY);
  }

  #openOrCreateChild(name: string, displayPath: string): number {
    try {
      const fd = this.#openChild(name);
      hardenPrivate(this.leaf(name), "dir");
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        try {
          mkdirSync(this.leaf(name), { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
      } else if (code === "ELOOP" || code === "ENOTDIR") {
        let isLink = code === "ELOOP";
        if (code === "ENOTDIR") {
          try {
            isLink = lstatSync(this.leaf(name)).isSymbolicLink();
          } catch (inner) {
            this.mapOpenError(inner, name, displayPath);
          }
        }
        if (!isLink) this.mapOpenError(error, name, displayPath);
        unlinkSync(this.leaf(name));
        mkdirSync(this.leaf(name), { mode: 0o700 });
      } else {
        this.mapOpenError(error, name, displayPath);
      }
      try {
        const fd = this.#openChild(name);
        hardenPrivate(this.leaf(name), "dir");
        return fd;
      } catch (retry) {
        this.mapOpenError(retry, name, displayPath);
      }
    }
  }

  /** A swap that lands between the descriptor open and the chdir leaves the process in the
   * attacker's directory rather than the pinned one. The inodes disagree, and nothing is written. */
  #assertCwdIsPinned(displayPath: string): void {
    if (!sameInode(statSync("."), fstatSync(this.#fd)))
      throw new Error(`refusing swapped Jcode credential mirror parent: ${displayPath}`);
  }

  mapOpenError(error: unknown, name: string, displayPath: string): never {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`refusing symlinked Jcode credential mirror parent: ${displayPath}`);
    if (code === "ENOTDIR") {
      // O_NOFOLLOW|O_DIRECTORY against a symlink returns ENOTDIR on Linux and macOS, not ELOOP.
      if (lstatSync(this.leaf(name)).isSymbolicLink())
        throw new Error(`refusing symlinked Jcode credential mirror parent: ${displayPath}`);
      throw new Error(`Jcode credential mirror parent is not a directory: ${displayPath}`);
    }
    throw error;
  }
}

function walkPinnedParents(home: string, parentRelative: string, pin: PinnedParent, create: boolean): void {
  let current = home;
  for (const part of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      pin.descend(part, current, create);
    } catch (error) {
      if (create || (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      pin.mapOpenError(error, part, current);
    }
  }
}

/** Remove only one exact connector-owned mirror destination. Each parent is opened with
 * O_NOFOLLOW|O_DIRECTORY through the previous fd, then the leaf is unlinked through that pinned
 * parent. A parent swapped for a symlink after it was walked cannot redirect the unlink. Optional
 * `beforeUnlink` exists so the smoke can swap a parent between pin and unlink; production callers
 * omit it. */
export function removeCredentialMirror(home: string, destinationRelative: string, beforeUnlink?: () => void): boolean {
  const destination = credentialDestination(home, destinationRelative);
  const parentRelative = relative(home, dirname(destination));
  assertRelative(parentRelative);
  const base = basename(destination);

  let pin: PinnedParent;
  try {
    pin = PinnedParent.open(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    try {
      walkPinnedParents(home, parentRelative, pin, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    try {
      if (lstatSync(pin.leaf(base)).isDirectory())
        throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    beforeUnlink?.();
    try {
      unlinkSync(pin.leaf(base));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return true;
  } finally {
    pin.close();
  }
}

/** Copy one allowlisted credential through the same pinned-parent walk as removal. Optional
 * `beforeCopy` exists so the smoke can swap a parent between pin and copy; production callers omit it. */
export function copyCredentialFile(home: string, source: string, destinationRelative: string, beforeCopy?: () => void): boolean {
  assertRelative(destinationRelative);
  let sourceStats: ReturnType<typeof statSync>;
  try {
    sourceStats = statSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      removeCredentialMirror(home, destinationRelative);
      return false;
    }
    throw error;
  }
  if (!sourceStats.isFile()) {
    removeCredentialMirror(home, destinationRelative);
    return false;
  }

  const destination = credentialDestination(home, destinationRelative);
  const parentRelative = relative(home, dirname(destination));
  assertRelative(parentRelative);
  const base = basename(destination);
  const pin = PinnedParent.open(home);
  try {
    walkPinnedParents(home, parentRelative, pin, true);

    try {
      if (lstatSync(pin.leaf(base)).isDirectory())
        throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    beforeCopy?.();
    // Single-component temp under the pinned parent. A full-path temp re-resolves swapped ancestors.
    const tempName = `.${randomBytes(6).toString("hex")}.tmp`;
    const temp = pin.leaf(tempName);
    try {
      copyFileSync(source, temp, constants.COPYFILE_EXCL);
      hardenPrivate(temp, "file");
      renameSync(temp, pin.leaf(base));
    } finally {
      rmSync(temp, { force: true });
    }
    if (lstatSync(pin.leaf(base)).isSymbolicLink())
      throw new Error(`Jcode credential mirror remained symlinked: ${destination}`);
    return true;
  } finally {
    pin.close();
  }
}

/** Open a pin and unlink one leaf through it, swapping the pinned directory in the window between
 * the descriptor open and the directory entry. Exported for the smoke only: it drives the one
 * window the two pin mechanisms close differently. */
export function unlinkThroughSwappedPinForTest(directory: string, name: string, beforeEnter: () => void): { unlinked: boolean; refusal: string | undefined } {
  let pin: PinnedParent;
  try {
    pin = PinnedParent.open(directory, beforeEnter);
  } catch (error) {
    return { unlinked: false, refusal: (error as Error).message };
  }
  try {
    unlinkSync(pin.leaf(name));
    return { unlinked: true, refusal: undefined };
  } catch (error) {
    return { unlinked: false, refusal: (error as Error).message };
  } finally {
    pin.close();
  }
}

function optionalEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface CredentialSources {
  jcodeHome: string;
  appConfigDir: string;
  externalHome: string;
}

export interface CredentialMirrorEntry {
  family: "jcode-home" | "app-config" | "external-static" | "external-agent";
  source: string;
  destinationRelative: string;
}

function credentialSources(): CredentialSources {
  return { jcodeHome: userJcodeHome(), appConfigDir: userAppConfigDir(), externalHome: homedir() };
}

/** The complete allowlisted credential mirror inventory for one reconciliation pass. Dynamic
 * families include both current source names and prior managed destinations, so removed names remain
 * addressable for exact cleanup. */
export function jcodeCredentialMirrorInventory(home: string, sources: CredentialSources): CredentialMirrorEntry[] {
  const inventory: CredentialMirrorEntry[] = JCODE_CREDENTIAL_FILES.map((name) => ({
    family: "jcode-home",
    source: join(sources.jcodeHome, name),
    destinationRelative: name,
  }));

  const appConfigNames = new Set([
    ...optionalEntries(sources.appConfigDir).filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".env")).map((entry) => entry.name),
    ...optionalEntries(join(home, "config", "jcode")).filter((entry) => !entry.isDirectory() && entry.name.endsWith(".env")).map((entry) => entry.name),
  ]);
  for (const name of [...appConfigNames].sort())
    inventory.push({ family: "app-config", source: join(sources.appConfigDir, name), destinationRelative: join("config", "jcode", name) });

  for (const relativePath of EXTERNAL_CREDENTIAL_FILES)
    inventory.push({ family: "external-static", source: join(sources.externalHome, relativePath), destinationRelative: join("external", relativePath) });

  const agents = join(sources.externalHome, ".openclaw", "agents");
  const agentNames = new Set([
    ...optionalEntries(agents).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    ...optionalEntries(join(home, "external", ".openclaw", "agents")).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  ]);
  for (const agent of [...agentNames].sort()) {
    for (const name of ["auth-profiles.json", "auth.json"]) {
      const relativePath = join(".openclaw", "agents", agent, "agent", name);
      inventory.push({ family: "external-agent", source: join(sources.externalHome, relativePath), destinationRelative: join("external", relativePath) });
    }
  }
  return inventory;
}

/** Copy the SDK-recognized provider material for this launch. The SDK's default inheritance links
 * rotating auth files; current jcode rejects those links in its external mirror, so the connector
 * owns a fresh, owner-only copy instead. */
export function mirrorJcodeCredentials(home: string, sources = credentialSources()): void {
  privateDirectory(home, { pin: true });
  for (const entry of jcodeCredentialMirrorInventory(home, sources))
    copyCredentialFile(home, entry.source, entry.destinationRelative);
}

export interface ShortSocketHome {
  /** A short alias to the managed JCODE_HOME passed to the SDK, keeping its hard-coded socket under 100 bytes. */
  jcodeHome: string;
  /** The real, owner-only directory that owns the short alias. */
  socketDir: string;
  dispose(): void;
}

/**
 * The current SDK derives `run/jcode-api.sock` beneath `jcodeHome` and has no socket-path launch
 * option. Keep managed state at its normal workspace location and pass it through a short private
 * alias instead. The SDK's resulting API pathname is bounded before it reaches AF_UNIX.
 */
export function shortSocketHome(home: string): ShortSocketHome {
  const id = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12);
  const socketDir = join("/tmp", `jc-${id}`);
  privateDirectory(socketDir, { requireOwner: true, pin: false });
  const alias = join(socketDir, "home");
  try {
    const stats = lstatSync(alias);
    if (!stats.isSymbolicLink()) throw new Error(`Jcode short socket alias is not a symlink: ${alias}`);
    rmSync(alias, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // `home` was made and checked as an owner-only real directory before this call. The alias is
  // inside our 0700 directory and exists only to shrink the SDK's fixed `run/jcode-api.sock` path.
  // A failure here has no long-path fallback: that would reintroduce the SUN_LEN startup failure.
  try {
    symlinkSync(home, alias, "dir");
  } catch (error) {
    throw new Error(`cannot create Jcode short API socket alias ${alias}: ${(error as Error).message}`);
  }
  const apiSocket = join(alias, "run", "jcode-api.sock");
  if (Buffer.byteLength(apiSocket) >= MAX_API_SOCKET_BYTES) {
    rmSync(alias, { force: true });
    throw new Error(`Jcode API socket path is too long even in its private short directory: ${apiSocket}`);
  }
  return {
    jcodeHome: alias,
    socketDir,
    dispose: () => {
      rmSync(alias, { force: true });
      try {
        rmdirSync(socketDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
