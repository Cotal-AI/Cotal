import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, type Dirent } from "node:fs";
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
  const dirFd = openPinnedRoot(parent);
  try {
    const leaf = containedPath(dirFd, name);
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
    closeSync(dirFd);
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

/** Path relative to an already-open directory fd. O_NOFOLLOW on `open` only applies to the last
 * component, so a swapped ancestor still redirects a full-path open. `/dev/fd/<fd>/<name>` is the
 * openat/unlinkat equivalent Node does not expose; it names the pinned inode, not the original path. */
function containedPath(dirFd: number, name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0"))
    throw new Error(`unsafe Jcode credential mirror path component: ${name}`);
  return `/dev/fd/${dirFd}/${name}`;
}

function openContainedDir(dirFd: number, name: string): number {
  return openSync(containedPath(dirFd, name), PIN_DIRECTORY);
}

function pinUnsupportedMessage(detail: string): string {
  return `Jcode credential mirroring requires /dev/fd subpath traversal to pin parent directories (${detail}). macOS /dev/fd has no subpath namespace under a descriptor, so this path is Linux-only`;
}

function assertLinuxPin(): void {
  if (process.platform !== "linux") throw new Error(pinUnsupportedMessage(`platform ${process.platform}`));
}

/** Existence of `/dev/fd` is not enough: macOS mounts it, but lookup of `/dev/fd/<n>/<name>` is an
 * error. Probe traversal through an already-open directory fd before treating ENOENT as "absent". */
function assertPinnedFdTraversal(dirFd: number): void {
  const probe = `/dev/fd/${dirFd}/.`;
  let probeFd: number;
  try {
    probeFd = openSync(probe, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    throw new Error(pinUnsupportedMessage(`opening ${probe} failed with ${(error as NodeJS.ErrnoException).code ?? "unknown"}`));
  }
  closeSync(probeFd);
}

function openPinnedRoot(home: string): number {
  assertLinuxPin();
  const dirFd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assertPinnedFdTraversal(dirFd);
    return dirFd;
  } catch (error) {
    closeSync(dirFd);
    throw error;
  }
}

function mapPinnedOpenError(error: unknown, dirFd: number, name: string, displayPath: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") throw new Error(`refusing symlinked Jcode credential mirror parent: ${displayPath}`);
  if (code === "ENOTDIR") {
    // O_NOFOLLOW|O_DIRECTORY against a symlink returns ENOTDIR on this kernel, not ELOOP.
    if (lstatSync(containedPath(dirFd, name)).isSymbolicLink())
      throw new Error(`refusing symlinked Jcode credential mirror parent: ${displayPath}`);
    throw new Error(`Jcode credential mirror parent is not a directory: ${displayPath}`);
  }
  throw error;
}

function openOrCreateContainedDir(dirFd: number, name: string, displayPath: string): number {
  try {
    const fd = openContainedDir(dirFd, name);
    hardenPrivate(containedPath(dirFd, name), "dir");
    return fd;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      try {
        mkdirSync(containedPath(dirFd, name), { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
    } else if (code === "ELOOP" || code === "ENOTDIR") {
      let isLink = code === "ELOOP";
      if (code === "ENOTDIR") {
        try {
          isLink = lstatSync(containedPath(dirFd, name)).isSymbolicLink();
        } catch (inner) {
          mapPinnedOpenError(inner, dirFd, name, displayPath);
        }
      }
      if (!isLink) mapPinnedOpenError(error, dirFd, name, displayPath);
      unlinkSync(containedPath(dirFd, name));
      mkdirSync(containedPath(dirFd, name), { mode: 0o700 });
    } else {
      mapPinnedOpenError(error, dirFd, name, displayPath);
    }
    try {
      const fd = openContainedDir(dirFd, name);
      hardenPrivate(containedPath(dirFd, name), "dir");
      return fd;
    } catch (retry) {
      mapPinnedOpenError(retry, dirFd, name, displayPath);
    }
  }
}

function walkPinnedParents(home: string, parentRelative: string, holder: { fd: number }, create: boolean): void {
  let current = home;
  for (const part of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, part);
    let next: number;
    try {
      next = create ? openOrCreateContainedDir(holder.fd, part, current) : openContainedDir(holder.fd, part);
    } catch (error) {
      if (create || (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      mapPinnedOpenError(error, holder.fd, part, current);
    }
    closeSync(holder.fd);
    holder.fd = next;
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

  let holder: { fd: number };
  try {
    holder = { fd: openPinnedRoot(home) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    try {
      walkPinnedParents(home, parentRelative, holder, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    try {
      if (lstatSync(containedPath(holder.fd, base)).isDirectory())
        throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    beforeUnlink?.();
    try {
      unlinkSync(containedPath(holder.fd, base));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return true;
  } finally {
    closeSync(holder.fd);
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
  const holder = { fd: openPinnedRoot(home) };
  try {
    walkPinnedParents(home, parentRelative, holder, true);

    try {
      if (lstatSync(containedPath(holder.fd, base)).isDirectory())
        throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    beforeCopy?.();
    // Single-component temp under the pinned parent. A full-path temp re-resolves swapped ancestors.
    const tempName = `.${randomBytes(6).toString("hex")}.tmp`;
    const temp = containedPath(holder.fd, tempName);
    try {
      copyFileSync(source, temp, constants.COPYFILE_EXCL);
      hardenPrivate(temp, "file");
      renameSync(temp, containedPath(holder.fd, base));
    } finally {
      rmSync(temp, { force: true });
    }
    if (lstatSync(containedPath(holder.fd, base)).isSymbolicLink())
      throw new Error(`Jcode credential mirror remained symlinked: ${destination}`);
    return true;
  } finally {
    closeSync(holder.fd);
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
