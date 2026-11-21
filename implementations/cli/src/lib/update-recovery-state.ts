import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clearUpdateRecovery, homeCotalDir, protectedLocalDirectory, protectedResolvedDirectory, readUpdateRecovery, recordUpdateCompletion, recoverySnapshotProblem, updateClosureOwner, updateRecoveryObservationName, updateSnapshotConfig, writeUpdateRecovery, type UpdateRecovery } from "@cotal-ai/workspace";
import type { UpdateRuntime } from "../commands/update.js";

/** Complete the selected execution journal without allowing npm to change the selection. */
export async function resumePublishedUpdate(rt: UpdateRuntime, record: UpdateRecovery, flags: string[]): Promise<{ entry: string; version: string; resumed: true }> {
  const { target: version, snapshot, execution: journal } = record;
  try {
    const root = rt.executionGlobalRoot?.();
    if (!root || !snapshot || !journal) throw new Error("cannot identify the published update installation");
    const config = updateSnapshotConfig(record);
    if (!config) throw new Error("the interrupted update snapshot does not belong to this configuration");
    protectedResolvedDirectory(config, "the Cotal config folder");
    const info = lstatSync(snapshot, { throwIfNoEntry: false });
    if (info ? !info.isDirectory() : record.phase !== "verified-ready") throw new Error("the interrupted update snapshot is unavailable as a plain directory");
    const release = rt.claimGlobalUpdate(root);
    try {
      const execution = rt.recoverExecution?.(journal);
      if (!execution?.verifyPublished?.(version)) throw new Error("the recorded target is not the selected execution generation");
      writeUpdateRecovery({ ...record, owner: updateClosureOwner() });
      if (record.phase !== "verified-ready") {
        rt.out(`Reconciling installed cotal-ai@${version}`);
        const env = { ...rt.env, COTAL_UPDATE_TARGET_VERSION: version, COTAL_UPDATE_PARENT: String(rt.pid), COTAL_UPDATE_PARENT_WAITS: "1" };
        const child = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [execution.entry, "update", ...flags], env, true);
        if (child.status !== 0) throw new Error(child.error || child.stderr.trim() || `reconciliation exited ${child.status ?? child.signal ?? "without a result"}`);
        writeUpdateRecovery({ ...readUpdateRecovery()!, installed: version, phase: "verified-ready" });
      }
      if (record.admission?.disposition !== "deferred") {
        const deferred = await rt.waitForInstalledGeneration?.(version);
        if (deferred) throw new Error(deferred);
      }
      if (!execution.verifyPublished(version)) throw new Error("the selected execution generation changed during reconciliation");
      rmSync(snapshot, { recursive: true, force: true });
      recordUpdateCompletion(version, `updated to ${version}`, true);
      execution.complete?.();
      clearUpdateRecovery();
      rt.generationWaited = true;
      rt.out(`✓ cotal-ai@${version} in use and reconciled`);
      if (record.admission?.disposition === "deferred") rt.out(`machine daemon activation deferred: ${record.admission.reason}; software update finished`);
      return { entry: execution.entry, version, resumed: true };
    } finally { release(); }
  } catch (error) {
    throw new Error(`Interrupted update to cotal-ai@${version} is still pending: ${error instanceof Error ? error.message : String(error)}. Run \`cotal update --self\` again after correcting the reported problem.`);
  }
}

/** Called under exclusive updater access after re-reading and classifying the record. */
export function retainUnusableRecovery(record: UpdateRecovery, now: number): string {
  if (!recoverySnapshotProblem(record)) throw new Error("a valid local update snapshot cannot be retained instead of restored");
  const home = homeCotalDir();
  protectedLocalDirectory(home, "the Cotal home");
  const names = ["update-recovery.json", "update-attempt.json", updateRecoveryObservationName];
  const observed = names.map(name => {
    const path = join(home, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`unsafe update record: ${path}`);
    return stat ? { path, name, bytes: readFileSync(path) } : undefined;
  });
  const recovery = observed[0];
  if (!recovery || JSON.stringify(JSON.parse(recovery.bytes.toString())) !== JSON.stringify(record)) throw new Error("update recovery changed before retention");
  const destination = mkdtempSync(join(home, `update-recovery-retained-${new Date(now).toISOString().replaceAll(":", "-")}-`));
  for (const entry of observed) {
    if (!entry) continue;
    if (!readFileSync(entry.path).equals(entry.bytes)) throw new Error("update record changed before retention");
    renameSync(entry.path, join(destination, entry.name));
  }
  return destination;
}
