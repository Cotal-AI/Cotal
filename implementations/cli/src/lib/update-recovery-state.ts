import { lstatSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homeCotalDir, protectedLocalDirectory, recoverySnapshotProblem, updateRecoveryObservationName, type UpdateRecovery } from "@cotal-ai/workspace";

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
