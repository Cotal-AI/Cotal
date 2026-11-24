import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cachedUpdateSummary, logicalExecutionEntry, extensionProvides, globalConfigDirProblem, loadExtensionsManifest, UnreadableConnectorSelection, writeResult } from "@cotal-ai/workspace";
import { cliPackageRoot, cliVersion, installedCliVersion } from "../seed/paths.js";
import { isNpx } from "./self-exec.js";
import { manifestRepair, readUpdatePending } from "./update-pending.js";

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

interface ExtensionVersion {
  /** Short label — the extension's provided names (`claude`, `web`), deduped; the package name if
   *  it provides nothing named. */
  label: string;
  /** Exact installed version, pinned at add time. */
  version: string;
  /** The npm package name (what `cotal ext list` keys on). */
  pkg: string;
}

/** Read recorded version pins without loading extensions. Preserve the reason when the inventory
 *  could not be read so a report can distinguish it from an empty list. */
export function readExtensionVersions(): { versions: ExtensionVersion[]; unreadable?: string; unreadableSelection?: true } {
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
    return { versions: [], unreadable: e instanceof Error ? e.message : String(e), ...(e instanceof UnreadableConnectorSelection ? { unreadableSelection: true } : {}) };
  }
}

/** Report the same version metadata for the command and the standalone flags. */
export function writeVersion(presentation: "rich" | "json"): void {
  const { versions, unreadable, unreadableSelection } = readExtensionVersions();
  const config = unreadable === undefined ? undefined : globalConfigDirProblem();
  const version = cliVersion();
  const pending = readUpdatePending(version);
  const update = cachedUpdateSummary(version);
  const reconciliation = config && pending.kind === "unreadable" && pending.source === "manifest"
    ? { ...pending, error: config.message, instruction: config.remedy } : pending;
  // An older binary must still pass the updater's text probe when it cannot read a newer connector selection.
  const partial = unreadable !== undefined && (presentation === "json" || !unreadableSelection)
    ? { message: "the installed extensions could not be listed", remedy: config?.remedy ?? manifestRepair } : undefined;
  const result = { version, update, reconciliation, extensions: versions.map((e) => ({ package: e.pkg, version: e.version })) };
  writeResult(presentation, {
    command: "version",
    target: null,
    result,
    ...(partial && {
      completeness: "partial",
      warnings: [{ code: "EXTENSIONS_UNREADABLE", target: null, message: `the extensions manifest could not be read: ${config?.message ?? unreadable}` }],
      partial,
    }),
  }, ({ version, update, reconciliation }) => ({
    sections: [{ blocks: [{ kind: "lines", lines: versionLines(
      version, update, reconciliation.kind === "none" ? undefined : reconciliation.instruction, versions, partial?.remedy,
    ) }] }],
  }));
}

function versionLines(version: string, update: string, instruction: string | undefined, exts: ExtensionVersion[], remedy: string | undefined): string[] {
  const lines = [`cotal-ai ${version}`];
  if (instruction && instruction !== remedy) lines.push(`  ${instruction}`);
  if (update !== "update status unknown" && update !== "up to date" && update !== instruction) lines.push(`  ${update}`);
  if (exts.length) {
    const pad = Math.max(...exts.map((e) => e.label.length));
    for (const e of exts) lines.push(`  ${e.label.padEnd(pad)}  ${e.version}`);
  }
  return lines;
}
