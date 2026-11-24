import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cachedUpdateSummary, CorruptExtensionsManifestError, extensionProvides, globalConfigDirProblem, loadExtensionsManifest, logicalExecutionEntry, UnreadableConnectorSelection, writeResult } from "@cotal-ai/workspace";
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

export interface ExtensionVersion {
  /** Short label — the extension's provided names (`claude`, `web`), deduped; the package name if
   *  it provides nothing named. */
  label: string;
  /** Exact installed version, pinned at add time. */
  version: string;
  /** The npm package name (what `cotal ext list` keys on). */
  pkg: string;
}

/** Installed extension pins, without loading or reconciling them. */
export function extensionVersions(): ExtensionVersion[] {
  return readExtensionVersions().versions;
}

/** Read the pinned versions without loading or reconciling any extension. */
export function readExtensionVersions(): { versions: ExtensionVersion[]; unreadable?: string; unreadableSelection?: true; diagnosis?: string } {
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
  } catch (error) {
    return {
      versions: [], unreadable: error instanceof Error ? error.message : String(error),
      ...(error instanceof UnreadableConnectorSelection ? { unreadableSelection: true } : {}),
      ...(error instanceof CorruptExtensionsManifestError ? { diagnosis: error.diagnosis } : {}),
    };
  }
}

function versionLines(current: string, update: string, instruction: string | undefined, exts: readonly ExtensionVersion[]): string[] {
  const lines = [`cotal-ai ${current}`];
  if (instruction) lines.push(`  ${instruction}`);
  if (update !== "update status unknown" && update !== "up to date" && update !== instruction) lines.push(`  ${update}`);
  if (exts.length) {
    const pad = Math.max(...exts.map((e) => e.label.length));
    for (const e of exts) lines.push(`  ${e.label.padEnd(pad)}  ${e.version}`);
  }
  return lines;
}

function versionMetadata() {
  const current = cliVersion();
  return { current, update: cachedUpdateSummary(current), pending: readUpdatePending(current) };
}

/** Print a bare version listing for consumers that supply their own inventory. */
export function printVersion(exts = extensionVersions()): void {
  const { current, update, pending } = versionMetadata();
  console.log(versionLines(current, update, pending.kind === "none" ? undefined : pending.instruction, exts).join("\n"));
}

/** Report the running version even when the extension inventory cannot be read. */
export function reportVersion(format: "plain" | "json"): void {
  const { versions, unreadable, unreadableSelection, diagnosis } = readExtensionVersions();
  const config = unreadable === undefined ? undefined : globalConfigDirProblem();
  const { current, update, pending } = versionMetadata();
  const reconciliation = config && pending.kind === "unreadable" && pending.source === "manifest"
    ? { ...pending, error: config.message, instruction: config.remedy } : pending;
  // The updater's text probe must succeed with an unrecognized connector selection.
  const detail = format === "plain" ? diagnosis ?? unreadable : unreadable;
  const reason = format === "plain" && unreadableSelection ? undefined : config?.message ?? detail;
  const remedy = config?.remedy ?? manifestRepair;
  const instruction = reconciliation.kind === "none" ? undefined : reconciliation.instruction;
  writeResult(format, {
    command: "version",
    target: null,
    result: { version: current, update, reconciliation, extensions: versions.map((e) => ({ package: e.pkg, version: e.version })) },
    ...(reason === undefined ? {} : {
      completeness: "partial",
      warnings: [{ code: "EXTENSIONS_UNREADABLE", target: null, message: `the extensions manifest could not be read: ${reason}` }],
      partial: { message: "the installed extensions could not be listed", remedy },
    }),
  }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: versionLines(current, update, reason !== undefined && instruction === remedy ? undefined : instruction, versions) }] }] }));
}
