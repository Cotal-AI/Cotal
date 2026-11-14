import { randomBytes } from "node:crypto";
import { accessSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionBinding, executionDescriptorPath, executionInventory, executionSha256, executionStore, protectedExecutionEntry, type ExecutionDescriptor } from "./cotal.js";

export interface RetainedExecutionGeneration {
  id: string;
  root: string;
  version: string;
  inventorySha256: string;
}

/** Prepare one complete, caller-verified package. Does not change the active artifact or run npm. */
export function retainExecutionGeneration(installedRoot: string, verifiedSource: string): RetainedExecutionGeneration {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("retained execution generations are unavailable on this platform");
  for (const path of [installedRoot, verifiedSource]) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("execution package must be a real directory");
    protectedExecutionEntry(path);
  }
  try {
    accessSync(installedRoot, constants.W_OK);
    accessSync(dirname(dirname(installedRoot)), constants.W_OK);
  }
  catch { throw new Error(`installation is not writable; use the owning command: npm install -g --prefix ${dirname(dirname(dirname(installedRoot)))} cotal-ai@latest`); }
  const store = executionStore(installedRoot);
  if (!lstatSync(store, { throwIfNoEntry: false })) mkdirSync(store, { mode: 0o700 });
  if (!lstatSync(store).isDirectory() || lstatSync(store).isSymbolicLink()) throw new Error("unsafe execution generation store");
  protectedExecutionEntry(store);
  const before = executionInventory(verifiedSource);
  const staging = mkdtempSync(join(store, ".preparing-"));
  try {
    const root = join(staging, "cotal-ai");
    cpSync(verifiedSource, root, { recursive: true, dereference: false, verbatimSymlinks: true });
    if (JSON.stringify(before) !== JSON.stringify(executionInventory(root)) ||
        JSON.stringify(before) !== JSON.stringify(executionInventory(verifiedSource))) throw new Error("verified execution source changed during retention");
    const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (meta.name !== "cotal-ai" || typeof meta.version !== "string" || !meta.version) throw new Error("invalid retained execution package");
    if (!lstatSync(join(root, "dist", "cotal-program.js")).isFile() || !lstatSync(join(root, "dist", "cotal.js")).isFile())
      throw new Error("retained execution package has no declared bootstrap and program");
    const inventorySha256 = executionSha256(JSON.stringify(before));
    writeFileSync(join(staging, "inventory.json"), JSON.stringify(before), { mode: 0o600, flag: "wx" });
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
  protectedExecutionEntry(installedRoot);
  const path = executionDescriptorPath(installedRoot);
  const temporary = `${path}.${randomBytes(16).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
