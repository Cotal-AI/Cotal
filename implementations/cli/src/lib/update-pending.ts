import { loadExtensionsManifest, readUpdateRecovery, recoveryDisposition, type UpdateRecovery } from "@cotal-ai/workspace";
import { readCursor, readRecovery, type ReconcileCursor, type RecoveryObligation } from "../seed/lock.js";

const repair = "Run `cotal update --self` to reconcile this installation.";
const seedRepair = "Run `cotal ext seed --repair` to reconcile the connectors.";

export type UpdatePending =
  | { readonly kind: "none" }
  | { readonly kind: "receipt"; readonly recovery: UpdateRecovery; readonly instruction: string }
  | { readonly kind: "seed"; readonly cursor?: ReconcileCursor; readonly recovery?: RecoveryObligation; readonly instruction: string }
  | { readonly kind: "version-mismatch"; readonly extensions: readonly { readonly package: string; readonly version: string }[]; readonly instruction: string }
  | { readonly kind: "unreadable"; readonly source: "receipt" | "manifest" | "seed"; readonly error: string; readonly instruction: string };

/** Read pending update evidence from metadata only, without seeding or checking package contents. */
export function readUpdatePending(current: string): UpdatePending {
  let recovery: UpdateRecovery | undefined;
  try {
    recovery = readUpdateRecovery();
  } catch (error) {
    return { kind: "unreadable", source: "receipt", error: error instanceof Error ? error.message : String(error), instruction: repair };
  }
  if (recovery) return { kind: "receipt", recovery, instruction: `Reconciliation pending: ${recoveryDisposition(recovery).instruction}` };
  try {
    const cursor = readCursor();
    const recovery = readRecovery();
    if (cursor || recovery) return { kind: "seed", cursor, recovery, instruction: `Reconciliation pending: ${seedRepair}` };
  } catch (error) {
    return { kind: "unreadable", source: "seed", error: error instanceof Error ? error.message : String(error), instruction: seedRepair };
  }
  try {
    const extensions = loadExtensionsManifest().extensions
      .filter(entry => entry.pkg.startsWith("@cotal-ai/") && entry.version !== current)
      .map(entry => ({ package: entry.pkg, version: entry.version }));
    return extensions.length ? { kind: "version-mismatch", extensions, instruction: `Reconciliation pending: ${repair}` } : { kind: "none" };
  } catch (error) {
    return { kind: "unreadable", source: "manifest", error: error instanceof Error ? error.message : String(error), instruction: repair };
  }
}
