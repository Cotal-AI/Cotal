import { randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { executionBinding, executionDescriptorName, executionRecord, executionSha256, executionStore, protectedExecutionEntry, selectExecutionProgram, type ExecutionBinding, type ExecutionDescriptor } from "./cotal.js";
import { retainExecutionGeneration, type RetainedExecutionGeneration, writeExecutionDescriptor } from "./execution-store.js";

interface ExecutionTransaction {
  v: 1;
  installed: string;
  previous: { manifest: string; bootstrap: string; descriptor: ExecutionDescriptor | null };
  target: RetainedExecutionGeneration;
}

/** The admission check runs before creating staging, records or configuration directories. */
export function assertExecutionDestination(installed: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("staged execution updates are unavailable on this platform");
  for (const path of [installed, dirname(installed), dirname(dirname(installed)), dirname(dirname(dirname(installed)))]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe staged update destination: ${path}`);
    protectedExecutionEntry(path);
  }
  try {
    for (const path of [installed, join(installed, "dist"), dirname(dirname(installed))]) accessSync(path, constants.W_OK);
  } catch {
    throw new Error(`installation is not writable; use the owning command: npm install -g --prefix ${dirname(dirname(dirname(installed)))} cotal-ai@latest`);
  }
  selectExecutionProgram(installed);
}

function atomicFile(path: string, bytes: string | Buffer, mode: number): void {
  const temporary = `${path}.${randomBytes(16).toString("hex")}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Persist immutable rollback bytes only after all pure-read target checks have accepted. */
export function journalExecutionTransaction(installed: string, target: RetainedExecutionGeneration): string {
  assertExecutionDestination(installed);
  const store = executionStore(installed);
  const directory = mkdtempSync(join(store, ".transaction-"));
  const transaction: ExecutionTransaction = {
    v: 1, installed,
    previous: {
      manifest: readFileSync(join(installed, "package.json"), "utf8"),
      bootstrap: readFileSync(join(installed, "dist/cotal.js"), "utf8"),
      descriptor: lstatSync(join(installed, executionDescriptorName), { throwIfNoEntry: false }) ? executionRecord(join(installed, executionDescriptorName)) as ExecutionDescriptor : null,
    }, target,
  };
  const path = join(directory, "execution.json");
  writeFileSync(path, JSON.stringify(transaction), { flag: "wx", mode: 0o600 });
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
  const manifest = restore ? record.previous.manifest : readFileSync(join(record.target.root, "package.json"), "utf8");
  const bootstrap = restore ? record.previous.bootstrap : readFileSync(join(record.target.root, "dist/cotal.js"), "utf8");
  const meta = JSON.parse(manifest) as { name?: unknown; version?: unknown };
  if (meta.name !== "cotal-ai" || typeof meta.version !== "string") throw new Error("invalid execution publication manifest");
  const finalBinding: ExecutionBinding = { name: "cotal-ai", version: meta.version, bootstrapSha256: executionSha256(bootstrap) };
  const descriptor: ExecutionDescriptor | null = restore ? record.previous.descriptor : {
    v: 1, binding: finalBinding, generation: { id: record.target.id, version: record.target.version, inventorySha256: record.target.inventorySha256 },
  };
  if (descriptor) {
    const transitional: ExecutionDescriptor = { ...descriptor, binding: current, bindings: [
      { ...current, bootstrapSha256: finalBinding.bootstrapSha256 }, finalBinding,
    ] };
    writeExecutionDescriptor(installed, transitional);
  }
  atomicFile(join(installed, "dist/cotal.js"), bootstrap, 0o700);
  atomicFile(join(installed, "package.json"), manifest, 0o600);
  if (descriptor) writeExecutionDescriptor(installed, descriptor);
  else rmSync(join(installed, executionDescriptorName), { force: true });
  selectExecutionProgram(installed);
}

/** Stage only within the owned retained store; npm receives this private prefix, never the live root. */
export function executionStagingPrefix(installed: string): string {
  assertExecutionDestination(installed);
  const store = executionStore(installed);
  if (!lstatSync(store, { throwIfNoEntry: false })) mkdirSync(store, { mode: 0o700 });
  if (!lstatSync(store).isDirectory() || lstatSync(store).isSymbolicLink()) throw new Error("unsafe execution generation store");
  protectedExecutionEntry(store);
  return mkdtempSync(join(store, ".installing-"));
}

export { retainExecutionGeneration };
