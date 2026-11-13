import { lstatSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { homeCotalDir, protectedLocalDirectory, type UpdateRecovery } from "@cotal-ai/workspace";

export const recoveryRepairCommand = "cotal update --self --set-aside-recovery";

/** Inspect only this installation's snapshot, never a foreign destination. */
export function recoverySnapshotProblem(record: UpdateRecovery): string | undefined {
  const path = record.snapshot;
  if (!path) return "the interrupted update has no snapshot path";
  if (!isAbsolute(path) || dirname(resolve(path)) !== resolve(globalConfigDir()) || !basename(path).startsWith(".update-snapshot-"))
    return "the interrupted update snapshot does not belong to this configuration";
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return "the interrupted update snapshot is missing";
  if (info.isSymbolicLink() || !info.isDirectory()) return "the interrupted update snapshot is not a safe directory";
  return undefined;
}

/** Called under the closure writer barrier after consent and a fresh classification. */
export function retainUnusableRecovery(record: UpdateRecovery): string {
  if (!recoverySnapshotProblem(record)) throw new Error("a valid local update snapshot cannot be set aside");
  const home = homeCotalDir();
  protectedLocalDirectory(home, "the Cotal home");
  const names = ["update-recovery.json", "update-attempt.json"];
  const observed = names.map(name => {
    const path = join(home, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`unsafe update record: ${path}`);
    return stat ? { path, name, bytes: readFileSync(path) } : undefined;
  });
  const recovery = observed[0];
  if (!recovery || JSON.stringify(JSON.parse(recovery.bytes.toString())) !== JSON.stringify(record)) throw new Error("update recovery changed before retention");
  const destination = mkdtempSync(join(home, "update-recovery-retained-"));
  for (const entry of observed) {
    if (!entry) continue;
    if (!readFileSync(entry.path).equals(entry.bytes)) throw new Error("update record changed before retention");
    renameSync(entry.path, join(destination, entry.name));
  }
  return destination;
}
