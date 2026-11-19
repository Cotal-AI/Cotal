import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { executionIdentity } from "./execution-identity.js";
import { acquireLock, processStartToken } from "./advisory-lock.js";
import { readLocalRecordSource } from "./local-record-source.js";
import { assertExtensionPrefixIdle, claimExtensionMutationLock } from "./extension-mutation.js";
import { claimUpdateClosureAccess } from "./update-closure.js";
import { readMeshRegistry } from "./mesh-registry.js";
import { homeCotalDir } from "./cotal-home.js";
import { MANAGER_PIDFILE, localProcessPathCandidates, recordedLocalProcessPaths } from "./local-process.js";
import { commandIsCotalSupervisor, readProcessRecord } from "./pid.js";
import { probeLiveness } from "./liveness.js";
import { protectedResolvedDirectory } from "./protected-records.js";

interface ConnectorHolder {
  v: 1;
  manager: string;
  agent: string;
  custody?: { pid: number; start: string; boot: string };
}

function bootIdentity(): string | undefined {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; }
  catch { return undefined; }
}

function holderDead(holder: ConnectorHolder): boolean {
  const c = holder.custody;
  if (!c || !Number.isSafeInteger(c.pid) || c.pid <= 0 || typeof c.start !== "string" || !c.start || typeof c.boot !== "string" || !c.boot) return false;
  const boot = bootIdentity();
  const start = processStartToken(c.pid);
  return (boot !== undefined && boot !== c.boot) || probeLiveness(c.pid) === "dead" ||
    (boot === c.boot && start !== undefined && start !== c.start);
}

function setHasHolders(path: string, unpublished = false): boolean {
  // No marker means this release predates durable seat provenance.
  const marker = readLocalRecordSource(join(path, "holders-v1.json"), 128, true);
  if (marker ? marker.toString("utf8") !== '{"v":1}\n' : !unpublished) return true;
  const directory = join(path, "holders");
  if (unpublished && !lstatSync(directory, { throwIfNoEntry: false })) return false;
  ownedAncestors(directory);
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const bytes = readLocalRecordSource(file, 8192, true);
    if (!bytes) return true;
    const holder = JSON.parse(bytes.toString("utf8")) as ConnectorHolder;
    if (holder.v !== 1 || typeof holder.manager !== "string" || typeof holder.agent !== "string" || !holderDead(holder)) return true;
  }
  return false;
}

/** Reserve before launch so even a Manager killed during spawn leaves a conservative holder. */
export function retainConnectorSeat(manager: string, agent: string): { active: boolean; launched(pid?: number): void; ended(): void } {
  const id = identity();
  if (!id || currentConfig(id) === undefined) return { active: false, launched() {}, ended() {} };
  const release = claimUpdateClosureAccess();
  let file: string;
  const holder: ConnectorHolder = { v: 1, manager, agent };
  try {
    ownedAncestors(id.path);
    const directory = join(id.path, "holders");
    mkdirSync(directory, { mode: 0o700, recursive: true });
    ownedAncestors(directory);
    file = join(directory, `${randomBytes(16).toString("hex")}.json`);
    writeFileSync(file, JSON.stringify(holder), { flag: "wx", mode: 0o600 });
  } finally { release(); }
  return {
    active: true,
    launched(pid) {
      const boot = bootIdentity(), start = pid === undefined ? undefined : processStartToken(pid);
      if (pid === undefined || !boot || !start) return;
      holder.custody = { pid, start, boot };
      const pending = `${file}.${randomBytes(8).toString("hex")}`;
      try {
        writeFileSync(pending, JSON.stringify(holder), { flag: "wx", mode: 0o600 });
        renameSync(pending, file);
      } catch { /* The reserved identity-less holder still protects the set. */ }
      finally { try { rmSync(pending, { force: true }); } catch { /* Stale holders retain the set. */ } }
    },
    ended() { try { rmSync(file, { force: true }); } catch { /* Stale holders retain the set. */ } },
  };
}

function pruneConnectorSets(id: { entry: string; version: string; path: string }, holders?: readonly (string | undefined)[]): void {
  // Older process records do not pin a connector version. Keep every set while any
  // recorded holder may still use one, rather than infer its prefix from file age.
  try {
    if (previousConfig(id) !== join(id.path, "cotal")) return;
    // Controller services have a separate protected custody store. Without a
    // complete controller observation, none of their possible prefixes is idle.
    if (!holders && existsSync(join(homeCotalDir(), "services"))) return;
    if (holders?.some(version => version === undefined || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))) return;
    const keep = new Set(holders ?? []);
    if (!holders) {
      const registry = readMeshRegistry();
      if (registry.unusable.length) return;
      for (const entry of registry.entries) {
        const paths = new Set(localProcessPathCandidates(MANAGER_PIDFILE, { root: entry.root, space: entry.space }));
        for (const row of recordedLocalProcessPaths(MANAGER_PIDFILE, entry.root)) {
          if (row.unread) return;
          paths.add(row.path);
        }
        for (const path of paths) {
          const record = readProcessRecord(path, commandIsCotalSupervisor);
          if (!["absent", "dead"].includes(record.state)) return;
        }
      }
      const daemon = readLocalRecordSource(join(homeCotalDir(), "daemon", "daemon.lock"), 4096, true);
      if (daemon?.length) {
        const record = JSON.parse(daemon.toString("utf8")) as { v?: number; pid?: number };
        if (record.v !== 1 || !Number.isInteger(record.pid) || record.pid! <= 0 || probeLiveness(record.pid!) !== "dead") return;
      }
    }
    const sets = dirname(id.path);
    ownedAncestors(sets);
    for (const name of readdirSync(sets)) {
      if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(name)) continue;
      const path = join(sets, name);
      if (path === id.path || keep.has(name)) continue;
      try { ownedAncestors(path); if (setHasHolders(path)) continue; rmSync(path, { recursive: true, force: true }); }
      catch { console.error(`connector set cleanup: could not remove ${name}; the update remains selected`); }
    }
  } catch { /* Unreadable holder state retains all sets. */ }
}

