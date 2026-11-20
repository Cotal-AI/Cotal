import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { executionIdentity } from "./execution-identity.js";
import { acquireLock, processStartToken } from "./advisory-lock.js";
import { readLocalRecordSource } from "./local-record-source.js";
import { assertExtensionPrefixIdle, claimExtensionMutationLock } from "./extension-mutation.js";
import { claimUpdateClosureAccess, liveUpdateClosureOwner } from "./update-closure.js";
import { readUpdateRecovery } from "./updates.js";
import { readMeshRegistry } from "./mesh-registry.js";
import { homeCotalDir } from "./cotal-home.js";
import { MANAGER_PIDFILE, localProcessPathCandidates, recordedLocalProcessPaths } from "./local-process.js";
import { commandIsCotalSupervisor, readProcessRecord } from "./pid.js";
import { probeLiveness } from "./liveness.js";
import { protectedResolvedDirectory } from "./protected-records.js";
import { CommandFailure } from "./output.js";

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
    if (updateSnapshot(id)) return;
    if (previousConfig(id) !== currentConfig({ ...id })) return;
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
    // The reconcile child can borrow the update lock before final execution verification.
    // Keep the set that contains the parent's rollback snapshot until the journal is cleared.
    const snapshot = readUpdateRecovery()?.snapshot;
    const rollbackConfig = snapshot && /^\.update-snapshot-/.test(basename(snapshot)) ? dirname(resolve(snapshot)) : undefined;
    const rollbackSet = rollbackConfig && /^cotal(?:-[a-f0-9]{16})?$/.test(basename(rollbackConfig)) ? dirname(rollbackConfig) : undefined;
    for (const name of readdirSync(sets)) {
      if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(name)) continue;
      const path = join(sets, name);
      if (path === id.path || keep.has(name) || resolve(path) === rollbackSet) continue;
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

interface Selection { readonly v: 1; readonly entry: string; readonly version: string; readonly root: string; readonly snapshot?: string }

function writeSelection(path: string, record: Selection): void {
  const pending = join(dirname(path), `.selection-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(pending, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(pending, path);
  } finally { rmSync(pending, { force: true }); }
}

export class UnreadableConnectorSelection extends Error {
  constructor(path: string, reason: string) {
    super(`connector retention selection at ${path} is unreadable: ${reason}. Run \`cotal ext seed --repair\` to repair the connectors.`);
  }
}

function parseSelection(bytes: Buffer, path: string): Selection {
  let record: unknown;
  try { record = JSON.parse(bytes.toString("utf8")); }
  catch { throw new UnreadableConnectorSelection(path, "invalid JSON"); }
  const selection = record as Selection | null;
  if (selection?.v !== 1 || typeof selection.version !== "string" || typeof selection.root !== "string" || typeof selection.entry !== "string")
    throw new UnreadableConnectorSelection(path, "unrecognized record shape");
  return selection;
}
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

function previousConfig(id: { entry: string; path: string }, prepare?: (path: string) => void): string | undefined {
  const sets = dirname(id.path);
  const path = join(sets, "current.json");
  const bytes = readLocalRecordSource(path, 8192, true);
  if (!bytes) return;
  ownedAncestors(sets);
  const record = parseSelection(bytes, path);
  if (record.v !== 1 || record.entry !== id.entry || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(record.version) || dirname(record.root) !== join(sets, record.version) || !/^cotal(?:-[a-f0-9]{16})?$/.test(basename(record.root))) throw new Error("invalid previous connector retention selection");
  const { root } = record;
  prepare?.(root);
  ownedAncestors(root);
  for (const name of ["seed", "extensions"]) {
    const path = join(root, name), stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`previous connector state is not a real directory: ${path}`);
  }
  return root;
}

