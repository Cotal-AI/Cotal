import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { CommandFailure, connectorConfigDir, homeCotalDir, isCommandFailure, loadExtensionsManifest, prepareConnectorConfigForUpdate, protectedLocalDirectory, repairConnectorSelection, restoreConnectorManifestAccessForUpdate, type UnreadableConnectorSelection } from "@cotal-ai/workspace";
import { reclaimAbandonedExtensionStages, recoverExtensionPromotion } from "./extension-stage.js";

/** First-use setup is pending only when there is no sign of earlier connector setup. */
export function connectorBootstrapPending(): boolean {
  try {
    const absent = (root: string, names: string[]): boolean => names.every(name => !lstatSync(join(root, name), { throwIfNoEntry: false }));
    const global = globalConfigDir();
    for (const config of new Set([connectorConfigDir(), global])) {
      if (!absent(config, ["seed", "extensions", ".extensions.lock", ".extensions-promotion.json"])) return false;
    }
    if (!absent(homeCotalDir(), ["claude-plugin", "codex-plugin"])) return false;
    const installs = join(global, "installs");
    const directory = lstatSync(installs, { throwIfNoEntry: false });
    return !directory || directory.isDirectory() && !readdirSync(installs).some(name => /^[a-f0-9]{64}$/.test(name));
  } catch { return false; }
}

/** Check the closest existing ancestor outside the Cotal folder, whose modes update does not repair. */
export function assertConfigAncestorProtected(): void {
  let path = globalConfigDir();
  if (existsSync(path)) path = dirname(path);
  while (!existsSync(path)) {
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
  // Owned private configuration reached through a symlink is supported.
  try { path = realpathSync(path); } catch { /* Check the existing path below. */ }
  if (!statSync(path).isDirectory()) return;
  protectedLocalDirectory(path, "the Cotal config folder");
}

export function manifestAccessReporter(report: (line: string) => void): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    report("Restored owner access to the extensions manifest.");
  };
}

export function prepareUpdateConnectorConfig(staged: boolean, onChange?: () => void, onModeChange?: () => void, reportManifestAccess?: () => void): boolean {
  const prepare = (): void => {
    if (reportManifestAccess && restoreConnectorManifestAccessForUpdate(true)) reportManifestAccess();
    prepareConnectorConfigForUpdate(onChange, onModeChange);
  };
  if (staged) prepare();
  const recovered = recoverExtensionPromotion(staged, onChange);
  if (recovered && staged) prepare();
  if (!recovered) reclaimAbandonedExtensionStages();
  return recovered;
}

export function connectorConfigPreflightFailure(error: unknown, changed: boolean): CommandFailure {
  if (isCommandFailure(error)) {
    if (!changed || error.native?.outcome !== "not-executed") return error;
    const { outcome: _, ...rest } = error.native;
    return new CommandFailure(error.outcome, error.code, error.message, {
      remedy: error.remedy, native: Object.keys(rest).length ? rest : undefined,
      target: error.target, changed: error.changed, cause: error.cause,
      selfContained: error.selfContained, given: error.given, remedyIsCommand: error.remedyIsCommand,
    });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new CommandFailure("refused", "PERMISSION_DENIED", `Cannot prepare the Cotal connector configuration: ${detail}. No CLI update was staged.`, {
    ...(changed ? {} : { native: { outcome: "not-executed" } }),
    remedy: "Correct the reported connector configuration problem, then run `cotal update --self` again.",
  });
}

/** Validate the inventory after recovery because built-in self-update skips the extension overlay. */
export function restoreUpdateManifestAccess(staged: boolean, report: () => void): void {
  try { loadExtensionsManifest(); }
  catch (error) {
    const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
    if (!staged || !isCommandFailure(error) || error.code !== "PERMISSION_DENIED" ||
        cause?.syscall !== "open" || !restoreConnectorManifestAccessForUpdate(false)) throw error;
    report();
    loadExtensionsManifest();
  }
}

/** Repair the selection before the updater checks installed extension dependencies. */
export function repairUpdateConnectorSelection(staged: boolean, report: (line: string) => void, onModeChange?: () => void): boolean {
  const setAside = repairConnectorSelection();
  if (!setAside.length) return false;
  report(`Set aside unreadable connector selection: ${setAside.map(path => JSON.stringify(path)).join(", ")}`);
  prepareUpdateConnectorConfig(staged, undefined, onModeChange);
  return true;
}

export function repairCurrentUpdateConnectorSelection(staged: boolean, refusal: UnreadableConnectorSelection, report: (line: string) => void, onModeChange?: () => void): boolean {
  try {
    repairUpdateConnectorSelection(staged, report, onModeChange);
    loadExtensionsManifest();
    return true;
  } catch (error) {
    report(refusal.message);
    const detail = error instanceof Error ? error.message : String(error);
    if (detail !== refusal.message) report(detail);
    return false;
  }
}
