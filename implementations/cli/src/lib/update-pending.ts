import { loadExtensionsManifest, readUpdateRecovery, recoveryDisposition, type UpdateRecovery } from "@cotal-ai/workspace";
import { readCursor, readRecovery, reconcileLockActive, seedChildStatus, type ReconcileCursor, type RecoveryObligation } from "../seed/lock.js";

const repair = "Run `cotal update --self` to reconcile this installation.";
const seedRepair = "Run `cotal ext seed --repair` to reconcile the connectors.";

export type UpdatePending =
  | { readonly kind: "none" }
  | { readonly kind: "receipt"; readonly recovery: UpdateRecovery; readonly instruction: string }
  | { readonly kind: "seed-active"; readonly instruction: string }
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
    if (cursor || recovery) {
      if (reconcileLockActive()) return { kind: "seed-active", instruction: "Connector seeding is in progress. Wait for it to finish, then retry `cotal update --check`." };
      const child = seedChildStatus();
      if (child.kind === "live") return { kind: "seed-active", instruction: `A connector seed child (pid ${child.pid}) is still installing. Wait for it to finish, then retry \`cotal update --check\`.` };
      const instruction = child.kind === "ambiguous"
        ? `A connector seed may be mid-flight (marker ${child.path}). Check whether a seed process is still running before using \`cotal ext seed --repair\`.`
        : child.kind === "stale"
          ? "A connector seed child stopped before completing. Run `cotal ext seed` to resume reconciliation."
          : cursor?.failed
            ? `A previous connector seed failed (package "${cursor.package}", phase ${cursor.phase}): ${cursor.failed} - fix that, then run \`cotal ext seed --repair\`.`
            : `Reconciliation pending: ${seedRepair}`;
      return { kind: "seed", cursor, recovery, instruction };
    }
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