function updateSnapshot(id: { entry: string; version: string; path: string }): string | undefined {
  // Extension validation temporarily selects its private stage through XDG_CONFIG_HOME.
  if (basename(dirname(globalConfigDir())) === "config" && basename(dirname(dirname(globalConfigDir()))).startsWith(".extensions.stage-")) return;
  if (process.env.COTAL_UPDATE_PARENT !== String(process.ppid)) return;
  const record = readUpdateRecovery();
  if (!record || record.phase !== "replacing" || record.target !== id.version || record.owner?.pid !== process.ppid || !liveUpdateClosureOwner(record) || !record.snapshot) return;
  const snapshot = record.snapshot, source = dirname(snapshot);
  const sets = dirname(id.path);
  const retained = dirname(dirname(source));
  if (!basename(snapshot).startsWith(".update-snapshot-") ||
      (source !== globalConfigDir() && (retained !== sets || !/^cotal(?:-[a-f0-9]{16})?$/.test(basename(source))))) throw new Error("update connector snapshot does not belong to this installation");
  if (source !== globalConfigDir()) ownedAncestors(source);
  ownedDirectory(snapshot);
  return snapshot;
}

function currentConfig(id: { entry: string; version: string; path: string }, prepare?: (path: string) => void): string | undefined {
  if (existsSync(id.path)) ownedAncestors(id.path);
  const path = join(id.path, "selection.json");
  const bytes = readLocalRecordSource(path, 8192, true);
  if (!bytes) {
    const snapshot = updateSnapshot(id);
    if (snapshot) return;
    const previous = previousConfig(id, prepare);
    return previous && dirname(previous) === id.path ? previous : undefined;
  }
  ownedAncestors(id.path);
  const record = parseSelection(bytes, path);
  if (record.v !== 1 || record.entry !== id.entry || record.version !== id.version || dirname(record.root) !== id.path || !/^cotal(?:-[a-f0-9]{16})?$/.test(basename(record.root))) throw new Error("connector retention selection differs from this installation");
  const snapshot = updateSnapshot(id);
  const { root } = record;
  if (!snapshot || record.snapshot === snapshot) prepare?.(root);
  ownedDirectory(root);
  for (const name of ["seed", "extensions"]) {
    const path = join(root, name);
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`retained connector state is not a real directory: ${path}`);
  }
  return snapshot && record.snapshot !== snapshot ? undefined : root;
}

/** Read selected, update snapshot, predecessor or legacy state, then the fresh installation's future root. */
export function connectorConfigDir(): string {
  const id = identity();
  return id ? currentConfig(id) ?? updateSnapshot(id) ?? previousConfig(id) ?? (["extensions", "seed"].some(name => existsSync(join(globalConfigDir(), name))) ? globalConfigDir() : join(id.path, "cotal")) : globalConfigDir();
}

/** Restore write access before staging, without touching another installation or following managed links. */
export function prepareConnectorConfigForUpdate(): void {
  const config = resolve(globalConfigDir());
  const what = "the Cotal connector configuration";
  const refuse = (path: string, reason: string): never => {
    throw new CommandFailure("refused", "PERMISSION_DENIED", `${what} at ${path} ${reason}. No CLI update was staged.`, {
      target: { path }, native: { outcome: "not-executed" },
      remedy: "Make the named directory a real directory owned and writable by your account, then run `cotal update --self` again.",
    });
  };
  const writable = (path: string, mode: number): void => {
    try { accessSync(path, mode); }
    catch { refuse(path, "cannot be accessed for updates by this account"); }
  };
  let ancestor = dirname(config);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  protectedResolvedDirectory(ancestor, what);

  const repair = (path: string): boolean => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) refuse(path, "is not a real directory owned by this account");
    const mode = (stat.mode & 0o7755) | 0o200;
    try { if (mode !== (stat.mode & 0o7777)) chmodSync(path, mode); }
    catch { refuse(path, "could not be made writable by this account"); }
    writable(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  };
  if (!repair(config)) { writable(ancestor, constants.W_OK | constants.X_OK); return; }
  protectedResolvedDirectory(config, what);
  const repairPath = (path: string): void => {
    if (path === config) return;
    const child = relative(config, path);
    if (child === ".." || child.startsWith(`..${sep}`)) throw new Error("connector selection escaped its config directory");
    let dir = config;
    for (const name of child.split(sep)) {
      dir = join(dir, name);
      if (!repair(dir)) return;
      if (dir !== path) ownedDirectory(dir);
    }
  };
  const id = identity();
  if (id) {
    repairPath(id.path);
    recoverRetiredCanonical(id.path);
  }
  const current = id && currentConfig(id, repairPath);
  // A bound downgrade inherits its snapshot into a new root, never the existing generation.
  if (id && !current && updateSnapshot(id)) return;
  const selected = current ?? (id && previousConfig(id, repairPath)) ?? config;
  const walk = (path: string): void => {
    if (!repair(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(path, entry.name));
    }
  };
  for (const name of ["seed", "extensions"]) walk(join(selected, name));
  // Retention removes an unfinished same-version copy before it copies the selected source.
  if (id && !current && existsSync(id.path)) walk(id.path);
}

