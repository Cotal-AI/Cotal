import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { loadExtensionsManifest, prepareConnectorConfigForUpdate, protectedLocalDirectory, repairConnectorSelection, type UnreadableConnectorSelection } from "@cotal-ai/workspace";
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

export function prepareUpdateConnectorConfig(staged: boolean, onChange?: () => void, onModeChange?: () => void): boolean {
  if (staged) prepareConnectorConfigForUpdate(onChange, onModeChange);
  const recovered = recoverExtensionPromotion(staged, onChange);
  if (recovered && staged) prepareConnectorConfigForUpdate(onChange, onModeChange);
  if (!recovered) reclaimAbandonedExtensionStages();
  return recovered;
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
