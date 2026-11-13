import { loadExtensionsManifest, readUpdateRecovery, type UpdateRecovery } from "@cotal-ai/workspace";

const repair = "Run `cotal update --self` to reconcile this installation.";

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
    return { kind: "unreadable", source: "receipt", error: error instanceof Error ? error.message : String(error), instruction: repair };
  }
  if (recovery) return { kind: "receipt", recovery, instruction: repair };
  try {
    const extensions = loadExtensionsManifest().extensions
      .filter(entry => entry.pkg.startsWith("@cotal-ai/") && entry.version !== current)
      .map(entry => ({ package: entry.pkg, version: entry.version }));
    return extensions.length ? { kind: "version-mismatch", extensions, instruction: repair } : { kind: "none" };
  } catch (error) {
    return { kind: "unreadable", source: "manifest", error: error instanceof Error ? error.message : String(error), instruction: repair };
  }
}
