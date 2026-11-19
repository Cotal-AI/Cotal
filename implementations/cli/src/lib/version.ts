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

/** Read pinned versions from the manifest without importing or seeding extensions. */
export function extensionVersions(): ExtensionVersion[] {
  return loadExtensionsManifest().extensions.map((e, index) => {
    if (!e || typeof e.pkg !== "string" || !e.pkg || typeof e.version !== "string" || !e.version) {
      throw new Error(`invalid extension version entry at index ${index}`);
    }
    return {
      label: [...new Set(extensionProvides(e).map((ref) => ref.name))].join(", ") || e.pkg,
      version: e.version,
      pkg: e.pkg,
    };
  });
}

/** {@link extensionVersions}, with the reason when the manifest could not be read, so a structured
 *  report can say its list is incomplete rather than empty. */
export function readExtensionVersions(): { versions: ExtensionVersion[]; unreadable?: string } {
  try {
    return { versions: extensionVersions() };
  } catch (e) {
    return { versions: [], unreadable: e instanceof Error ? e.message : String(e) };
  }
}
