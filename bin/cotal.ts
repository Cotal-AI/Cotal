#!/usr/bin/env node
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";

const MIN_NODE = "22.10";
const [MIN_MAJOR, MIN_MINOR] = MIN_NODE.split(".").map(Number) as [number, number];

function supportedNode(version = process.versions.node): boolean {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] || "", 10);
  const minor = Number.parseInt(parts[1] || "", 10);
  return Number.isInteger(major) && Number.isInteger(minor) &&
    (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR));
}

if (supportedNode()) {
  setFlagsFromString("--no-maglev");
  setFlagsFromString("--no-concurrent-sparkplug");
}

/** Refuse runtimes below the Node floor before touching V8 flags, retained stores, or package code. */
export function ensureSupportedNode(): void {
  if (supportedNode()) return;
  const viaInstaller = process.env.COTAL_LAUNCHER === "1";
  const remedy = viaInstaller
    ? `The Node this install was pinned to has been replaced with an older one.\n` +
      `Re-run the installer to repin it:\n  curl -fsSL https://get.cotal.ai | sh\n\n` +
      `Or stop depending on the system Node altogether:\n  curl -fsSL https://get.cotal.ai | sh -s -- --vendor-node\n\n`
    : `Install a newer Node (https://nodejs.org). With nvm:\n  nvm install ${MIN_NODE} && nvm use ${MIN_NODE}\n\n` +
      `If you already ran cotal once under the old Node, also clear the npx cache so the bundled\n` +
      `nats-server is fetched cleanly, then retry:\n  rm -rf ~/.npm/_npx        # or: npx clear-npx-cache\n\n` +
      `Or let the installer manage the runtime for you:\n  curl -fsSL https://get.cotal.ai | sh\n\n`;
  process.stderr.write(`\ncotal-ai requires Node.js >= ${MIN_NODE}, but this is ${process.version}.\n` +
    `Below Node ${MIN_MAJOR}, npm silently skips the bundled nats-server broker and the CLI's UI\n` +
    `stack cannot parse. Below ${MIN_NODE}, Node has no module compile cache and a seat refuses to\nstart.\n\n` + remedy);
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  for (const [key, path] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "COTAL_MANAGED_HANDOFF_FILE" || !path || (command !== "spawn" && command !== "sp")) continue;
    try { unlinkSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`cannot remove the managed handoff file: ${(error as Error).message}\n`);
    }
  }
  process.exit(1);
}

export interface ExecutionBinding { name: "cotal-ai"; version: string; bootstrapSha256: string }
export interface ExecutionDescriptor {
  v: 1;
  binding: ExecutionBinding;
  bindings?: ExecutionBinding[];
  launch?: { entry: string; path: string; dev: string; ino: string; birth: string; ctime: string };
  generation: { id: string; version: string; inventorySha256: string };
}
export interface ExecutionInventoryEntry { path: string; sha256?: string; link?: string }
export const executionDescriptorName = ".cotal-execution.json";
export const executionSha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid execution record");
  return value as Record<string, unknown>;
}

export function executionRecord(path: string): unknown {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES) throw new Error("unsafe execution record");
  protectedExecutionEntry(path);
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.size > MAX_RECORD_BYTES ||
        (process.platform !== "win32" && ((current.mode & 0o022) !== 0 ||
          typeof process.getuid !== "function" || (current.uid !== process.getuid() && current.uid !== 0))))
      throw new Error("unsafe opened execution record");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("execution record exceeded its size limit");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally { closeSync(fd); }
}

/** Read-only checks on a retained object. A missing or unreadable object is never a healthy generation. */
export function protectedExecutionEntry(path: string): void {
  const info = lstatSync(path);
  if (process.platform !== "win32" && ((!info.isSymbolicLink() && (info.mode & 0o022) !== 0) ||
      typeof process.getuid !== "function" || (info.uid !== process.getuid() && info.uid !== 0)))
    throw new Error(`unprotected execution entry: ${path}`);
}

/** The installed package folder and the folders above it belong to the package manager. An account
 *  that can write one of them can already replace this bootstrap, so their modes are no boundary:
 *  Homebrew keeps `lib` group-writable, and npm under a umask of 0002 creates the package
 *  group-writable. Only another account's ownership is refused. */
