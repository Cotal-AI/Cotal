import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { executionBinding, executionLaunchBinding, executionDescriptorPath, executionLocation, executionRecord, executionSha256, executionShared, executionStore, protectedExecutionEntry, selectExecutionProgram, type ExecutionBinding, type ExecutionDescriptor } from "./cotal.js";
import { assertWritableExecutionDirectory, retainExecutionGeneration, type RetainedExecutionGeneration, writableExecutionStore, writeExecutionDescriptor } from "./execution-store.js";

interface ExecutionTransaction {
  v: 1;
  installed: string;
  launchEntry?: string;
  previous: { manifest: string; bootstrap: string; descriptor: ExecutionDescriptor | null };
  completed?: boolean;
  target: RetainedExecutionGeneration;
}

/** Restore owner write on owned update directories before creating staging, records or configuration. */
export function assertExecutionDestination(installed: string): boolean {
  if (existsSync(join(installed, "desktop-runtime.json"))) throw new Error("staged execution updates are unavailable on the desktop runtime");
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("staged execution updates are unavailable on this platform");
  for (const path of [installed, join(installed, "dist"), dirname(installed), dirname(dirname(installed)), dirname(dirname(dirname(installed)))]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe staged update destination: ${path}`);
    executionLocation(path);
  }
  let repaired = false;
  for (const path of [installed, join(installed, "dist"), dirname(installed), dirname(dirname(installed))])
    if (assertWritableExecutionDirectory(path, installed)) repaired = true;
  selectExecutionProgram(installed);
  return repaired;
}

function atomicFile(path: string, bytes: string | Buffer, mode: number, flush = false): void {
  const temporary = `${path}.${randomBytes(16).toString("hex")}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode, flush });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Persist immutable rollback bytes only after all pure-read target checks have accepted. */
export function journalExecutionTransaction(installed: string, target: RetainedExecutionGeneration, launchEntry?: string): string {
  assertExecutionDestination(installed);
  const store = executionStore(installed);
  const directory = mkdtempSync(join(store, ".transaction-"));
  const transaction: ExecutionTransaction = {
    v: 1, installed, launchEntry,
    previous: {
      manifest: readFileSync(join(installed, "package.json"), "utf8"),
      bootstrap: readFileSync(join(installed, "dist/cotal.js"), "utf8"),
      descriptor: lstatSync(executionDescriptorPath(installed), { throwIfNoEntry: false }) ? executionRecord(executionDescriptorPath(installed)) as ExecutionDescriptor : null,
    }, target,
  };
  const path = join(directory, "execution.json");
  atomicFile(path, JSON.stringify(transaction), 0o600, true);
  return path;
}

export function readExecutionTransaction(installed: string, path: string): ExecutionTransaction {
  const store = executionStore(installed);
  if (resolve(path) !== path || dirname(dirname(path)) !== store || !/^\.transaction-[A-Za-z0-9]+$/.test(dirname(path).slice(store.length + 1)) || !path.endsWith("/execution.json"))
    throw new Error("execution recovery journal is outside this installation");
  protectedExecutionEntry(store);
  protectedExecutionEntry(dirname(path));
  const record = executionRecord(path) as ExecutionTransaction;
  if (!record || record.v !== 1 || record.installed !== installed || !record.previous || typeof record.previous.manifest !== "string" || typeof record.previous.bootstrap !== "string" || !record.target || !/^[a-f0-9]{32}$/.test(record.target.id))
    throw new Error("invalid execution recovery journal");
  if (record.target.root !== join(store, record.target.id, "cotal-ai")) throw new Error("execution target escapes this installation");
  return record;
}

