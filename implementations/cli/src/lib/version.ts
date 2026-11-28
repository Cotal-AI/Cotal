import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { c, cachedUpdateSummary, CorruptExtensionsManifestError, exitCode, isCommandFailure, logicalExecutionEntry, extensionProvides, loadExtensionsManifest, stderrLine, UnreadableConnectorSelection } from "@cotal-ai/workspace";
import { cliPackageRoot, cliVersion, extensionsInventoryMissing, installedCliVersion } from "../seed/paths.js";
import { isNpx } from "./self-exec.js";
import { readUpdatePending, manifestRepair } from "./update-pending.js";

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

/** {@link extensionVersions}, with the reason when the manifest could not be read, so a version
 *  report can say its list is incomplete rather than empty. */
export function readExtensionVersions(): { versions: ExtensionVersion[]; unreadable?: string; unreadableSelection?: true; remedy?: string } {
  try {
    if (extensionsInventoryMissing()) return { versions: [], unreadable: "the extensions inventory is missing", remedy: manifestRepair };
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
    return { versions: [], unreadable: e instanceof CorruptExtensionsManifestError ? e.diagnosis : e instanceof Error ? e.message : String(e), remedy: e instanceof CorruptExtensionsManifestError ? e.remedy : isCommandFailure(e) ? e.remedy : undefined, ...(e instanceof UnreadableConnectorSelection ? { unreadableSelection: true } : {}) };
  }
}

/** Print the same metadata for the version command and the standalone flags. */
export function printVersion(exts?: ExtensionVersion[]): void {
  const { versions, unreadable, unreadableSelection } = exts === undefined ? readExtensionVersions() : { versions: exts };
  const current = cliVersion();
  const update = cachedUpdateSummary(current);
  const pending = readUpdatePending(current);
  const lines = [`cotal-ai ${current}`, ...(pending.kind === "none" ? [] : [`  ${pending.instruction}`]), ...(update === "update status unknown" || update === "up to date" || (pending.kind !== "none" && update === pending.instruction) ? [] : [`  ${update}`])];
  if (versions.length) {
    const pad = Math.max(...versions.map((e) => e.label.length));
    for (const e of versions) lines.push(`  ${e.label.padEnd(pad)}  ${e.version}`);
  }
  console.log(lines.join("\n"));
  if (unreadable !== undefined && !unreadableSelection) {
    stderrLine("✗ ", unreadable, c.red);
    process.exitCode = exitCode("partial", "OPERATION_PARTIAL");
  }
}