export function executionLocation(path: string): void {
  const info = lstatSync(path);
  if (process.platform !== "win32" && (typeof process.getuid !== "function" || (info.uid !== process.getuid() && info.uid !== 0)))
    throw new Error(`execution location belongs to another account: ${path}`);
}

/** Whether accounts other than the owner run this installation: they can read and search its
 *  package folder. The generation store beside it is then as readable as the package, and never
 *  writable by them. */
export function executionShared(installed: string): boolean {
  return process.platform !== "win32" && (lstatSync(installed).mode & 0o005) === 0o005;
}

const PUBLISHED = /\n\/\/ cotal execution publication [a-f0-9]{32}\n$/;

/** 0.164.16 and 0.164.17 kept the store, its records and the published bootstrap private to the
 *  updating account, which locked every other account out of a system-wide installation. The
 *  store's owner opens them for reading here. */
function shareExecutionStore(installed: string): void {
  try {
    if (typeof process.getuid !== "function" || !executionShared(installed)) return;
    const store = executionStore(installed), info = lstatSync(store, { throwIfNoEntry: false });
    if (!info || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o005) === 0o005) return;
    const open = (path: string, directory: boolean): void => {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (entry && (directory ? entry.isDirectory() : entry.isFile())) chmodSync(path, directory ? 0o755 : 0o644);
    };
    for (const name of readdirSync(store)) {
      if (ID.test(name)) { open(join(store, name), true); open(join(store, name, "inventory.json"), false); }
      else if (/^\.active-[a-f0-9]{64}\.json$/.test(name)) open(join(store, name), false);
    }
    const bootstrap = join(installed, "dist", "cotal.js");
    if (PUBLISHED.test(readFileSync(bootstrap, "utf8"))) chmodSync(bootstrap, 0o755);
    chmodSync(store, 0o755);
  } catch { /* the store stays private to its owner, as it was */ }
}

export function executionBinding(root: string): ExecutionBinding {
  const meta = object(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  if (meta.name !== "cotal-ai" || typeof meta.version !== "string" || !meta.version)
    throw new Error("the installed execution artifact is not cotal-ai");
  return { name: "cotal-ai", version: meta.version, bootstrapSha256: executionSha256(readFileSync(join(root, "dist", "cotal.js"))) };
}

export function executionStore(root: string): string {
  return join(dirname(dirname(root)), ".cotal-generations");
}

/** Enumerate the whole package, including dependencies, without following a link outside it. */
export function executionInventory(root: string): ExecutionInventoryEntry[] {
  const physical = realpathSync.native(root);
  const rows: ExecutionInventoryEntry[] = [];
  const walk = (directory: string, prefix: string): void => {
    protectedExecutionEntry(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      protectedExecutionEntry(path);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path), resolved = realpathSync.native(path), suffix = relative(physical, resolved);
        if (isAbsolute(target) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
          throw new Error(`execution inventory link escapes its package: ${name}`);
        rows.push({ path: name, link: target });
      } else if (entry.isFile()) rows.push({ path: name, sha256: executionSha256(readFileSync(path)) });
      else throw new Error(`unsupported execution inventory entry: ${name}`);
    }
  };
  walk(physical, "");
  return rows;
}

export function executionLaunchBinding(root: string, entry: string): NonNullable<ExecutionDescriptor["launch"]> {
  const logical = resolve(entry), physical = realpathSync.native(logical);
  const canonicalRoot = realpathSync.native(root);
  if (physical !== join(canonicalRoot, "dist", "cotal.js")) throw new Error("execution launch route does not resolve to this bootstrap");
  let path = join(canonicalRoot, "package.json");
  for (let current = dirname(logical); current !== dirname(current); current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) { path = current; break; }
  }
  const info = lstatSync(path, { bigint: true });
  return { entry: logical, path, dev: String(info.dev), ino: String(info.ino), birth: String(info.birthtimeNs), ctime: String(info.ctimeNs) };
}

export function executionDescriptorPath(root: string): string {
  return join(executionStore(root), `.active-${executionSha256(realpathSync.native(root))}.json`);
}

