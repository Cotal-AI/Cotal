import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logicalExecutionEntry, extensionProvides, loadExtensionsManifest } from "@cotal-ai/workspace";
import { cliPackageRoot, cliVersion, installedCliVersion } from "../seed/paths.js";
import { isNpx } from "./self-exec.js";

/** This binary's own published version. Re-exported here so the version surfaces (`cotal version` and
 *  `cotal status`) have a single import for all version reporting. */
export { cliVersion, installedCliVersion };

export interface CliProvenance {
  kind: "source" | "installed" | "npx";
  root: string;
  npmVersion?: string;
  note?: string;
}

/** The running CLI artifact, resolved through the same package root used for its version. */
export function cliProvenance(): CliProvenance {
  const packageRoot = cliPackageRoot();
  if (isNpx()) return { kind: "npx", root: packageRoot };
  const source = basename(packageRoot) === "bin" && existsSync(join(packageRoot, "..", "implementations"));
  if (source) return { kind: "source", root: dirname(packageRoot) };
  const npmVersion = npmRecordedVersion();
  const inUse = cliVersion();
  return npmVersion && npmVersion !== inUse
    ? { kind: "installed", root: packageRoot, npmVersion, note: `npm lists ${npmVersion}; in use ${inUse}` }
    : { kind: "installed", root: packageRoot };
}

export function npmRecordedVersion(): string | undefined {
  const entry = logicalExecutionEntry();
  if (!entry) return undefined;
  const meta = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (meta.name !== "cotal-ai" || typeof meta.version !== "string") throw new Error("npm installation record is unreadable");
  return meta.version;
}

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
 *  versions, for `cotal version` and `cotal status`. Reads the on-disk manifest directly — no import, no
 *  seeding side effect. Returns `[]` on an absent or corrupt manifest: the version view stays
 *  resilient, and a corrupt manifest is surfaced loudly by the real commands (the overlay is fatal). */
export function extensionVersions(): ExtensionVersion[] {
  return readExtensionVersions().versions;
}

/** {@link extensionVersions}, with the reason when the manifest could not be read, so a structured
 *  report can say its list is incomplete rather than empty. */
export function readExtensionVersions(): { versions: ExtensionVersion[]; unreadable?: string } {
  try {
    const versions = loadExtensionsManifest().extensions.map((entry, index) => {
      if (!entry || typeof entry.pkg !== "string" || !entry.pkg || typeof entry.version !== "string" || !entry.version || !Array.isArray(entry.commands)) {
        throw new Error(`invalid extension inventory entry at index ${index}`);
      }
      const refs = extensionProvides(entry);
      if (!Array.isArray(refs) || refs.some((ref) => typeof ref?.name !== "string" || !ref.name)) {
        throw new Error(`invalid extension inventory entry at index ${index}: expected named contributions`);
      }
      return { label: [...new Set(refs.map((ref) => ref.name))].join(", ") || entry.pkg, version: entry.version, pkg: entry.pkg };
    });
    return { versions };
  } catch (e) {
    return { versions: [], unreadable: e instanceof Error ? e.message : String(e) };
  }
}
