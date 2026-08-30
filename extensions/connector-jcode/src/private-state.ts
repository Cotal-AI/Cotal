import { createHash, randomBytes } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function privateDirectory(path: string, { replaceSymlink = false, requireOwner = false }: { replaceSymlink?: boolean; requireOwner?: boolean } = {}): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      if (!replaceSymlink) throw new Error(`refusing symlinked Jcode private directory: ${path}`);
      rmSync(path, { force: true });
      mkdirSync(path, { mode: 0o700 });
    } else if (!stats.isDirectory()) {
      throw new Error(`Jcode private path is not a directory: ${path}`);
    } else if (requireOwner) {
      assertCurrentUserOwns(path, stats.uid);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  hardenPrivate(path, "dir");
  // Verify owner after creation and hardening as well. On POSIX a privileged process can chmod an
  // attacker-owned /tmp directory, so permissions alone never establish namespace ownership.
  if (requireOwner) assertCurrentUserOwns(path, lstatSync(path).uid);
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

function mirrorParent(home: string, destination: string): void {
  const rel = relative(home, dirname(destination));
  assertRelative(rel);
  let current = home;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    // A pre-0.78 SDK could have linked a whole external credential directory. Replace exactly
    // that link before writing: every launch re-copies this private mirror, so no stale link or
    // copied OAuth material survives to the next seat startup.
    privateDirectory(current, { replaceSymlink: true });
  }
}

function credentialDestination(home: string, destinationRelative: string): string {
  assertRelative(destinationRelative);
  const destination = join(home, destinationRelative);
  if (!resolve(destination).startsWith(resolve(home) + sep)) throw new Error(`Jcode credential mirror escapes its private home: ${destination}`);
  return destination;
}

/** Remove only one connector-owned mirror destination. Parent components are checked without
 * following symlinks, so reconciling an absent source cannot delete outside `home`. */
function removeCredentialMirror(home: string, destinationRelative: string): boolean {
  const destination = credentialDestination(home, destinationRelative);
  let current = home;
  const parentRelative = relative(home, dirname(destination));
  assertRelative(parentRelative);
  for (const part of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) throw new Error(`refusing symlinked Jcode credential mirror parent: ${current}`);
      if (!stats.isDirectory()) throw new Error(`Jcode credential mirror parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    if (lstatSync(destination).isDirectory()) throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
    rmSync(destination, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function copyCredentialFile(home: string, source: string, destinationRelative: string): boolean {
  assertRelative(destinationRelative);
  let sourceStats: ReturnType<typeof statSync> | undefined;
  try {
    sourceStats = statSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!sourceStats?.isFile()) {
    removeCredentialMirror(home, destinationRelative);
    return false;
  }

  const destination = credentialDestination(home, destinationRelative);
  mirrorParent(home, destination);
  // The parent is owner-only and verified above. Remove a prior SDK link before copying: jcode
  // 0.78 rejects external auth symlinks as a TOCTOU defense, and copies are deliberately refreshed
  // at every launch rather than pretending rotating credentials stay coherent indefinitely.
  try {
    if (lstatSync(destination).isDirectory()) throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Copy + harden off to the side, then rename over the old regular file or symlink. Jcode is
  // POSIX-only; rename is the publication boundary, so a login rotation never exposes a missing or
  // half-written credential between generations.
  const temp = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    hardenPrivate(temp, "file");
    renameSync(temp, destination);
  } finally {
    rmSync(temp, { force: true });
  }
  if (lstatSync(destination).isSymbolicLink()) throw new Error(`Jcode credential mirror remained symlinked: ${destination}`);
  return true;
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
 * families include both current source names and prior managed destinations, so removed names
 * remain addressable for cleanup. */
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

  const agentNames = new Set([
    ...optionalEntries(join(sources.externalHome, ".openclaw", "agents")).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
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
  privateDirectory(home);
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
  privateDirectory(socketDir, { requireOwner: true });
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