/** Select a verified program, or the installed first generation when no matching descriptor exists. */
export function selectExecutionProgram(root: string): { root: string; entry: string; retained: boolean } {
  const installed = realpathSync.native(root), descriptorPath = executionDescriptorPath(installed);
  const initial = () => ({ root: installed, entry: import.meta.url.endsWith(".ts") && installed === realpathSync.native(dirname(fileURLToPath(import.meta.url)))
    ? join(installed, "cotal-program.ts") : join(installed, "dist", "cotal-program.js"), retained: false });
  if (existsSync(join(installed, "desktop-runtime.json"))) {
    if (existsSync(descriptorPath) || existsSync(executionStore(installed)))
      throw new Error("retained execution generations are unavailable on the desktop runtime");
    return initial();
  }
  shareExecutionStore(installed);
  let value: unknown;
  try { value = executionRecord(descriptorPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return initial();
    // Another account's store that this account cannot read. A bootstrap the package manager
    // installed carries no publication line, and no descriptor selects a generation for it.
    if ((code === "EACCES" || code === "EPERM") && !PUBLISHED.test(readFileSync(join(installed, "dist", "cotal.js"), "utf8"))) return initial();
    throw error;
  }
  const descriptor = object(value), binding = object(descriptor.binding), current = executionBinding(installed);
  if (typeof binding.name !== "string" || typeof binding.version !== "string" || !binding.version ||
      typeof binding.bootstrapSha256 !== "string" || !HASH.test(binding.bootstrapSha256)) throw new Error("invalid execution artifact binding");
  if (descriptor.launch !== undefined) {
    const launch = object(descriptor.launch);
    if (!["entry", "path", "dev", "ino", "birth", "ctime"].every(key => typeof launch[key] === "string") || !isAbsolute(launch.entry as string) || !isAbsolute(launch.path as string))
      throw new Error("invalid execution launch binding");
    try { if (JSON.stringify(executionLaunchBinding(installed, launch.entry as string)) !== JSON.stringify(launch)) return initial(); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return initial(); throw error; }
  }
  const matches = (candidate: Record<string, unknown>): boolean => candidate.name === current.name && candidate.version === current.version && candidate.bootstrapSha256 === current.bootstrapSha256;
  if (descriptor.bindings !== undefined && (!Array.isArray(descriptor.bindings) || descriptor.bindings.length > 4 ||
      descriptor.bindings.some(value => { const item = object(value); return item.name !== "cotal-ai" || typeof item.version !== "string" || !item.version || typeof item.bootstrapSha256 !== "string" || !HASH.test(item.bootstrapSha256); })))
    throw new Error("invalid execution transition bindings");
  const transition = descriptor.bindings as Record<string, unknown>[] | undefined;
  if (!matches(binding) && (!transition || !transition.some(matches))) return initial();
  if (descriptor.v !== 1) throw new Error(`unsupported execution descriptor version ${String(descriptor.v)}`);
  if (process.platform === "win32") throw new Error("retained execution generations are unavailable on Windows");
  const generation = object(descriptor.generation);
  if (typeof generation.id !== "string" || !ID.test(generation.id) || typeof generation.version !== "string" ||
      typeof generation.inventorySha256 !== "string" || !HASH.test(generation.inventorySha256)) throw new Error("invalid retained execution identity");
  for (const path of [installed, dirname(installed), dirname(dirname(installed)), dirname(dirname(dirname(installed)))]) executionLocation(path);
  const store = executionStore(installed), container = join(store, generation.id), selected = join(container, "cotal-ai");
  for (const path of [store, container, selected]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe execution generation directory");
    protectedExecutionEntry(path);
  }
  const canonicalSelected = realpathSync.native(selected);
  const inventory = executionRecord(join(container, "inventory.json"));
  if (!Array.isArray(inventory) || executionSha256(JSON.stringify(inventory)) !== generation.inventorySha256 ||
      JSON.stringify(executionInventory(canonicalSelected)) !== JSON.stringify(inventory)) throw new Error("retained execution inventory differs");
  const meta = object(JSON.parse(readFileSync(join(canonicalSelected, "package.json"), "utf8")));
  if (meta.name !== "cotal-ai" || meta.version !== generation.version) throw new Error("retained execution manifest differs");
  return { root: canonicalSelected, entry: join(canonicalSelected, "dist", "cotal-program.js"), retained: true };
}

const executionStarted = Symbol.for("cotal.execution.started");
/** Whether Node was started on this file. Both sides go through the native canonical path, because
 *  Node keeps a Windows extended-length (`\\?\`) or short-name spelling in `argv[1]` and not in the
 *  module URL. */
function startedHere(): boolean {
  return !!process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
}

/** Set by an updater that gives its retained copy explicit modes. */
export const executionCopyModesEnv = "COTAL_EXECUTION_COPY_MODES";

/** Whether this Node applies the process umask to the folders a recursive `cpSync` creates, as Node
 *  before 24.22 does, and that umask leaves group or other write. */
function copiesSharedWrite(): boolean {
  const umask = process.umask(0o022);
  process.umask(umask);
  if ((umask & 0o022) === 0o022) return false;
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "cotal-copy-probe-"));
    mkdirSync(join(scratch, "from"), { mode: 0o700 });
    fs.cpSync(join(scratch, "from"), join(scratch, "to"), { recursive: true });
    return (lstatSync(join(scratch, "to")).mode & 0o022) !== 0;
  } catch { return false; }
  finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** The 0.164.16 and 0.164.17 updaters start the staged target once for its version line, then copy
 *  it with `cpSync`, refuse a copy with group-writable folders, and read the daemon's paths, which
 *  throws on Linux without `XDG_RUNTIME_DIR`. Where either holds they refuse every attempt and leave
 *  what they staged behind. This target cannot change that process, so it names the one-time manual
 *  install, removes the staged installs and fails the version check. Returns whether it did. */
