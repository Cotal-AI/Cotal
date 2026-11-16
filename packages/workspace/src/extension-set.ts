import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirNoSymlink, realDirNoSymlink, globalConfigDir, processStartToken } from "@cotal-ai/core";
import { executionIdentity, logicalExecutionEntry } from "./execution-identity.js";
import { acquireLock, inspectLock } from "./advisory-lock.js";
import { nativeWin32CreationToken } from "./win32-process.js";
import { protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function pnpmContentPath(path: string): boolean {
  return /[/\\\\]store[/\\\\]v[0-9]+[/\\\\]links[/\\\\]@[/\\\\]cotal-ai[/\\\\][^/\\\\]+[/\\\\][^/\\\\]+[/\\\\]node_modules[/\\\\]cotal-ai(?:[/\\\\]dist[/\\\\]cotal\.js)?$/.test(path);
}

/** Stable package-manager destination, including pnpm's link outside its versioned virtual store. */
export function extensionInstallationRoot(packageRoot: string): string {
  const root = resolve(packageRoot);
  if (pnpmContentPath(root)) throw new Error(`pnpm connector installation requires its validated global launch entry, not ${root}`);
  const parts = root.split(/[\\/]/);
  const retained = parts.lastIndexOf(".cotal-generations");
  if (retained >= 0 && retained + 3 === parts.length && /^[a-f0-9]{32}$/.test(parts[retained + 1] ?? "") && parts[retained + 2] === "cotal-ai")
    return extensionInstallationRoot(join(parts.slice(0, retained).join("/") || "/", "node_modules", "cotal-ai"));
  const global = parts.findIndex((part, index) => part === "global" && /^v[0-9]+$/.test(parts[index + 1] ?? "") && parts[index + 3] === "node_modules" && parts[index + 4] === "cotal-ai");
  if (global >= 0 && global + 5 === parts.length) return join(parts.slice(0, global + 2).join("/") || "/", "node_modules", "cotal-ai");
  const at = parts.lastIndexOf(".pnpm");
  return at >= 0 ? join(parts.slice(0, at).join("/") || "/", "cotal-ai") : root;
}

function packageRoot(): string {
  const identity = executionIdentity();
  if (identity && pnpmContentPath(identity.logicalEntry)) {
    const launch = identity.launchEntry;
    const root = launch ? dirname(dirname(launch)) : undefined;
    if (!root || !/[/\\\\]global[/\\\\]v[0-9]+[/\\\\][^/\\\\]+[/\\\\]node_modules[/\\\\]cotal-ai$/.test(root))
      throw new Error(`pnpm connector installation has no matching validated global launch entry: ${launch ?? identity.logicalEntry}`);
    return root;
  }
  const logical = logicalExecutionEntry();
  if (logical) return dirname(dirname(logical));
  for (const start of [process.argv[1], fileURLToPath(import.meta.url)]) {
    if (!start) continue;
    let current = dirname(realpathSync.native(start));
    for (;;) {
      const metadata = join(current, "package.json");
      if (existsSync(metadata) && (JSON.parse(readFileSync(metadata, "utf8")) as { name?: string }).name === "cotal-ai") return current;
      if (existsSync(join(current, "pnpm-workspace.yaml"))) return join(current, "bin");
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("cannot identify this installation's connector set; run its owning installer");
}

let preparing = false;
let loadedInstallRoot: string | undefined;
const heldSets = new Map<string, { references: number; path: string; start: string }>();

/** All extension and seed paths for this installation's loaded implementation. No mutable latest pointer. */
export function extensionSetPaths(config = globalConfigDir()) {
  const installRoot = loadedInstallRoot ??= extensionInstallationRoot(packageRoot());
  const identity = process.platform === "win32" ? installRoot.toLowerCase() : installRoot;
  const id = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const root = join(config, "installs", id);
  const set = join(root, "sets", version);
  return { root, installRoot, id, version, set, extensions: join(set, "extensions"), seed: join(set, "seed"), ready: join(set, "ready.json") };
}

export function extensionSetMigrated(): boolean {
  return existsSync(join(extensionSetPaths().root, "install.json"));
}

function committedVersion(record: { current?: string; previous?: string; versions?: string[] }, selected: string): boolean {
  return record.current === selected || record.previous === selected || record.versions?.includes(selected) === true;
}

/** Existing committed sets cannot silently turn into an empty extension inventory. */
export function assertExtensionSetReadable(): void {
  if (preparing) return;
  const paths = extensionSetPaths();
  const migration = inspectLock(join(paths.root, ".migration.lock"));
  if (migration.state === "active" && (migration.owner.pid === process.pid || migration.owner.pid === process.ppid)) return;
  const install = join(paths.root, "install.json");
  if (existsSync(paths.ready)) assertExtensionSetReady();
  else if (existsSync(install)) {
    const source = readLocalRecordSource(install, 4096);
    const record = source ? JSON.parse(Buffer.from(source).toString("utf8")) as { current?: string; previous?: string; versions?: string[] } : undefined;
    if (record && committedVersion(record, paths.version)) assertExtensionSetReady();
  }
}

/** A Manager must never read a partial, missing or differently bound set. */
export function assertExtensionSetReady(): void {
  const paths = extensionSetPaths();
  let record: { version?: string; installRoot?: string };
  try {
    const source = readLocalRecordSource(paths.ready, 4096);
    if (!source) throw new Error("missing ready record");
    record = JSON.parse(Buffer.from(source).toString("utf8"));
  }
  catch { throw new Error(`connector set ${paths.version} for ${paths.installRoot} is missing or incomplete; run this installation's \`cotal ext seed --repair\``); }
  if (record.version !== paths.version || record.installRoot !== paths.installRoot || !existsSync(join(paths.extensions, "extensions.json"))) throw new Error(`connector set identity differs or its inventory is missing at ${paths.set}; run this installation's \`cotal ext seed --repair\``);
}

/** Repeat a first migration from its source inventory; publish readiness only after the caller verifies it. */
export async function prepareExtensionSet<T>(reconcile: () => Promise<T>, options: { repair?: boolean; beforeReset?: () => void } = {}): Promise<T> {
  if (preparing) return reconcile();
  const paths = extensionSetPaths();
  if (existsSync(paths.ready) && !options.repair) { assertExtensionSetReady(); return reconcile(); }
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  protectedLocalDirectory(paths.root, "connector installation store");
  ensureDirNoSymlink(paths.root, "sets");
  protectedLocalDirectory(join(paths.root, "sets"), "connector version store");
  const lock = acquireLock(join(paths.root, ".migration.lock"), { label: "connector set migration", waitMs: 30000 });
  let legacy: ReturnType<typeof acquireLock> | undefined;
  const pending = join(paths.root, `.migration-${paths.version}.json`);
  try {
    if (existsSync(paths.ready) && !options.repair) { assertExtensionSetReady(); return await reconcile(); }
    if (existsSync(paths.ready) && options.repair) {
      let valid = true;
      try { assertExtensionSetReady(); } catch { valid = false; }
      if (valid) return await reconcile();
      const aside = `${paths.ready}.invalid.${randomBytes(8).toString("hex")}`;
      renameSync(paths.ready, aside);
    }
    const installationRecord = join(paths.root, "install.json");
    if (options.repair && existsSync(installationRecord) && existsSync(join(paths.extensions, "extensions.json")) &&
        committedVersion(JSON.parse(readFileSync(installationRecord, "utf8")), paths.version)) {
      preparing = true;
      const value = await reconcile();
      verifyExtensionSet(paths);
      publishReady(paths);
      return value;
    }
    if (!existsSync(pending)) {
      const install = join(paths.root, "install.json");
      if (existsSync(install) && committedVersion(JSON.parse(readFileSync(install, "utf8")), paths.version) && !options.repair) throw new Error(`connector set ${paths.version} is missing; run this installation's \`cotal ext seed --repair\``);
      writeFileSync(pending, JSON.stringify({ installRoot: paths.installRoot, version: paths.version }), { mode: 0o600, flag: "wx" });
    } else {
      const source = readLocalRecordSource(pending, 4096);
      const intent = source ? JSON.parse(Buffer.from(source).toString("utf8")) as { installRoot?: string; version?: string } : undefined;
      if (intent?.installRoot !== paths.installRoot || intent.version !== paths.version) throw new Error("connector migration intent does not match this installation");
    }
    legacy = acquireLock(join(globalConfigDir(), ".extensions.lock"), { label: "legacy connector inventory migration", waitMs: 30000 });
    if (existsSync(paths.set)) {
      options.beforeReset?.();
      const info = lstatSync(paths.set);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe incomplete connector set ${paths.set}`);
      protectedLocalDirectory(paths.set, "incomplete connector set");
      rmSync(paths.set, { recursive: true });
    }
    mkdirSync(paths.set, { recursive: true, mode: 0o700 });
    const installation = join(paths.root, "install.json");
    const prior = existsSync(installation) ? JSON.parse(readFileSync(installation, "utf8")) as { current?: string; previous?: string; versions?: string[] } : undefined;
    const sourceVersion = prior?.current === paths.version ? prior.previous : prior?.current;
    if (sourceVersion && !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(sourceVersion)) throw new Error("invalid previous connector set version");
    const sourceRoot = sourceVersion ? join(paths.root, "sets", sourceVersion) : globalConfigDir();
    if (sourceVersion && !existsSync(join(sourceRoot, "ready.json"))) throw new Error(`previous connector set ${sourceVersion} is incomplete; run this installation's \`cotal ext seed --repair\``);
    const old = join(sourceRoot, "extensions");
    if (existsSync(old)) {
      const info = lstatSync(old);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe legacy connector prefix ${old}`);
      cpSync(old, paths.extensions, { recursive: true, dereference: false, verbatimSymlinks: true });
      for (const name of ["package.json", "package-lock.json"]) {
        const file = join(paths.extensions, name);
        if (existsSync(file)) {
          const copied = JSON.parse(readFileSync(file, "utf8"), (_key, value: unknown) => typeof value === "string" && value.startsWith("file:") ? `file:${resolve(old, value.slice(5))}` : value);
          writeFileSync(file, JSON.stringify(copied, null, 2));
        }
      }
    }
    mkdirSync(paths.seed, { mode: 0o700 });
    for (const name of ["authority.json", "authority.bak.json", "witness.json"]) {
      const source = join(sourceRoot, "seed", name);
      if (existsSync(source)) {
        if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error(`unsafe legacy seed record ${source}`);
        writeFileSync(join(paths.seed, name), readFileSync(source), { flag: "wx", mode: 0o600 });
      }
    }
    legacy.release(); legacy = undefined;
    preparing = true;
    const value = await reconcile();
    verifyExtensionSet(paths);
    const install = join(paths.root, "install.json");
    const previous = sourceVersion;
    const next = `${install}.${randomBytes(8).toString("hex")}`;
    const versions = [...new Set([...(prior?.versions ?? []), ...(prior?.current ? [prior.current] : []), ...(prior?.previous ? [prior.previous] : []), paths.version])];
    writeFileSync(next, JSON.stringify({ installRoot: paths.installRoot, current: paths.version, versions, ...(previous && previous !== paths.version ? { previous } : {}) }), { flag: "wx", mode: 0o600 });
    renameSync(next, install);
    publishReady(paths);
    rmSync(pending);
    return value;
  } finally { preparing = false; legacy?.release(); lock.release(); }
}

function verifyExtensionSet(paths: ReturnType<typeof extensionSetPaths>): void {
  const entries = JSON.parse(readFileSync(join(paths.extensions, "extensions.json"), "utf8")) as { extensions: { pkg: string; version: string }[] };
  for (const entry of entries.extensions) {
    const installed = join(paths.extensions, "node_modules", entry.pkg);
    if (!entry.pkg.startsWith("@cotal-ai/") && !lstatSync(installed, { throwIfNoEntry: false })) continue;
    const metadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version?: string };
    if (metadata.version !== entry.version || entry.pkg.startsWith("@cotal-ai/") && entry.version !== paths.version) throw new Error(`connector set verification failed for ${entry.pkg}; run \`cotal ext seed --repair\``);
  }
}

function publishReady(paths: ReturnType<typeof extensionSetPaths>): void {
  const temporary = `${paths.ready}.${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, JSON.stringify({ installRoot: paths.installRoot, version: paths.version }), { flag: "wx", mode: 0o600 });
  renameSync(temporary, paths.ready);
}

const startToken = (pid: number) => process.platform === "win32" ? nativeWin32CreationToken(pid) : processStartToken(pid);

/** Bind a daemon/Manager to its verified set using the existing PID/start lifetime record shape. */
export function holdExtensionSet(): () => void {
  assertExtensionSetReady();
  const paths = extensionSetPaths(), start = startToken(process.pid);
  const prior = heldSets.get(paths.set);
  if (prior) {
    prior.references++;
    let released = false;
    return () => { if (released) return; released = true; if (--prior.references === 0) { rmSync(prior.path, { force: true }); heldSets.delete(paths.set); } };
  }
  if (!start) throw new Error("cannot record connector-set holder process lifetime");
  const directory = join(paths.set, "holders");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  protectedLocalDirectory(directory, "connector holder records");
  const path = join(directory, `${process.pid}.json`);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ v: 1, pid: process.pid, start, startedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  else {
    const record = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; start?: string };
    if (record.pid !== process.pid || record.start !== start) throw new Error("connector-set lifetime record differs from this process");
  }
  const holder = { references: 1, path, start };
  heldSets.set(paths.set, holder);
  let released = false;
  return () => { if (released) return; released = true; if (--holder.references === 0 && startToken(process.pid) === start) { rmSync(path, { force: true }); heldSets.delete(paths.set); } };
}

/** Data only: the binary's one cleanup function owns every retired-set deletion. */
export function extensionSetCleanupSpec() {
  const paths = extensionSetPaths();
  const logical = logicalExecutionEntry();
  const installRoot = logical ? dirname(dirname(logical)) : paths.installRoot;
  const holders: { version?: string; state: "live" | "unknown" }[] = [];
  const sets = join(paths.root, "sets");
  try {
    if (existsSync(sets)) {
      if (!realDirNoSymlink(globalConfigDir(), "installs", paths.id, "sets")) throw new Error("connector version store disappeared");
      protectedLocalDirectory(sets, "connector version store census");
    }
  } catch {
    return { root: sets, installRoot, current: paths.version, holders: [{ state: "unknown" as const }] };
  }
  if (existsSync(sets)) for (const generation of readdirSync(sets)) {
    if (basename(generation) !== generation || isAbsolute(generation)) throw new Error("invalid connector generation directory");
    const set = join(sets, generation);
    if (!lstatSync(set).isDirectory() || lstatSync(set).isSymbolicLink()) { holders.push({ state: "unknown" }); continue; }
    const directory = join(set, "holders");
    if (!existsSync(directory)) continue;
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error("linked holder directory");
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        try {
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("unsafe holder record");
          const record = JSON.parse(readFileSync(path, "utf8")) as { v?: number; pid?: number; start?: string; startedAt?: string };
          if (record.v !== 1 || !Number.isSafeInteger(record.pid) || !record.start || !record.startedAt) throw new Error("invalid lifetime record");
          const current = startToken(record.pid!);
          if (current === record.start) holders.push({ version: generation, state: "live" });
          else if (current !== undefined) rmSync(path);
          else {
            try { process.kill(record.pid!, 0); holders.push({ version: generation, state: "unknown" }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(path); else holders.push({ version: generation, state: "unknown" }); }
          }
        } catch { holders.push({ version: generation, state: "unknown" }); }
      }
    } catch { holders.push({ state: "unknown" }); }
  }
  let current = paths.version;
  let previous: string | undefined;
  try {
    const source = readLocalRecordSource(join(paths.root, "install.json"), 16384);
    if (!source) throw new Error("missing connector installation record");
    const record = JSON.parse(Buffer.from(source).toString("utf8")) as { installRoot?: string; current?: string; previous?: string };
    const validVersion = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
    if (record.installRoot !== paths.installRoot || !validVersion(record.current) || record.previous !== undefined && !validVersion(record.previous)) throw new Error("invalid connector installation record");
    current = record.current;
    previous = record.previous;
  } catch { holders.push({ state: "unknown" }); }
  if (current !== paths.version) holders.push({ version: paths.version, state: "live" });
  return { root: sets, installRoot, current, ...(previous ? { previous } : {}), holders };
}