/** Implicit recovery may mutate current or canonical state, never a predecessor exposed only for reads. */
export function canRecoverConnectorConfig(): boolean {
  const id = identity();
  if (!id) return true;
  recoverRetiredCanonical(id.path);
  return currentConfig(id) !== undefined || previousConfig(id) === undefined;
}

/** Each installed generation inherits connector state without mutating an earlier process's prefix. */
export function inheritConnectorConfig(): void {
  const id = identity();
  if (id) selectConnectorConfig(id);
}

function sameConnectorTree(left: string, right: string): boolean {
  const a = lstatSync(left, { throwIfNoEntry: false }), b = lstatSync(right, { throwIfNoEntry: false });
  if (!a || !b) return a === b;
  if (a.mode !== b.mode) return false;
  if (a.isSymbolicLink() && b.isSymbolicLink()) return readlinkSync(left) === readlinkSync(right);
  if (a.isFile() && b.isFile()) return a.size === b.size && readFileSync(left).equals(readFileSync(right));
  if (!a.isDirectory() || !b.isDirectory()) return false;
  const names = (path: string) => readdirSync(path).filter(name => !retentionLockFile(name)).sort();
  const first = names(left), second = names(right);
  return first.length === second.length && first.every((name, i) => name === second[i] && sameConnectorTree(join(left, name), join(right, name)));
}

const retentionLockFile = (name: string) => /^reconcile\.(?:lock(?:\..*)?|child\.json)$/.test(name);

function removeRetiredConnectorTree(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  if (stat.uid !== process.getuid?.()) throw new Error("cannot clean an unowned connector directory");
  if ((stat.mode & 0o700) !== 0o700) chmodSync(path, (stat.mode & 0o7777) | 0o700);
  for (const child of readdirSync(path, { withFileTypes: true })) {
    if (child.isDirectory()) removeRetiredConnectorTree(join(path, child.name));
  }
  rmSync(path, { recursive: true });
}

const retiredCanonical = (set: string) => join(set, ".retired-cotal");

function recoverRetiredCanonical(set: string): void {
  const aside = retiredCanonical(set);
  if (!lstatSync(aside, { throwIfNoEntry: false })) return;
  // Self-update preflight can reach this before restoring a stale update journal.
  const release = claimUpdateClosureAccess(true);
  try {
    if (!lstatSync(aside, { throwIfNoEntry: false })) return;
    ownedAncestors(set);
    ownedDirectory(aside);
    const canonical = join(set, "cotal");
    if (lstatSync(canonical, { throwIfNoEntry: false })) {
      ownedDirectory(canonical);
      removeRetiredConnectorTree(aside);
    } else renameSync(aside, canonical);
  } finally { release(); }
}

/** Inherit a complete prefix without replacing a graph held by a seat or the updater. */
export function retainConnectorConfig(): string {
  const id = identity();
  if (!id) throw new Error("retained connector reconciliation requires an installed POSIX execution");
  return selectConnectorConfig(id);
}

/** Explicit seed repair may set aside unreadable records, never their retained connector trees. */
export function repairConnectorSelection(checkSource: () => void): void {
  const id = identity();
  if (!id) return;
  const release = claimUpdateClosureAccess();
  try {
    const local = join(id.path, "selection.json");
    const lineage = join(dirname(id.path), "current.json");
    const unreadable = [local, lineage].filter(path => {
      const bytes = readLocalRecordSource(path, 8192, true);
      if (!bytes) return false;
      ownedAncestors(dirname(path));
      try { parseSelection(bytes, path); return false; }
      catch (error) {
        if (!(error instanceof UnreadableConnectorSelection)) throw error;
        return true;
      }
    });
    if (!unreadable.length) return;
    const backups: [string, string][] = [];
    try {
      for (const path of unreadable) {
        const aside = `${path}.corrupt.${randomBytes(4).toString("hex")}`;
        renameSync(path, aside);
        backups.push([path, aside]);
      }
      checkSource();
      const root = selectConnectorConfig(id, true);
      // When either pointer already identifies the current graph, restore the missing names
      // without copying or replacing that graph.
      const record: Selection = { v: 1, entry: id.entry, version: id.version, root };
      for (const [path] of backups) {
        if (!lstatSync(path, { throwIfNoEntry: false })) writeSelection(path, record);
      }
    } catch (error) {
      for (const [path, aside] of backups) {
        if (!lstatSync(path, { throwIfNoEntry: false })) renameSync(aside, path);
      }
      throw error;
    }
  } finally { release(); }
}

