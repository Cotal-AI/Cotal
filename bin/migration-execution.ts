import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { canonicalJson } from "@cotal-ai/core";
import { assertMaintenanceLock, claimGlobalNpmUpdateLock, claimUpdateClosureAccess, localRecordObject, readMaintenanceResumeDocument, type MaintenanceLock } from "@cotal-ai/workspace";
import { captureMigrationNode, verifyMigrationNode, type MigrationNodeRecord } from "@cotal-ai/cli/migration-node";
import { executionBinding, executionInventory, executionRecord, executionSha256, executionStore } from "./cotal.js";
import { retainExecutionGeneration, type RetainedExecutionGeneration } from "./execution-store.js";

export interface MigrationExecutionReference {
  generation: RetainedExecutionGeneration;
  node: MigrationNodeRecord;
}
type Resume = Parameters<typeof readMaintenanceResumeDocument>[1];
function locked<T>(lock: MaintenanceLock, installedRoot: string, work: () => T): T {
  if (process.platform !== "linux") throw new Error(`migration execution custody is unsupported on ${process.platform}; Linux is required`);
  assertMaintenanceLock(lock);
  if (realpathSync.native(installedRoot) !== installedRoot) throw new Error("migration execution custody needs the canonical installation");
  const releaseClosure = claimUpdateClosureAccess(); let releaseInstall = () => {};
  try { releaseInstall = claimGlobalNpmUpdateLock(dirname(installedRoot)); const result = work(); assertMaintenanceLock(lock); return result; }
  finally { releaseInstall(); releaseClosure(); }
}
function verify(lock: MaintenanceLock, installedRoot: string, reference: MigrationExecutionReference): void {
  localRecordObject(reference, ["generation", "node"]);
  const generation = localRecordObject(reference.generation, ["id", "root", "version", "inventorySha256"]);
  if (Object.keys(reference).length !== 2 || Object.keys(generation).length !== 4 || typeof generation.id !== "string" || !/^[a-f0-9]{32}$/.test(generation.id) ||
      generation.root !== join(executionStore(installedRoot), generation.id, "cotal-ai") || typeof generation.version !== "string" ||
      typeof generation.inventorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(generation.inventorySha256))
    throw new Error("migration execution reference does not name this installation's generation");
  const root = generation.root as string;
  if (realpathSync.native(root) !== root || executionBinding(root).version !== generation.version ||
      executionSha256(JSON.stringify(executionRecord(join(dirname(root), "inventory.json")))) !== generation.inventorySha256 ||
      executionSha256(JSON.stringify(executionInventory(root))) !== generation.inventorySha256)
    throw new Error("retained execution generation differs from its migration receipt");
  verifyMigrationNode(lock, dirname(root), reference.node);
}

/** The coordinator supplies its verified complete package and records the result in its existing
 * resume document under inventory.migrationExecution while both native writer locks still hold.
 * This changes no execution descriptor, installed version, daemon or activation state. */
export function captureMigrationExecution(opts: { lock: MaintenanceLock; installedRoot: string; verifiedSource: string;
  record(reference: MigrationExecutionReference): Resume }): { reference: MigrationExecutionReference; resume: Resume } {
  return locked(opts.lock, opts.installedRoot, () => {
    const generation = retainExecutionGeneration(opts.installedRoot, opts.verifiedSource);
    const reference = { generation, node: captureMigrationNode(opts.lock, dirname(generation.root)) };
    verify(opts.lock, opts.installedRoot, reference);
    const resume = opts.record(reference);
    const inventory = readMaintenanceResumeDocument(opts.lock.root, resume).inventory;
    if (canonicalJson(localRecordObject(inventory, Object.keys(inventory ?? {})).migrationExecution) !== canonicalJson(reference))
      throw new Error("the existing maintenance resume document did not bind the execution receipt");
    verify(opts.lock, opts.installedRoot, reference);
    return { reference, resume };
  });
}

/** Revalidate saved package and Node bytes under the original installation's writer locks. The
 * original Node path may be gone and the installation may now select another generation. */
export function verifyMigrationExecution(lock: MaintenanceLock, installedRoot: string, reference: MigrationExecutionReference): void {
  locked(lock, installedRoot, () => verify(lock, installedRoot, reference));
}
