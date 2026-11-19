import { readUpdateRecovery, recoveryDisposition, type UpdateRecovery } from "@cotal-ai/workspace";
import { readExtensionVersions, type ExtensionVersionInventory } from "./version.js";

const repair = "Run `cotal update --self` to reconcile this installation.";

export type UpdatePending =
  | { readonly kind: "none" }
  | { readonly kind: "receipt"; readonly recovery: UpdateRecovery; readonly instruction: string }
  | { readonly kind: "version-mismatch"; readonly extensions: readonly { readonly package: string; readonly version: string }[]; readonly instruction: string }
  | { readonly kind: "unreadable"; readonly source: "receipt" | "manifest" | "promotion"; readonly error: string; readonly instruction: string };

export const extensionPromotionRemedy = "resolve the extension promotion journal before retrying";

/** Read pending update evidence from metadata only, without seeding or checking package contents. */
export function readUpdatePending(current: string, inventory?: ExtensionVersionInventory | { promotionProblem: string }): UpdatePending {
  let recovery: UpdateRecovery | undefined;
  try {
    recovery = readUpdateRecovery();
  } catch (error) {
    return { kind: "unreadable", source: "receipt", error: error instanceof Error ? error.message : String(error), instruction: repair };
  }
  if (recovery) return { kind: "receipt", recovery, instruction: `Reconciliation pending: ${recoveryDisposition(recovery).instruction}` };
  if (inventory && "promotionProblem" in inventory) return { kind: "unreadable", source: "promotion", error: inventory.promotionProblem, instruction: extensionPromotionRemedy };
  const { versions, unreadable } = inventory ?? readExtensionVersions();
  if (unreadable !== undefined) return { kind: "unreadable", source: "manifest", error: unreadable, instruction: repair };
  const extensions = versions.filter(entry => entry.pkg.startsWith("@cotal-ai/") && entry.version !== current)
    .map(entry => ({ package: entry.pkg, version: entry.version }));
  return extensions.length ? { kind: "version-mismatch", extensions, instruction: "Reconciliation pending: Run `cotal update` to reconcile this home's extensions." } : { kind: "none" };
}
