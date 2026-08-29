import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync, type Dirent } from "node:fs";
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
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_DIGEST = /^sha256:[0-9a-f]{64}$/;

type ManagedSkillsManifest = { skills: Record<string, string> };

function skillDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function managedSkillsManifestPath(home: string): string {
  return join(home, "cotal-agent-skills.json");
}

function readManagedSkillsManifest(home: string): ManagedSkillsManifest {
  const path = managedSkillsManifestPath(home);
  let raw: string;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`managed Jcode skills manifest is not a real file: ${path}`);
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { skills: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt managed Jcode skills manifest at ${path}`);
  }
  const skills = (parsed as { skills?: unknown })?.skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills))
    throw new Error(`Corrupt managed Jcode skills manifest at ${path}`);
  for (const [name, digest] of Object.entries(skills as Record<string, unknown>))
    if (name.length > 64 || !SKILL_NAME.test(name) || typeof digest !== "string" || !SKILL_DIGEST.test(digest))
      throw new Error(`Corrupt managed Jcode skills manifest at ${path}`);
  return { skills: skills as Record<string, string> };
}

function writeManagedSkillsManifest(home: string, manifest: ManagedSkillsManifest): void {
  const path = managedSkillsManifestPath(home);
  const tmp = `${path}.tmp.${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
  hardenPrivate(path, "file");
}

function backupManagedSkill(path: string, bytes: Buffer): void {
  for (let i = 0; i < 1000; i++) {
    const backup = i === 0 ? `${path}.bak` : `${path}.bak.${i}`;
    try {
      writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
      hardenPrivate(backup, "file");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not back up managed Jcode skill ${path}: too many existing backups`);
}

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

function copyCredentialFile(home: string, source: string, destinationRelative: string): boolean {
  assertRelative(destinationRelative);
  let sourceStats: ReturnType<typeof statSync>;
  try {
    sourceStats = statSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!sourceStats.isFile()) return false;

  const destination = join(home, destinationRelative);
  if (!resolve(destination).startsWith(resolve(home) + sep)) throw new Error(`Jcode credential mirror escapes its private home: ${destination}`);
  mirrorParent(home, destination);
  // The parent is owner-only and verified above. Remove a prior SDK link before copying: jcode
  // 0.78 rejects external auth symlinks as a TOCTOU defense, and copies are deliberately refreshed
  // at every launch rather than pretending rotating credentials stay coherent indefinitely.
  try {
    if (lstatSync(destination).isDirectory()) throw new Error(`Jcode credential mirror destination is a directory: ${destination}`);
    rmSync(destination, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  copyFileSync(source, destination);
  hardenPrivate(destination, "file");
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

function credentialSources(): CredentialSources {
  return { jcodeHome: userJcodeHome(), appConfigDir: userAppConfigDir(), externalHome: homedir() };
}

/** Copy the SDK-recognized provider material for this launch. The SDK's default inheritance links
 * rotating auth files; current jcode rejects those links in its external mirror, so the connector
 * owns a fresh, owner-only copy instead. */
export function mirrorJcodeCredentials(home: string, sources = credentialSources()): void {
  privateDirectory(home);
  for (const name of JCODE_CREDENTIAL_FILES) copyCredentialFile(home, join(sources.jcodeHome, name), name);

  for (const entry of optionalEntries(sources.appConfigDir)) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".env")) continue;
    copyCredentialFile(home, join(sources.appConfigDir, entry.name), join("config", "jcode", entry.name));
  }

  for (const relativePath of EXTERNAL_CREDENTIAL_FILES)
    copyCredentialFile(home, join(sources.externalHome, relativePath), join("external", relativePath));

  const agents = join(sources.externalHome, ".openclaw", "agents");
  for (const agent of optionalEntries(agents)) {
    if (!agent.isDirectory()) continue;
    for (const name of ["auth-profiles.json", "auth.json"]) {
      const relativePath = join(".openclaw", "agents", agent.name, "agent", name);
      copyCredentialFile(home, join(sources.externalHome, relativePath), join("external", relativePath));
    }
  }
}

/** Mirror the running Cotal generation's canonical skills into the private JCODE_HOME sandbox.
 * Jcode resolves the shared user convention beneath `$JCODE_HOME/external/.agents/skills`, so a
 * managed seat cannot see the operator-level `~/.agents/skills` drop directly. The connector copies
 * the same CLI-owned bytes before every private launch, replacing only Cotal's named `SKILL.md`
 * entries. No operator or third-party private-home files are removed. */
export function mirrorJcodeSkills(home: string, sourceDir: string): string[] {
  privateDirectory(home);
  const sourceRoot = resolve(sourceDir);
  const sourceRootStats = lstatSync(sourceRoot);
  if (!sourceRootStats.isDirectory() || sourceRootStats.isSymbolicLink())
    throw new Error(`Cotal skills source is not a real directory: ${sourceRoot}`);
  const destinationRoot = join(home, "external", ".agents", "skills");
  const manifest = readManagedSkillsManifest(home);
  let manifestChanged = false;
  const names: string[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.length > 64 || !SKILL_NAME.test(entry.name))
      throw new Error(`Cotal skill dir ${JSON.stringify(entry.name)} has an illegal name`);
    const source = join(sourceRoot, entry.name, "SKILL.md");
    const sourceStats = lstatSync(source);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink())
      throw new Error(`Cotal skill ${JSON.stringify(entry.name)} has no real SKILL.md at ${source}`);
    const destination = join(destinationRoot, entry.name, "SKILL.md");
    mirrorParent(home, destination);
    const bytes = readFileSync(source);
    const digest = skillDigest(bytes);
    try {
      const stats = lstatSync(destination);
      if (stats.isDirectory()) throw new Error(`Jcode managed skill destination is a directory: ${destination}`);
      if (stats.isFile() && !stats.isSymbolicLink() && readFileSync(destination).equals(bytes)) {
        if (manifest.skills[entry.name] !== digest) {
          manifest.skills[entry.name] = digest;
          manifestChanged = true;
        }
        names.push(entry.name);
        continue;
      }
      const current = readFileSync(destination);
      if (manifest.skills[entry.name] !== skillDigest(current)) backupManagedSkill(destination, current);
      rmSync(destination, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const tmp = `${destination}.tmp.${process.pid}`;
    rmSync(tmp, { force: true });
    let fd: number;
    try {
      fd = openSync(tmp, "wx", 0o600);
    } catch (error) {
      throw new Error(`refusing to stage Jcode managed skill at ${tmp}: ${(error as Error).message}`);
    }
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, destination);
    hardenPrivate(destination, "file");
    if (manifest.skills[entry.name] !== digest) manifestChanged = true;
    manifest.skills[entry.name] = digest;
    names.push(entry.name);
  }
  if (!names.length) throw new Error(`No Cotal skills found in ${sourceRoot}`);
  for (const name of Object.keys(manifest.skills)) {
    if (names.includes(name)) continue;
    const destination = join(destinationRoot, name, "SKILL.md");
    try {
      const stats = lstatSync(destination);
      if (stats.isDirectory()) throw new Error(`Jcode managed skill destination is a directory: ${destination}`);
      const current = readFileSync(destination);
      if (manifest.skills[name] !== skillDigest(current)) backupManagedSkill(destination, current);
      rmSync(destination);
      const dir = dirname(destination);
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    delete manifest.skills[name];
    manifestChanged = true;
  }
  if (manifestChanged) writeManagedSkillsManifest(home, manifest);
  return names.sort();
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