function refuseDoomedStagedCheck(root: string): boolean {
  if (process.platform === "win32" || process.argv.length !== 3 || process.argv[2] !== "--version" ||
      process.env.COTAL_SKIP_CONNECTOR_SEED !== "1" || process.env[executionCopyModesEnv] === "explicit") return false;
  const prefix = dirname(dirname(dirname(root))), store = dirname(prefix);
  if (basename(dirname(root)) !== "node_modules" || basename(dirname(dirname(root))) !== "lib" ||
      !/^\.installing-[A-Za-z0-9]{6}$/.test(basename(prefix)) || basename(store) !== ".cotal-generations") return false;
  const reason = process.platform === "linux" && !process.env.XDG_RUNTIME_DIR ? "it needs XDG_RUNTIME_DIR, which this session does not set"
    : copiesSharedWrite() ? "its Node copies the new version with group-writable folders under the current umask, then refuses its own copy" : undefined;
  if (!reason) return false;
  const home = dirname(dirname(store));
  const remedy = existsSync(join(home, "nodebin"))
    ? "run the installer from get.cotal.ai again"
    : `run npm install -g --prefix ${home} cotal-ai@latest`;
  process.stderr.write(`the installed Cotal updater cannot finish here: ${reason}. Install the new version once by hand: ${remedy}. Later updates run on their own`);
  for (const name of readdirSync(store)) {
    if (/^\.installing-[A-Za-z0-9]{6}$/.test(name)) try { fs.rmSync(join(store, name), { recursive: true, force: true }); } catch { /* the next attempt removes it */ }
  }
  process.exitCode = 1;
  return true;
}

/** Explicit CLI delegation for a wrapper that imports the bootstrap rather than launching it. */
export function startExecutionProgram(): void {
  if (Reflect.get(globalThis, executionStarted)) return;
  Object.defineProperty(globalThis, executionStarted, { value: true });
  ensureSupportedNode();
  let selected: ReturnType<typeof selectExecutionProgram> | undefined;
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith(".ts") ? "." : "..");
  if (startedHere() && refuseDoomedStagedCheck(realpathSync.native(packageRoot))) return;
  try { selected = selectExecutionProgram(packageRoot); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}; reinstall with npm install -g cotal-ai@latest\n`);
    process.exitCode = 1;
  }
  if (selected) {
    const direct = startedHere();
    if (!import.meta.url.endsWith(".ts")) {
      const logicalEntry = realpathSync.native(fileURLToPath(import.meta.url));
      const loadedEntry = realpathSync.native(join(selected.root, "dist", "cotal.js"));
      const launchEntry = direct ? resolve(process.argv[1]!) : logicalEntry;
      Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), {
        value: Object.freeze({ logicalEntry, launchEntry, loadedEntry }),
        configurable: false, writable: false,
      });
    }
    if (selected.retained || !direct) process.argv[1] = join(selected.root, "dist", "cotal.js");
    void import(pathToFileURL(selected.entry).href);
  }
}
if (startedHere()) startExecutionProgram();
