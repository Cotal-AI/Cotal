import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { executionIdentity } from "./execution-identity.js";
import { acquireLock, processStartToken } from "./advisory-lock.js";
import { readLocalRecordSource } from "./local-record-source.js";
import { assertExtensionPrefixIdle, claimExtensionMutationLock } from "./extension-mutation.js";
import { claimUpdateClosureAccess, liveUpdateClosureOwner } from "./update-closure.js";
import { readUpdateRecovery, type UpdateRecovery } from "./updates.js";
import { readMeshRegistry } from "./mesh-registry.js";
import { homeCotalDir } from "./cotal-home.js";
import { MANAGER_PIDFILE, localProcessPathCandidates, recordedLocalProcessPaths } from "./local-process.js";
import { commandIsCotalSupervisor, readProcessRecord } from "./pid.js";
import { probeLiveness } from "./liveness.js";
import { protectedResolvedDirectory } from "./protected-records.js";
import { CommandFailure } from "./output.js";
import { restoreManifestAccess } from "./manifest-access.js";

type ConnectorChildIdentity = Readonly<{ pid: number; start: string; boot: string }>;

interface ConnectorSeatHolder {
  active: boolean;
  sharedEligible: boolean;
  launched(pid?: number): void;
  bindSharedChild(child: ConnectorChildIdentity | undefined): void;
  ended(): void;
}

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
export function retainConnectorSeat(manager: string, agent: string, shared = false): ConnectorSeatHolder {
  const inactive = (sharedEligible: boolean): ConnectorSeatHolder => ({
    active: false, sharedEligible, launched() {}, bindSharedChild() {}, ended() {},
  });
  let file: string, reservationStat: Stats | undefined;
  const holder: ConnectorHolder = { v: 1, manager, agent };
  const reserved = JSON.stringify(holder);
  try {
    const id = identity();
    if (!id) return inactive(true); // No installed connector set is subject to this collector.
    if (!shared && currentConfig(id) === undefined) return inactive(false);
    const release = claimUpdateClosureAccess();
    try {
      if (shared && currentConfig(id) === undefined) return inactive(false);
      ownedAncestors(id.path);
      const directory = join(id.path, "holders");
      mkdirSync(directory, { mode: 0o700, recursive: true });
      ownedAncestors(directory);
      file = join(directory, `${randomBytes(16).toString("hex")}.json`);
      writeFileSync(file, reserved, { flag: "wx", mode: 0o600 });
      if (shared) reservationStat = lstatSync(file);
    } finally { release(); }
  } catch (error) {
    // An unverifiable retained installation cannot dispatch to a detached host. Keep the
    // existing behavior for callers that were already launching through ordinary runtimes.
    if (!shared) throw error;
    return inactive(false);
  }
  let sharedReceipt = false;
  let expected = reserved;
  const ownsRecord = (): boolean => {
    ownedAncestors(dirname(file));
    const stat = lstatSync(file);
    return reservationStat !== undefined && stat.dev === reservationStat.dev && stat.ino === reservationStat.ino &&
      readLocalRecordSource(file, 8192, true)?.toString("utf8") === expected;
  };
  return {
    active: true,
    sharedEligible: true,
    bindSharedChild(child) {
      sharedReceipt = true;
      if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || !child.start || !child.boot) return;
      try {
        // Creation holds the collector's lock. Replacing this exact reservation doesn't
        // need it: a scan sees the reservation or the full identity at the same name.
        // An unreadable or concurrently removed entry also makes the scan keep the set.
        if (expected !== reserved || !ownsRecord()) return;
        const next = { ...holder, custody: { pid: child.pid, start: child.start, boot: child.boot } };
        writePrivateJson(file, next);
        reservationStat = lstatSync(file);
        expected = JSON.stringify(next);
      } catch { /* Keep the identity-less reservation if binding cannot be proved. */ }
    },
    launched(pid) {
      if (sharedReceipt) return;
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
    // Called only on proved exit, not when the Manager dies or releases a handle.
    ended() {
      try {
        if (!sharedReceipt) { rmSync(file, { force: true }); return; }
        if (ownsRecord()) rmSync(file, { force: true });
      } catch { /* Stale holders retain the set. */ }
    },
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
      if (path === id.path || keep.has(name) || (rollbackSet && sameConfigPath(rollbackSet, path))) continue;
      try {
        ownedAncestors(path);
        // Repair leaves a private copy for the operator, not for the generation collector.
        if (readdirSync(path).some(name => name.startsWith("selection.json.corrupt.")) || setHasHolders(path)) continue;
        rmSync(path, { recursive: true, force: true });
      }
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
const selectionDiffers = "connector retention selection differs from this installation";

function writePrivateJson(path: string, record: Selection | ConnectorHolder): void {
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

function recordedConfigBase(saved: string, expected: string, config: string): string | undefined {
  if (expected !== config && !expected.startsWith(`${config}${sep}`)) return;
  const suffix = expected.slice(config.length);
  if (!isAbsolute(saved) || !saved.endsWith(suffix)) return;
  const base = saved.slice(0, saved.length - suffix.length);
  if (base && resolve(base) === base) return base;
}

// Only the config base may be an alias. Managed descendants keep their fixed path and no-link checks.
function sameConfigPath(saved: string, expected: string): boolean {
  if (saved === expected) return true;
  const config = resolve(globalConfigDir());
  const base = recordedConfigBase(saved, expected, config);
  return !!base && sameConfigBase(base, config);
}

function sameConfigBase(left: string, right: string): boolean {
  const what = "the connector config folder";
  return existsSync(left) && existsSync(right) && protectedResolvedDirectory(left, what) === protectedResolvedDirectory(right, what);
}

function resolveSelectedRoot(saved: string, set: string, expected: string): string | undefined {
  if (saved === expected) return saved;
  const config = resolve(globalConfigDir());
  const oldBase = recordedConfigBase(dirname(saved), set, config);
  if (!oldBase) return;
  if (sameConfigBase(oldBase, config)) return saved;
  // A move is accepted for protected selections only, never for update snapshots.
  if (basename(oldBase) !== basename(config) || lstatSync(oldBase, { throwIfNoEntry: false })) return;
  let ancestor = dirname(oldBase);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  protectedResolvedDirectory(ancestor, "the former connector config folder");
  return expected;
}

function selectionMismatch(saved: string, expected: string, mismatch: string, cause?: unknown): Error {
  const reason = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  const detail = reason ? ` (${JSON.stringify(reason)})` : "";
  return new Error(
    `${mismatch}: recorded root ${JSON.stringify(saved)}, expected path ${JSON.stringify(expected)}${detail}. ` +
    "Restore access to the original location, then return the intact Cotal configuration there or restore it there from a backup. " +
    "Set XDG_CONFIG_HOME to the parent of that cotal configuration folder before retrying. Keep the selection records with the connector set",
    { cause },
  );
}

function resolveSelection(saved: string, set: string, mismatch: string): { root: string; expected: string } {
  const name = basename(saved), expected = join(set, name);
  if (saved !== join(dirname(saved), name) || !/^cotal(?:-[a-f0-9]{16})?$/.test(name))
    throw selectionMismatch(saved, set, mismatch);
  let root: string | undefined;
  try { root = resolveSelectedRoot(saved, set, expected); }
  catch (cause) { throw selectionMismatch(saved, expected, mismatch, cause); }
  if (root === undefined) throw selectionMismatch(saved, expected, mismatch);
  return { root, expected };
}

function selectedRoot(saved: string, set: string, mismatch: string, prepare?: (path: string) => void): string {
  const { root, expected } = resolveSelection(saved, set, mismatch);
  const moved = root !== saved;
  try {
    if (moved) {
      prepare?.(set);
      ownedDirectory(set);
      if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink())
        throw selectionMismatch(saved, expected, mismatch, "the moved connector root is a symbolic link");
    }
    prepare?.(expected);
    if (!moved) ownedDirectory(set);
    ownedDirectory(root);
  } catch (cause) {
    if (moved && (cause as NodeJS.ErrnoException).code === "ENOENT")
      throw selectionMismatch(saved, expected, mismatch, cause);
    throw cause;
  }
  for (const name of ["seed", "extensions"]) {
    const path = join(root, name), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat && moved) throw selectionMismatch(saved, expected, mismatch, `the moved ${name} directory is missing`);
    if (moved && stat?.isSymbolicLink()) throw selectionMismatch(saved, expected, mismatch, `the moved ${name} directory is a symbolic link`);
    if (stat && !stat.isDirectory()) throw new Error(`retained connector state is not a real directory: ${path}`);
  }
  if (moved && !lstatSync(join(root, "extensions", "extensions.json"), { throwIfNoEntry: false })?.isFile())
    throw selectionMismatch(saved, expected, mismatch, "the moved extensions manifest is missing or not a real file");
  return root;
}

function readLineage(sets: string): Selection | undefined {
  const path = join(sets, "current.json");
  if (!lstatSync(sets, { throwIfNoEntry: false })) return;
  ownedAncestors(sets);
  const bytes = readLocalRecordSource(path, 8192, true);
  return bytes ? parseSelection(bytes, path) : undefined;
}

function previousConfig(id: { entry: string; path: string }, prepare?: (path: string) => void): string | undefined {
  const sets = dirname(id.path);
  const record = readLineage(sets);
  if (!record) return;
  const versionDir = join(sets, record.version);
  const mismatch = "invalid previous connector retention selection";
  if (record.entry !== id.entry || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(record.version)) throw new Error(mismatch);
  return selectedRoot(record.root, versionDir, mismatch, prepare);
}

function rejectLinkedSet(id: { entry: string; version: string; path: string }, refuse: () => never): void {
  if (!lstatSync(id.path, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  // The version directory cannot attest to its own selection when it is a link.
  let record: Selection | undefined;
  try { record = readLineage(dirname(id.path)); }
  catch { /* Without protected lineage, report the link without guessing its former location. */ }
  if (record?.entry === id.entry && record.version === id.version) {
    const { root, expected } = resolveSelection(record.root, id.path, selectionDiffers);
    if (root !== record.root)
      throw selectionMismatch(record.root, expected, selectionDiffers, `the moved version directory ${id.path} is a symbolic link`);
  }
  refuse();
}

/** Identify the snapshot's config root without following links inside a retained set. */
export function updateSnapshotConfig(record: UpdateRecovery): string | undefined {
  return snapshotConfig(record.snapshot, record.previous);
}

function snapshotConfig(path: string | undefined, previous?: string, selectedPath?: string): string | undefined {
  if (!path || resolve(path) !== path || !basename(path).startsWith(".update-snapshot-")) return;
  const config = dirname(path);
  const base = resolve(globalConfigDir());
  if (sameConfigPath(config, base)) return config;
  const selected = selectedPath ?? identity()?.path;
  const generation = dirname(config), version = basename(generation);
  if (!selected || !sameConfigPath(dirname(generation), dirname(selected)) || (previous !== undefined && version !== previous) ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) || !/^cotal(?:-[a-f0-9]{16})?$/.test(basename(config))) return;
  if (!lstatSync(base, { throwIfNoEntry: false })) return config;
  protectedResolvedDirectory(base, "the connector config folder");
  const expected = join(dirname(selected), version, basename(config));
  let parent = base;
  for (const part of relative(base, expected).split(sep)) {
    parent = join(parent, part);
    if (!lstatSync(parent, { throwIfNoEntry: false })) break;
    ownedDirectory(parent);
  }
  return config;
}

function updateSnapshot(id: { entry: string; version: string; path: string }): string | undefined {
  // Extension validation temporarily selects its private stage through XDG_CONFIG_HOME.
  if (basename(dirname(globalConfigDir())) === "config" && basename(dirname(dirname(globalConfigDir()))).startsWith(".extensions.stage-")) return;
  if (process.env.COTAL_UPDATE_PARENT !== String(process.ppid)) return;
  const record = readUpdateRecovery();
  if (!record || record.phase !== "replacing" || record.target !== id.version || record.owner?.pid !== process.ppid || !liveUpdateClosureOwner(record) || !record.snapshot) return;
  const snapshot = record.snapshot;
  if (!snapshotConfig(snapshot, undefined, id.path)) {
    if (record.reconcileWithoutSnapshot && record.execution) return;
    throw new Error("update connector snapshot does not belong to this installation");
  }
  ownedDirectory(snapshot);
  return snapshot;
}

function currentConfig(id: { entry: string; version: string; path: string }, prepare?: (path: string) => void): string | undefined {
  rejectLinkedSet(id, () => { throw new Error(`connector retention directory is not private: ${id.path}`); });
  if (existsSync(id.path)) ownedAncestors(id.path);
  const path = join(id.path, "selection.json");
  const bytes = readLocalRecordSource(path, 8192, true);
  if (!bytes) {
    const snapshot = updateSnapshot(id);
    if (snapshot) return;
    const previous = previousConfig(id, prepare);
    return previous && sameConfigPath(dirname(previous), id.path) ? previous : undefined;
  }
  ownedAncestors(id.path);
  const record = parseSelection(bytes, path);
  if (record.entry !== id.entry || record.version !== id.version) throw new Error(selectionDiffers);
  const snapshot = updateSnapshot(id);
  const selected = !snapshot || record.snapshot === snapshot;
  const root = selectedRoot(record.root, id.path, selectionDiffers, selected ? prepare : undefined);
  return selected ? root : undefined;
}

/** Read selected, update snapshot, predecessor or legacy state, then the fresh installation's future root. */
export function connectorConfigDir(): string {
  return selectedConnectorConfig();
}

function selectedConnectorConfig(prepare?: (path: string) => void): string {
  const id = identity();
  if (id) prepare?.(id.path);
  return id ? currentConfig(id, prepare) ?? updateSnapshot(id) ?? previousConfig(id, prepare) ?? (["extensions", "seed"].some(name => existsSync(join(globalConfigDir(), name))) ? globalConfigDir() : join(id.path, "cotal")) : globalConfigDir();
}

/** Restore access only to the selected manifest, either before traversal or after a denied read. */
export function restoreConnectorManifestAccessForUpdate(search: boolean): boolean {
  return restoreManifestAccess(resolve(globalConfigDir()), selectedConnectorConfig, search);
}

/**
 * The selected update's validated rollback source for this installation. `snapshotConfig` accepts
 * only the top-level connector config folder or a private version folder beside the selected set.
 */
export function previousUpdateConnectorConfig(): string | undefined {
  const id = identity();
  if (!id || readUpdateRecovery()) return;
  const selected = readLineage(dirname(id.path));
  if (selected?.entry !== id.entry || selected.version !== id.version || typeof selected.snapshot !== "string") return;
  const current = currentConfig(id);
  if (!current || current !== selectedRoot(selected.root, id.path, selectionDiffers)) return;
  const previous = snapshotConfig(selected.snapshot, undefined, id.path);
  if (!previous || sameConfigPath(previous, current)) return;
  return previous;
}

/**
 * Restore owner access without following managed links or touching another installation.
 * Report completed repairs and recovery, even if a later check refuses. `onModeChange` reports
 * only the restored directory permissions.
 */
export function prepareConnectorConfigForUpdate(onChange?: () => void, onModeChange?: () => void): void {
  const config = resolve(globalConfigDir());
  const what = "the Cotal connector configuration";
  let changed = false;
  const noteChange = (): void => { changed = true; onChange?.(); };
  const refuse = (path: string, reason: string): never => {
    throw new CommandFailure("refused", "PERMISSION_DENIED", `${what} at ${path} ${reason}. No CLI update was staged.`, {
      target: { path }, ...(changed ? {} : { native: { outcome: "not-executed" } }),
      remedy: "Make the named directory a real directory owned and writable by your account, with owner read and search access, then run `cotal update --self` again.",
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
    const mode = (stat.mode & 0o7755) | 0o700;
    if (mode !== (stat.mode & 0o7777)) {
      try { chmodSync(path, mode); }
      catch { refuse(path, "cannot be accessed for updates by this account"); }
      noteChange();
      if ((stat.mode & 0o700) !== 0o700) onModeChange?.();
    }
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
    repairPath(dirname(id.path));
    rejectLinkedSet(id, () => refuse(id.path, "is not a real directory owned by this account"));
    repairPath(id.path);
    recoverRetiredCanonical(id.path, noteChange);
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

/** Check eligibility and report any completed canonical recovery, without mutating predecessor state. */
export function canRecoverConnectorConfig(onChange?: () => void): boolean {
  const id = identity();
  if (!id) return true;
  recoverRetiredCanonical(id.path, onChange);
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

function recoverRetiredCanonical(set: string, onChange?: () => void): void {
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
    onChange?.();
  } finally { release(); }
}

/** Inherit a complete prefix without replacing a graph held by a seat or the updater. */
export function retainConnectorConfig(): string {
  const id = identity();
  if (!id) throw new Error("retained connector reconciliation requires an installed POSIX execution");
  return selectConnectorConfig(id);
}

/** Set aside unreadable selection records, never their retained connector trees. */
export function repairConnectorSelection(checkSource?: () => void): readonly string[] {
  const id = identity();
  if (!id) return [];
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
    if (!unreadable.length) return [];
    const backups: [string, string][] = [];
    try {
      for (const path of unreadable) {
        const aside = `${path}.corrupt.${randomBytes(4).toString("hex")}`;
        renameSync(path, aside);
        backups.push([path, aside]);
      }
      checkSource?.();
      const root = selectConnectorConfig(id, true);
      // When either pointer already identifies the current graph, restore the missing names
      // without copying or replacing that graph.
      const record: Selection = { v: 1, entry: id.entry, version: id.version, root };
      for (const [path] of backups) {
        if (!lstatSync(path, { throwIfNoEntry: false })) writePrivateJson(path, record);
      }
      return backups.map(([, aside]) => aside);
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
  const global = globalConfigDir();
  const canonical = join(id.path, "cotal");
  const sourceConfig = (): string => updateSnapshot(id) ?? previousConfig(id) ?? (
    // An extension added before the first seed already lives at the advertised retained root.
    !preserveUnknown && !["extensions", "seed"].some(name => existsSync(join(global, name))) &&
    lstatSync(join(canonical, "extensions"), { throwIfNoEntry: false })?.isDirectory() &&
    lstatSync(join(canonical, "extensions", "extensions.json"), { throwIfNoEntry: false })?.isFile()
      ? selectedRoot(canonical, id.path, selectionDiffers) : global
  );
  const releaseClosure = claimUpdateClosureAccess();
  let releaseWriter = () => {};
  let releaseSeed = () => {};
  try {
    const selected = currentConfig(id);
    if (selected !== undefined) return selected;
    const snapshot = updateSnapshot(id);
    const current = sourceConfig();
    let ancestor = current;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
    protectedResolvedDirectory(ancestor, "the connector config folder");
    const seed = acquireLock(join(current, "seed", "reconcile.lock"), { label: "retained connector reconciliation", waitMs: 0 });
    releaseSeed = () => seed.release();
    if (current === global) releaseWriter = claimExtensionMutationLock();
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
    if (sourceConfig() !== current) throw new Error("connector retention source changed before its copy; retry reconciliation");
    if (!snapshot && current !== global && current !== canonical) {
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
    let root = canonical;
    // Without a snapshot, neither selection names this set. Its unpublished copy
    // can be rebuilt, but any live or unproven seat holder must remain protected.
    if (preserveUnknown && readdirSync(id.path).length) {
      root = join(id.path, `cotal-${randomBytes(8).toString("hex")}`);
    } else if (!snapshot && current !== root && readdirSync(id.path).length) {
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
    if (current !== root && (!hasRoot || !names.every(name => sameConnectorTree(join(current, name), join(root, name))))) {
      const staging = mkdtempSync(join(id.path, ".preparing-"));
      try {
        for (const name of names) {
          const source = join(current, name), destination = join(staging, name);
          if (existsSync(source)) cpSync(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => !retentionLockFile(basename(path)) });
        }
        if (!hasRoot) renameSync(staging, root);
        else {
          // Keep a live seat's graph and the updater's rollback source at their original paths.
          const pinned = snapshot && (sameConfigPath(dirname(snapshot), root) || setHasHolders(id.path));
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
