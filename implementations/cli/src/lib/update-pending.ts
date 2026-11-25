import { loadExtensionsManifest, readUpdateRecovery, recoveryDisposition, type UpdateRecovery } from "@cotal-ai/workspace";

const receiptRepair = "Run `cotal update --self` to reconcile this installation.";
export const manifestRepair = "Repair the manifest with `cotal ext seed --repair`.";

export type UpdatePending =
  | { readonly kind: "none" }
  | { readonly kind: "receipt"; readonly recovery: UpdateRecovery; readonly instruction: string }
  | { readonly kind: "version-mismatch"; readonly extensions: readonly { readonly package: string; readonly version: string }[]; readonly instruction: string }
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
    const extensions = loadExtensionsManifest().extensions
      .filter(entry => entry.pkg.startsWith("@cotal-ai/") && entry.version !== current)
      .map(entry => ({ package: entry.pkg, version: entry.version }));
    return extensions.length ? { kind: "version-mismatch", extensions, instruction: "Reconciliation pending: Run `cotal update` to reconcile this home's extensions." } : { kind: "none" };
  } catch (error) {
    return { kind: "unreadable", source: "manifest", error: error instanceof Error ? error.message : String(error), instruction: manifestRepair };
  }
}
