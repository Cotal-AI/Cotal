import { lstatSync } from "node:fs";
import { join } from "node:path";
import { extensionsDir, extensionsManifestPath, isCommandFailure, loadExtensionsManifest, readUpdateRecovery, recoveryDisposition, type UpdateRecovery } from "@cotal-ai/workspace";
import { readWitness } from "../seed/authority.js";
import { displayCmd } from "./self-exec.js";

const receiptRepair = "Run `cotal update --self` to reconcile this installation.";
export const manifestRepair = "run `cotal ext seed --repair` to preserve the damaged file and rebuild the built-in inventory";
export const manifestReadRemedy = (error: unknown): string => isCommandFailure(error) && error.remedy ? error.remedy : manifestRepair;

export type UpdatePending =
  | { readonly kind: "none" }
  | { readonly kind: "receipt"; readonly recovery: UpdateRecovery; readonly instruction: string }
  | { readonly kind: "version-mismatch"; readonly extensions: readonly { readonly package: string; readonly version: string }[]; readonly instruction: string }
  | { readonly kind: "inventory-missing"; readonly instruction: string }
  | { readonly kind: "unreadable"; readonly source: "receipt" | "manifest"; readonly error: string; readonly instruction: string };

/** Read pending update evidence from metadata only, without seeding or checking package contents. */
export function readUpdatePending(current: string): UpdatePending {
  let recovery: UpdateRecovery | undefined;
  try {
    recovery = readUpdateRecovery();
  } catch (error) {
    return { kind: "unreadable", source: "receipt", error: error instanceof Error ? error.message : String(error), instruction: receiptRepair };
  }
  if (recovery) {
    const decision = recoveryDisposition(recovery);
    return { kind: "receipt", recovery, instruction: decision.action === "active" ? decision.instruction : `Reconciliation pending: ${decision.instruction}` };
  }
  try {
    if (witnessedInventoryMissing()) return { kind: "inventory-missing", instruction: `Reconciliation pending: the extensions inventory is missing. Run \`${displayCmd()} update\` to register built-in packages still on disk.` };
    const extensions = loadExtensionsManifest().extensions
      .filter(entry => entry.pkg.startsWith("@cotal-ai/") && entry.version !== current)
      .map(entry => ({ package: entry.pkg, version: entry.version }));
    return extensions.length ? { kind: "version-mismatch", extensions, instruction: "Reconciliation pending: Run `cotal update` to reconcile this home's extensions." } : { kind: "none" };
  } catch (error) {
    return { kind: "unreadable", source: "manifest", error: error instanceof Error ? error.message : String(error), instruction: manifestReadRemedy(error) };
  }
}

/** A seeded prefix whose inventory is gone while its npm lock or installed modules remain. A missing file
 *  with neither is an empty prefix, not a lost inventory. */
function witnessedInventoryMissing(): boolean {
  if (!readWitness()) return false;
  if (lstatSync(extensionsManifestPath(), { throwIfNoEntry: false })) return false;
  const prefix = extensionsDir();
  return lstatSync(join(prefix, "package-lock.json"), { throwIfNoEntry: false })?.isFile() === true
    || lstatSync(join(prefix, "node_modules"), { throwIfNoEntry: false })?.isDirectory() === true;
}
