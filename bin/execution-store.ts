import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claimGlobalNpmUpdateLock, readUpdateRecovery, windowsSetOwnedByCurrentUser, windowsSetTreeOwnership } from "@cotal-ai/workspace";
import { inspectLock, processStartToken } from "@cotal-ai/core";
import { executionBinding, executionDescriptorPath, executionInventory, executionLocation, executionRecord, executionSha256, executionShared, executionStore, protectedExecutionEntry, type ExecutionDescriptor } from "./cotal.js";

export interface RetainedExecutionGeneration {
  id: string;
  root: string;
  version: string;
  inventorySha256: string;
}

/** Remove group and other write from a tree this process just created. Node before 24.22 applies the
 *  process umask to the folders a recursive `cpSync` creates, not the source modes, so a umask of 0002
 *  leaves them group-writable. A copy that stands in for a package other accounts run is readable by
 *  them whatever the umask. */
function withoutSharedWrite(path: string, shared: boolean): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  const mode = (info.mode & 0o7755) | (shared ? (info.isDirectory() || (info.mode & 0o100) !== 0 ? 0o055 : 0o044) : 0);
  if (mode !== (info.mode & 0o7777)) chmodSync(path, mode);
  if (info.isDirectory()) for (const name of readdirSync(path)) withoutSharedWrite(join(path, name), shared);
}

