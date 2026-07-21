import { extensionProvides, loadExtensionsManifest, type InstalledExtension } from "@cotal-ai/workspace";

/** This binary's own published version. Re-exported here so the version surfaces (`cotal -v` and
 *  `cotal status`) have a single import for all version reporting. */
export { cliVersion } from "../seed/paths.js";

export interface ExtensionVersion {
  /** Short label — the extension's provided names (`claude`, `web`), deduped; the package name if
   *  it provides nothing named. */
  label: string;
  /** Exact installed version, pinned at add time. */
  version: string;
  /** The npm package name (what `cotal ext list` keys on). */
  pkg: string;
}

/** Installed extensions (seeded built-in connectors + operator `ext add`s) with their pinned
 *  versions, for `cotal -v` and `cotal status`. Reads the on-disk manifest directly — no import, no
 *  seeding side effect. Returns `[]` on an absent or corrupt manifest: the version view stays
 *  resilient, and a corrupt manifest is surfaced loudly by the real commands (the overlay is fatal). */
export function extensionVersions(): ExtensionVersion[] {
  let extensions: readonly InstalledExtension[];
  try {
    extensions = loadExtensionsManifest().extensions;
  } catch {
    return [];
  }
  return extensions.map((e) => ({
    label: [...new Set(extensionProvides(e).map((ref) => ref.name))].join(", ") || e.pkg,
    version: e.version,
    pkg: e.pkg,
  }));
}