function selectConnectorConfig(id: NonNullable<ReturnType<typeof identity>>, preserveUnknown = false): string {
  recoverRetiredCanonical(id.path);
  const selected = currentConfig(id);
  if (selected !== undefined) return selected;
  const snapshot = updateSnapshot(id);
  const current = snapshot ?? previousConfig(id) ?? globalConfigDir();
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
    if ((updateSnapshot(id) ?? previousConfig(id) ?? globalConfigDir()) !== current) throw new Error("connector retention source changed before its copy; retry reconciliation");
    if (!snapshot && current !== globalConfigDir()) {
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
    let root = join(id.path, "cotal");
    // Without a snapshot, neither selection names this set. Its unpublished copy
    // can be rebuilt, but any live or unproven seat holder must remain protected.
    if (preserveUnknown && readdirSync(id.path).length) {
      root = join(id.path, `cotal-${randomBytes(8).toString("hex")}`);
    } else if (!snapshot && readdirSync(id.path).length) {
      if (setHasHolders(id.path, true)) throw new Error(`unfinished retained connector state has seat holders: ${root}`);
      const stat = lstatSync(root, { throwIfNoEntry: false });
      if (stat) ownedDirectory(root);
      rmSync(id.path, { recursive: true });
      mkdirSync(id.path, { mode: 0o700 });
    }
    const names = ["seed", "extensions"];
    const hasRoot = lstatSync(root, { throwIfNoEntry: false }) !== undefined;
    if (hasRoot) ownedDirectory(root);
    for (const name of names) {
      const source = join(current, name), stat = lstatSync(source, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error(`cannot retain non-directory connector state: ${source}`);
    }
    if (!hasRoot || !names.every(name => sameConnectorTree(join(current, name), join(root, name)))) {
      const staging = mkdtempSync(join(id.path, ".preparing-"));
      try {
        for (const name of names) {
          const source = join(current, name), destination = join(staging, name);
          if (existsSync(source)) cpSync(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => !retentionLockFile(basename(path)) });
        }
        if (!hasRoot) renameSync(staging, root);
        else {
          // Keep a live seat's graph and the updater's rollback source at their original paths.
          const pinned = snapshot && (dirname(snapshot) === root || setHasHolders(id.path));
          if (pinned) {
            root = join(id.path, `cotal-${randomBytes(8).toString("hex")}`);
            renameSync(staging, root);
          } else {
            assertExtensionPrefixIdle(root);
            const aside = retiredCanonical(id.path);
            renameSync(root, aside);
            try { renameSync(staging, root); }
            catch (error) {
              try { renameSync(aside, root); }
              catch { /* The next reconcile or self-update preflight restores the aside copy. */ }
              throw error;
            }
            removeRetiredConnectorTree(aside);
          }
        }
      } finally {
        try { removeRetiredConnectorTree(staging); }
        catch { /* Only a private unselected copy remains. */ }
      }
    }
    if (realpathSync(root) !== join(realpathSync(id.path), basename(root))) throw new Error("retained connector state resolved through a link");
    mkdirSync(join(id.path, "holders"), { mode: 0o700, recursive: true });
    if (!existsSync(join(id.path, "holders-v1.json"))) writeFileSync(join(id.path, "holders-v1.json"), '{"v":1}\n', { flag: "wx", mode: 0o600 });
    const record: Selection = { v: 1, entry: id.entry, version: id.version, root, ...(snapshot ? { snapshot } : {}) };
    const next = join(dirname(id.path), `.current-${randomBytes(8).toString("hex")}`);
    writeFileSync(next, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(next, join(dirname(id.path), "current.json"));
    const temporary = join(id.path, `.selection-${randomBytes(8).toString("hex")}`);
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(id.path, "selection.json"));
    return root;
  } finally { releaseWriter(); releaseSeed(); releaseClosure(); }
}