/** Prepare one complete, caller-verified package. Does not change the active artifact or run npm. */
export function retainExecutionGeneration(installedRoot: string, verifiedSource: string): RetainedExecutionGeneration {
  if (existsSync(join(installedRoot, "desktop-runtime.json")) || existsSync(join(verifiedSource, "desktop-runtime.json")))
    throw new Error("retained execution generations are unavailable on the desktop runtime");
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("retained execution generations are unavailable on this platform");
  for (const path of [installedRoot, verifiedSource]) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("execution package must be a real directory");
  }
  executionLocation(installedRoot);
  protectedExecutionEntry(verifiedSource);
  try {
    accessSync(installedRoot, constants.W_OK);
    accessSync(dirname(dirname(installedRoot)), constants.W_OK);
  }
  catch { throw new Error(`installation is not writable; use the owning command: npm install -g --prefix ${dirname(dirname(dirname(installedRoot)))} cotal-ai@latest`); }
  const store = executionStore(installedRoot), shared = executionShared(installedRoot);
  if (!lstatSync(store, { throwIfNoEntry: false })) { mkdirSync(store, { mode: 0o700 }); if (shared) chmodSync(store, 0o755); }
  if (!lstatSync(store).isDirectory() || lstatSync(store).isSymbolicLink()) throw new Error("unsafe execution generation store");
  protectedExecutionEntry(store);
  const before = executionInventory(verifiedSource);
  const staging = mkdtempSync(join(store, ".preparing-"));
  try {
    const root = join(staging, "cotal-ai");
    cpSync(verifiedSource, root, { recursive: true, dereference: false, verbatimSymlinks: true });
    withoutSharedWrite(root, shared);
    if (JSON.stringify(before) !== JSON.stringify(executionInventory(root)) ||
        JSON.stringify(before) !== JSON.stringify(executionInventory(verifiedSource))) throw new Error("verified execution source changed during retention");
    const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (meta.name !== "cotal-ai" || typeof meta.version !== "string" || !meta.version) throw new Error("invalid retained execution package");
    if (!lstatSync(join(root, "dist", "cotal-program.js")).isFile() || !lstatSync(join(root, "dist", "cotal.js")).isFile())
      throw new Error("retained execution package has no declared bootstrap and program");
    const inventorySha256 = executionSha256(JSON.stringify(before));
    writeFileSync(join(staging, "inventory.json"), JSON.stringify(before), { mode: 0o600, flag: "wx" });
    if (shared) { chmodSync(join(staging, "inventory.json"), 0o644); chmodSync(staging, 0o755); }
    const id = randomBytes(16).toString("hex");
    renameSync(staging, join(store, id));
    return { id, root: join(store, id, "cotal-ai"), version: meta.version, inventorySha256 };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Build a record for a later locked transaction. Creating it publishes or cleans up nothing. */
export function describeExecutionGeneration(installedRoot: string, generation: RetainedExecutionGeneration): ExecutionDescriptor {
  return { v: 1, binding: executionBinding(installedRoot), generation: {
    id: generation.id, version: generation.version, inventorySha256: generation.inventorySha256,
  } };
}

/** Test and operator-building primitive. The updater must hold its existing lock before calling it. */
export function writeExecutionDescriptor(installedRoot: string, descriptor: ExecutionDescriptor): void {
  if (existsSync(join(installedRoot, "desktop-runtime.json")))
    throw new Error("retained execution generations are unavailable on the desktop runtime");
  executionLocation(installedRoot);
  const path = executionDescriptorPath(installedRoot);
  const temporary = `${path}.${randomBytes(16).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { flag: "wx", mode: 0o600 });
    if (executionShared(installedRoot)) chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export interface ConnectorSetCleanup {
  readonly root: string;
  readonly installRoot: string;
  readonly current: string;
  readonly previous?: string;
  readonly holders: readonly { readonly version?: string; readonly state: "live" | "unknown" }[];
}

/** Retire abandoned update data and optional connector sets under one installation update lock. */
export function cleanupExecutionStore(installed: string, report: (line: string) => void = line => process.stderr.write(`${line}\n`), sets?: ConnectorSetCleanup): void {
  const executionSupported = (process.platform === "linux" || process.platform === "darwin") && !existsSync(join(installed, "desktop-runtime.json"));
  if (!executionSupported && !sets) return;
  let release: (() => void) | undefined;
  let warned = false;
  const warn = (error: unknown): void => {
    if (warned) return;
    warned = true;
    report(`execution store cleanup: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "could not remove old update data"}`);
  };
  try {
    const store = executionStore(installed), info = executionSupported ? lstatSync(store, { throwIfNoEntry: false }) : undefined;
    const windows = process.platform === "win32";
    if (!windows && typeof process.getuid !== "function") throw new Error("connector set cleanup requires native ownership support");
    const uid = windows ? undefined : process.getuid!();
    if (info && info.uid !== uid) return;
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("store is not a real directory");
    if (info) protectedExecutionEntry(store);
    if (!info && !sets) return;
    if (sets) {
      if (windows ? !windowsSetOwnedByCurrentUser(installed) : lstatSync(installed).uid !== uid) return;
      if (!isAbsolute(sets.root) || resolve(sets.root) !== sets.root || realpathSync.native(sets.root) !== sets.root || realpathSync.native(sets.installRoot) !== realpathSync.native(installed)) throw new Error("connector sets do not name this installation's canonical root");
      for (let parent = dirname(sets.root); parent !== dirname(parent); parent = dirname(parent)) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (!windows && ((stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))))) throw new Error("connector set root has an unprotected ancestor");
      }
      const rootInfo = lstatSync(sets.root);
      if (windows ? !windowsSetOwnedByCurrentUser(sets.root) : rootInfo.uid !== uid) return;
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (!windows && (rootInfo.mode & 0o022) !== 0)) throw new Error("connector set root is not a protected owned directory");
    }
    const modules = dirname(installed), lock = inspectLock(join(modules, ".cotal-update.lock"));
    if (lock.state === "active") {
      if (lock.owner.pid !== process.pid || lock.owner.start !== processStartToken(process.pid)) return;
    } else {
      try { release = claimGlobalNpmUpdateLock(modules); }
      catch (error) {
        if (inspectLock(join(modules, ".cotal-update.lock")).state === "active") return;
        throw error;
      }
    }
    if (info) {
    const names = readdirSync(store);
    const id = /^[a-f0-9]{32}$/;
    type Generation = ExecutionDescriptor["generation"];
    const generation = (value: unknown): Generation => {
      const row = value as Generation | undefined;
      if (!row || !id.test(row.id) || typeof row.version !== "string" || !/^[a-f0-9]{64}$/.test(row.inventorySha256)) throw new Error("invalid retained generation record");
      return row;
    };
    const recovery = readUpdateRecovery();
    const protectedJournal = recovery?.execution;
    const transactions = names.filter(name => /^\.transaction-[A-Za-z0-9]+$/.test(name)).map(name => {
      const directory = join(store, name), stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new Error("unsafe transaction directory");
      const path = join(directory, "execution.json");
      const record = executionRecord(path) as { v: number; installed: string; completed?: boolean; target: Generation & { root: string }; previous: { descriptor: ExecutionDescriptor | null } };
      if (record.v !== 1 || typeof record.installed !== "string" || executionStore(record.installed) !== store || !record.previous) throw new Error("invalid execution journal");
      generation(record.target);
      if (record.target.root !== join(store, record.target.id, "cotal-ai")) throw new Error("execution journal target escapes store");
      if (record.previous.descriptor) generation(record.previous.descriptor.generation);
      return { directory, path, record, finished: record.completed === true && path !== protectedJournal };
    });
    // A successful successor supersedes its uniquely identified rollback ancestry. Unlike the
    // absence of this home's recovery record, its explicit completion is installation-wide proof.
    for (const completed of transactions.filter(row => row.finished)) {
      let predecessor = completed.record.previous.descriptor?.generation;
      const visited = new Set<string>([completed.record.target.id]);
      while (predecessor && !visited.has(predecessor.id)) {
        visited.add(predecessor.id);
        const expected = predecessor;
        const ancestors = transactions.filter(row => row.record.installed === completed.record.installed
          && executionDescriptorPath(row.record.installed) === executionDescriptorPath(completed.record.installed)
          && row.record.target.id === expected.id && row.record.target.version === expected.version
          && row.record.target.inventorySha256 === expected.inventorySha256);
        if (ancestors.length !== 1 || ancestors[0].path === protectedJournal) break;
        const ancestor = ancestors[0];
        if (!ancestor.finished) {
          const temporary = `${ancestor.path}.${randomBytes(16).toString("hex")}`;
          try {
            writeFileSync(temporary, JSON.stringify({ ...ancestor.record, completed: true }), { flag: "wx", mode: 0o600 });
            renameSync(temporary, ancestor.path);
          } finally { rmSync(temporary, { force: true }); }
          ancestor.record.completed = true;
          ancestor.finished = true;
        }
        predecessor = ancestor.record.previous.descriptor?.generation;
      }
    }
    if (transactions.some(row => row.record.completed !== true)) warn(new Error("unmarked transaction retained because completion is not proven for every Cotal home"));
    const remove = (path: string): void => {
      try {
        const stat = lstatSync(path);
        if (stat.uid !== uid || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`not an owned update directory: ${path}`);
        rmSync(path, { recursive: true, force: true });
      } catch (error) { warn(error); }
    };
    for (const name of names) {
      if (/^\.(?:installing|preparing)-[A-Za-z0-9]+$/.test(name)) remove(join(store, name));
    }
    for (const row of transactions.filter(row => row.finished && row.path !== protectedJournal)) remove(row.directory);
    }
    if (sets) {
      const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
      if (!version.test(sets.current) || (sets.previous !== undefined && !version.test(sets.previous)) || !Array.isArray(sets.holders)) throw new Error("invalid connector set retention record");
      const keep = new Set([sets.current, ...(sets.previous ? [sets.previous] : [])]);
      for (const retained of keep) {
        const stat = lstatSync(join(sets.root, retained));
        if (!stat.isDirectory() || stat.isSymbolicLink() || (windows ? !windowsSetOwnedByCurrentUser(join(sets.root, retained)) : stat.uid !== uid || (stat.mode & 0o022) !== 0)) throw new Error("current or previous connector set is not an owned protected directory");
      }
      for (const holder of sets.holders) {
        if (!holder || !["live", "unknown"].includes(holder.state) || (holder.version !== undefined && !version.test(holder.version))) throw new Error("invalid connector set holder");
        if (holder.version === undefined) return; // An unversioned live/unknown holder can hold any set.
        keep.add(holder.version);
      }
      const ownedTree = (path: string): void => {
        const rel = relative(sets.root, path);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("connector set path escapes root");
        if (windows) {
          const ownership = windowsSetTreeOwnership(path);
          if (!ownership.owned) throw new Error(`owners ${ownership.owners.join(", ") || "unknown"}, reparse points ${ownership.reparsePoints}`);
          return;
        }
        const stat = lstatSync(path);
        if (stat.uid !== uid || (!stat.isSymbolicLink() && (!stat.isDirectory() && !stat.isFile() || (stat.mode & 0o022) !== 0))) throw new Error(`not a protected owned connector set entry: ${path}`);
        if (stat.isDirectory()) for (const name of readdirSync(path)) ownedTree(join(path, name));
      };
      for (const name of readdirSync(sets.root)) {
        if (!version.test(name) || keep.has(name)) continue;
        const path = join(sets.root, name);
        try {
          if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`connector set is not a real directory: ${path}`);
          ownedTree(path); rmSync(path, { recursive: true, force: true });
        }
        catch (error) { warn(windows ? new Error(`kept connector set directory ${path}: ${error instanceof Error ? error.message : "owner unknown or removal failed"}; run this installation's \`cotal ext seed --repair\` as its owning account`) : error); }
      }
    }
  } catch (error) { warn(error); }
  finally { try { release?.(); } catch (error) { warn(error); } }
}
