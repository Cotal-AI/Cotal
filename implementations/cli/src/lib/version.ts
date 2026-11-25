import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cachedUpdateSummary, CorruptExtensionsManifestError, directoryReadProblem, EXTENSION_PROMOTION_JOURNAL, extensionProvides, extensionsManifestPath, globalConfigDirProblem, hasExtensionPromotionJournal, isCommandFailure, loadExtensionsManifest, logicalExecutionEntry, UnreadableConnectorSelection, writeResult } from "@cotal-ai/workspace";
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
export function readExtensionVersions(path?: string): { versions: ExtensionVersion[]; unreadable?: string; unreadableSelection?: true; diagnosis?: string } {
  try {
    const versions = loadExtensionsManifest(path).extensions.map((entry, index) => {
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

function versionMetadata(inventory?: readonly ExtensionVersion[] | null) {
  const current = cliVersion();
  return { current, update: cachedUpdateSummary(current), pending: readUpdatePending(current, inventory) };
}

/** Print a bare version listing for consumers that supply their own inventory. */
export function printVersion(exts = extensionVersions()): void {
  const { current, update, pending } = versionMetadata();
  console.log(versionLines(current, update, pending.kind === "none" ? undefined : pending.instruction, exts).join("\n"));
}

interface VersionInventoryProblem {
  readonly source: "config" | "selection" | "promotion" | "prefix" | "manifest";
  readonly error: string;
  readonly diagnosis?: string;
  readonly instruction?: string;
  readonly unreadableSelection?: true;
  readonly probeCanProceed?: true;
}

type VersionInventory = { versions: ExtensionVersion[]; problem?: VersionInventoryProblem };

function manifestInventory(manifest: string): VersionInventory {
  const { versions, unreadable, diagnosis } = readExtensionVersions(manifest);
  return unreadable === undefined ? { versions } : { versions, problem: { source: "manifest", error: unreadable, diagnosis, instruction: manifestRepair } };
}

function versionInventory(identityProbe: boolean): VersionInventory {
  const config = globalConfigDirProblem();
  if (config) return { versions: [], problem: { source: "config", error: config.message, instruction: config.remedy,
    ...(config.blockedByFile ? { probeCanProceed: true } : {}) } };
  let manifest: string;
  try { manifest = extensionsManifestPath(); }
  catch (error) {
    return { versions: [], problem: { source: "selection", error: error instanceof Error ? error.message : String(error),
      ...(error instanceof UnreadableConnectorSelection ? { unreadableSelection: true, instruction: "Run `cotal ext seed --repair` to repair the connectors." } :
        isCommandFailure(error) ? { instruction: error.remedy } : {}) } };
  }
  const prefix = dirname(manifest);
  const blocked = directoryReadProblem(prefix);
  if (blocked) return { versions: [], problem: { source: "prefix", error: blocked.message, instruction: blocked.remedy } };
  const journal = join(dirname(prefix), EXTENSION_PROMOTION_JOURNAL);
  const prefixIdentity = () => {
    const stat = lstatSync(prefix, { throwIfNoEntry: false, bigint: true });
    return stat && `${stat.dev}:${stat.ino}`;
  };
  const promotion = () => hasExtensionPromotionJournal(journal);
  try {
    const before = prefixIdentity();
    const beforePromotion = promotion();
    const inventory = !beforePromotion || identityProbe ? manifestInventory(manifest) : undefined;
    if (identityProbe && inventory?.problem) return inventory;
    if (!inventory || beforePromotion || promotion() || before !== prefixIdentity()) {
      return { versions: [], problem: { source: "promotion", error: `extension promotion is unfinished or changed during the inventory read (${journal})`,
        instruction: "Run `cotal ext list` with the installation that owns this inventory to check whether recovery can finish.", probeCanProceed: true } };
    }
    return inventory;
  } catch (error) {
    const config = globalConfigDirProblem();
    if (config) return { versions: [], problem: { source: "config", error: config.message, instruction: config.remedy } };
    const prefixProblem = directoryReadProblem(prefix);
    if (prefixProblem) return { versions: [], problem: { source: "prefix", error: prefixProblem.message, instruction: prefixProblem.remedy } };
    return { versions: [], problem: { source: "promotion", error: error instanceof Error ? error.message : String(error),
      instruction: `inspect the extension promotion journal at ${journal} before retrying` } };
  }
}

/** Report the running version even when the extension inventory cannot be read. */
export function reportVersion(format: "plain" | "json", { identityProbe = false } = {}): void {
  const { versions, problem } = versionInventory(identityProbe);
  // A verified executable can leave config setup or promotion recovery to the next command.
  if (identityProbe && problem?.probeCanProceed) {
    console.log(`cotal-ai ${cliVersion()}`);
    return;
  }
  const { current, update, pending } = versionMetadata(problem ? null : versions);
  const reconciliation = problem && pending.kind === "none"
    ? { kind: "unreadable" as const, source: problem.source, error: problem.error, ...(problem.instruction && { instruction: problem.instruction }) } : pending;
  // The updater's text probe must succeed with an unrecognized connector selection.
  const partial = problem && !(format === "plain" && problem.unreadableSelection) ? problem : undefined;
  const instruction = pending.kind !== "none" ? pending.instruction : partial ? undefined : problem?.instruction;
  const subject = partial?.source === "manifest" ? "the extensions manifest" : "the extension inventory";
  const detail = format === "plain" ? partial?.diagnosis ?? partial?.error : partial?.error;
  writeResult(format, {
    command: "version",
    target: null,
    result: { version: current, update, reconciliation, extensions: versions.map((e) => ({ package: e.pkg, version: e.version })) },
    ...(partial ? {
      completeness: "partial",
      warnings: [{ code: "EXTENSIONS_UNREADABLE", target: null, message: `${subject} could not be read: ${detail}` }],
      partial: { message: "the installed extensions could not be listed", remedy: partial.instruction },
    } : {}),
  }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: versionLines(current, update, instruction, versions) }] }] }));
}