/** Collect only after the caller authenticates every local Manager and daemon. */
export function pruneRetainedConnectorConfig(holders: readonly (string | undefined)[]): void {
  try {
    const id = identity();
    if (!id || currentConfig(id) === undefined) return;
    const release = claimUpdateClosureAccess();
    try { pruneConnectorSets(id, holders); } finally { release(); }
  } catch { /* Cleanup must never fail a successful update. */ }
}

interface Selection { readonly v: 1; readonly entry: string; readonly version: string; readonly root: string }
function retentionEntryKey(logicalEntry: string): string {
  // pnpm dlx unpacks into `<cache>/pnpm/dlx/<pkg-hash>/<instance-id>/node_modules/...` and replaces
  // `<instance-id>` whenever its dlx cache refreshes. Keying across that transient segment keeps
  // seeded built-ins and added extensions visible across refreshes instead of leaking a new set tree.
  return logicalEntry.replace(/([/\\]pnpm[/\\]dlx[/\\][^/\\]+[/\\])[^/\\]+(?=[/\\]node_modules[/\\])/, "$1*");
}
function identity(): { entry: string; version: string; path: string } | undefined {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const execution = executionIdentity();
  if (!execution) return;
  const loaded = dirname(dirname(execution.loadedEntry));
  const logical = dirname(dirname(execution.logicalEntry));
  if ([loaded, logical].some(root => basename(root) === "bin" && (existsSync(join(dirname(root), "implementations")) || existsSync(join(dirname(root), "pnpm-workspace.yaml"))))) return;
  if (existsSync(join(loaded, "desktop-runtime.json")) || existsSync(join(logical, "desktop-runtime.json"))) return;
  const meta = JSON.parse(readFileSync(join(loaded, "package.json"), "utf8")) as { version?: unknown };
  if (typeof meta.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(meta.version)) throw new Error("connector selection has no valid loaded version");
  const entry = retentionEntryKey(execution.logicalEntry);
  const key = createHash("sha256").update(entry).digest("hex");
  return { entry, version: meta.version, path: join(globalConfigDir(), "installs", key, "sets", meta.version) };
}
function ownedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error(`connector retention directory is not private: ${path}`);
}
function ownedAncestors(path: string): void {
  const config = resolve(globalConfigDir());
  protectedResolvedDirectory(config, "the connector config folder");
  for (let parent = path; parent !== config; parent = dirname(parent)) {
    if (parent === dirname(parent)) throw new Error("connector retention escaped its config directory");
    ownedDirectory(parent);
  }
}
function previousConfig(id: { entry: string; path: string }): string | undefined {
  const sets = dirname(id.path);
  const bytes = readLocalRecordSource(join(sets, "current.json"), 8192, true);
  if (!bytes) return;
  ownedAncestors(sets);
  const record = JSON.parse(bytes.toString("utf8")) as Selection;
  if (record.v !== 1 || record.entry !== id.entry || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(record.version) || record.root !== join(sets, record.version, "cotal")) throw new Error("invalid previous connector retention selection");
  ownedAncestors(record.root);
  for (const name of ["seed", "extensions"]) {
    const path = join(record.root, name), stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`previous connector state is not a real directory: ${path}`);
  }
  return record.root;
}

function currentConfig(id: { entry: string; version: string; path: string }): string | undefined {
  if (existsSync(id.path)) ownedAncestors(id.path);
  const bytes = readLocalRecordSource(join(id.path, "selection.json"), 8192, true);
  if (!bytes) {
    const previous = previousConfig(id);
    return previous === join(id.path, "cotal") ? previous : undefined;
  }
  ownedAncestors(id.path);
  const record = JSON.parse(bytes.toString("utf8")) as Selection;
  if (record.v !== 1 || record.entry !== id.entry || record.version !== id.version || record.root !== join(id.path, "cotal")) throw new Error("connector retention selection differs from this installation");
  ownedDirectory(record.root);
  for (const name of ["seed", "extensions"]) {
    const path = join(record.root, name);
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`retained connector state is not a real directory: ${path}`);
  }
  return record.root;
}