/** Plain per-file publication keeps the canonical original product graph intact. */
export function publishExecutionTransaction(installed: string, path: string, restore = false): void {
  const record = readExecutionTransaction(installed, path);
  const current = executionBinding(installed);
  const manifest = record.previous.manifest;
  const bootstrap = restore ? record.previous.bootstrap : `${readFileSync(join(record.target.root, "dist/cotal.js"), "utf8")}\n// cotal execution publication ${randomBytes(16).toString("hex")}\n`;
  const meta = JSON.parse(manifest) as { name?: unknown; version?: unknown };
  if (meta.name !== "cotal-ai" || typeof meta.version !== "string") throw new Error("invalid execution publication manifest");
  const finalBinding: ExecutionBinding = { name: "cotal-ai", version: meta.version, bootstrapSha256: executionSha256(bootstrap) };
  const descriptor: ExecutionDescriptor | null = restore ? record.previous.descriptor : {
    v: 1, binding: finalBinding, ...(record.launchEntry ? { launch: executionLaunchBinding(installed, record.launchEntry) } : {}), generation: { id: record.target.id, version: record.target.version, inventorySha256: record.target.inventorySha256 },
  };
  if (descriptor) {
    const transitional: ExecutionDescriptor = { ...descriptor, binding: current, bindings: [
      { ...current, bootstrapSha256: finalBinding.bootstrapSha256 }, finalBinding,
    ] };
    writeExecutionDescriptor(installed, transitional);
  }
  atomicFile(join(installed, "dist/cotal.js"), bootstrap, executionShared(installed) ? 0o755 : 0o700);
  if (descriptor) writeExecutionDescriptor(installed, descriptor);
  else rmSync(executionDescriptorPath(installed), { force: true });
  selectExecutionProgram(installed);
}

export function completeExecutionTransaction(installed: string, path: string): void {
  const record = readExecutionTransaction(installed, path);
  atomicFile(path, JSON.stringify({ ...record, completed: true }), 0o600);
}

/** Stage only within the owned retained store; npm receives this private prefix, never the live root.
 *  The caller holds the claim on npm's global root, so a staging folder already here was abandoned by
 *  an attempt that ended, and it is removed first. */
export function executionStagingPrefix(installed: string): string {
  assertExecutionDestination(installed);
  const store = writableExecutionStore(installed, executionShared(installed));
  return mkdtempSync(join(store, ".installing-"));
}

/** Rebind only the already selected launch route after our own mode-only hardening. */
export function repairExecutionInstallModes(installed: string, repair: () => number): number {
  const selected = selectExecutionProgram(installed);
  const descriptor = selected.retained ? executionRecord(executionDescriptorPath(installed)) as ExecutionDescriptor : undefined;
  const canonicalManifest = join(realpathSync.native(installed), "package.json");
  const beforeBinding = descriptor?.launch ? executionLaunchBinding(installed, descriptor.launch.entry) : undefined;
  const before = beforeBinding && (beforeBinding.path === canonicalManifest ? beforeBinding.ctime : descriptor!.launch!.ctime);
  const changed = repair();
  if (descriptor?.launch && beforeBinding) {
    const launch = executionLaunchBinding(installed, descriptor.launch.entry);
    const { ctime: _, ...previous } = beforeBinding;
    const { ctime: after, ...current } = launch;
    if (JSON.stringify(previous) !== JSON.stringify(current)) throw new Error("execution launch route changed during permission repair");
    const migrated = descriptor.launch.entry !== launch.entry || descriptor.launch.path !== launch.path;
    if (migrated || before !== after) {
      if (!migrated && !changed) throw new Error("execution launch route changed without a permission repair");
      if (selectExecutionProgram(installed).root !== selected.root) throw new Error("selected execution changed during permission repair");
      writeExecutionDescriptor(installed, { ...descriptor, launch });
    }
    if (selectExecutionProgram(installed).root !== selected.root) throw new Error("selected execution changed during permission repair");
  }
  return changed;
}

/** Remove a superseded active descriptor after an in-place package-manager install took over. */
export function retireSupersededExecutionDescriptor(installed: string): boolean {
  if (existsSync(join(installed, "desktop-runtime.json")) || (process.platform !== "linux" && process.platform !== "darwin")) return false;
  const descriptorPath = executionDescriptorPath(installed);
  try {
    if (!lstatSync(descriptorPath, { throwIfNoEntry: false })) return false;
  } catch (error) {
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  const selected = selectExecutionProgram(installed);
  if (selected.retained) return false;
  rmSync(descriptorPath, { force: true });
  return true;
}

export { retainExecutionGeneration };
