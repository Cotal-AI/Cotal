import { loadExtensionsManifest, readUpdateRecovery, recoveryDisposition, type UpdateRecovery } from "@cotal-ai/workspace";
import { readStamp } from "../seed/authority.js";
import { isValidSemver } from "../seed/paths.js";
import { compareSemver } from "../seed/reconcile.js";

const repair = "Run `cotal update --self` to reconcile this installation.";

export type UpdatePending =
  | { readonly kind: "none" }
  | { readonly kind: "receipt"; readonly recovery: UpdateRecovery; readonly instruction: string }
  | { readonly kind: "version-mismatch"; readonly extensions: readonly { readonly package: string; readonly version: string }[]; readonly instruction: string }
  | { readonly kind: "unreadable"; readonly source: "receipt" | "manifest" | "seed-store"; readonly error: string; readonly instruction: string };

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
    const extensions = loadExtensionsManifest().extensions
      .filter(entry => entry.pkg.startsWith("@cotal-ai/") && entry.version !== current)
      .map(entry => ({ package: entry.pkg, version: entry.version }));
    if (!extensions.length) return { kind: "none" };
    let generation: string | undefined;
    try {
      generation = readStamp()?.generation;
      if (generation !== undefined && !isValidSemver(generation)) throw new Error(`invalid seed store generation ${JSON.stringify(generation)}`);
    } catch (error) {
      return { kind: "unreadable", source: "seed-store", error: error instanceof Error ? error.message : String(error), instruction: "Inspect the seed store stamp and repair it with `cotal ext seed --repair`." };
    }
    const instruction = generation !== undefined && compareSemver(generation, current) > 0
      ? `Reconciliation pending: This configuration home's seed store is at ${generation}, newer than this CLI ${current}. Use a CLI at ${generation} or newer, or restore the seed store and extensions folder from a backup taken before that generation.`
      : "Reconciliation pending: Run `cotal update` to reconcile this configuration home with the installed CLI.";
    return { kind: "version-mismatch", extensions, instruction };
  } catch (error) {
    return { kind: "unreadable", source: "manifest", error: error instanceof Error ? error.message : String(error), instruction: repair };
  }
}
