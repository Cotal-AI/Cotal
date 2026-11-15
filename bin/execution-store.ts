import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionBinding, executionDescriptorPath, executionInventory, executionLocation, executionSha256, executionShared, executionStore, protectedExecutionEntry, type ExecutionDescriptor } from "./cotal.js";

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
