import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { isCommandFailure, loadExtensionsManifest, prepareConnectorConfigForUpdate, protectedLocalDirectory, repairConnectorSelection, restoreConnectorManifestAccessForUpdate, type UnreadableConnectorSelection } from "@cotal-ai/workspace";
import { reclaimAbandonedExtensionStages, recoverExtensionPromotion } from "./extension-stage.js";

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
export function repairUpdateConnectorSelection(staged: boolean, report: (line: string) => void): boolean {
  const setAside = repairConnectorSelection();
  if (!setAside.length) return false;
  report(`Set aside unreadable connector selection: ${setAside.map(path => JSON.stringify(path)).join(", ")}`);
  prepareUpdateConnectorConfig(staged);
  return true;
}

export function repairCurrentUpdateConnectorSelection(staged: boolean, refusal: UnreadableConnectorSelection, report: (line: string) => void): boolean {
  try {
    repairUpdateConnectorSelection(staged, report);
    loadExtensionsManifest();
    return true;
  } catch (error) {
    report(refusal.message);
    const detail = error instanceof Error ? error.message : String(error);
    if (detail !== refusal.message) report(detail);
    return false;
  }
}