/** Read selected or predecessor state, legacy state when present, or the fresh installation's future root. */
export function connectorConfigDir(): string {
  const id = identity();
  return id ? currentConfig(id) ?? previousConfig(id) ?? (["extensions", "seed"].some(name => existsSync(join(globalConfigDir(), name))) ? globalConfigDir() : join(id.path, "cotal")) : globalConfigDir();
}

/** Implicit recovery may mutate current or canonical state, never a predecessor exposed only for reads. */
export function canRecoverConnectorConfig(): boolean {
  const id = identity();
  return !id || currentConfig(id) !== undefined || previousConfig(id) === undefined;
}

/** Each installed generation inherits connector state without mutating an earlier process's prefix. */
export function inheritConnectorConfig(): void {
  const id = identity();
  if (id && currentConfig(id) === undefined) retainConnectorConfig();
}

/** Preserve the original prefix in place and prepare a separate complete prefix for same-version repair. */
export function retainConnectorConfig(): string {
  const id = identity();
  if (!id) throw new Error("retained connector reconciliation requires an installed POSIX execution");
  const selected = currentConfig(id);
  if (selected !== undefined) return selected;
  const current = previousConfig(id) ?? globalConfigDir();
  let ancestor = current;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  protectedResolvedDirectory(ancestor, "the connector config folder");
  const releaseClosure = claimUpdateClosureAccess();
  let releaseWriter = () => {};
  let releaseSeed = () => {};
  try {
    const seed = acquireLock(join(current, "seed", "reconcile.lock"), { label: "retained connector reconciliation", waitMs: 0 });
    releaseSeed = () => seed.release();
    if (current === globalConfigDir()) releaseWriter = claimExtensionMutationLock();
    else {
      const pass = acquireLock(join(current, ".extensions.lock.update"), { label: "retained connector pass", waitMs: 0 });
      try {
        const writer = acquireLock(join(current, ".extensions.lock"), { label: "retained connector writer", waitMs: 0 });
        releaseWriter = () => { writer.release(); pass.release(); };
      } catch (error) { pass.release(); throw error; }
    }
    assertExtensionPrefixIdle(current);
    const published = currentConfig(id);
    if (published !== undefined) return published;
    if ((previousConfig(id) ?? globalConfigDir()) !== current) throw new Error("connector retention source changed before its copy; retry reconciliation");
    if (current !== globalConfigDir()) {
      const sourcePath = dirname(current);
      const sourceSelection = join(sourcePath, "selection.json");
      if (!readLocalRecordSource(sourceSelection, 8192, true)) {
        const sourceRecord: Selection = { v: 1, entry: id.entry, version: sourcePath.split("/").at(-1)!, root: current };
        const pending = join(sourcePath, `.selection-${randomBytes(8).toString("hex")}`);
        writeFileSync(pending, JSON.stringify(sourceRecord), { flag: "wx", mode: 0o600 });
        renameSync(pending, sourceSelection);
      }
    }
    mkdirSync(id.path, { recursive: true, mode: 0o700 });
    ownedAncestors(id.path);
    const root = join(id.path, "cotal");
    // Neither selection names this set. Its unpublished copy can be rebuilt, but
    // even an interrupted publication must keep any live or unproven seat holder.
    if (readdirSync(id.path).length) {
      if (setHasHolders(id.path, true)) throw new Error(`unfinished retained connector state has seat holders: ${root}`);
      const stat = lstatSync(root, { throwIfNoEntry: false });
      if (stat) ownedDirectory(root);
      rmSync(id.path, { recursive: true });
      mkdirSync(id.path, { mode: 0o700 });
    }
    const staging = mkdtempSync(join(id.path, ".preparing-"));
    try {
      for (const name of ["seed", "extensions"]) {
        const source = join(current, name), destination = join(staging, name);
        if (!existsSync(source)) continue;
        const stat = lstatSync(source);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`cannot retain non-directory connector state: ${source}`);
        cpSync(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => !/^reconcile\.(?:lock(?:\..*)?|child\.json)$/.test(path.split("/").at(-1)!) });
      }
      renameSync(staging, root);
    } finally { if (existsSync(staging)) rmSync(staging, { recursive: true }); }
    if (realpathSync(root) !== join(realpathSync(id.path), "cotal")) throw new Error("retained connector state resolved through a link");
    mkdirSync(join(id.path, "holders"), { mode: 0o700 });
    writeFileSync(join(id.path, "holders-v1.json"), '{"v":1}\n', { flag: "wx", mode: 0o600 });
    const record: Selection = { v: 1, entry: id.entry, version: id.version, root };
    const next = join(dirname(id.path), `.current-${randomBytes(8).toString("hex")}`);
    writeFileSync(next, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(next, join(dirname(id.path), "current.json"));
    const temporary = join(id.path, `.selection-${randomBytes(8).toString("hex")}`);
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(id.path, "selection.json"));
    return root;
  } finally { releaseWriter(); releaseSeed(); releaseClosure(); }
}
