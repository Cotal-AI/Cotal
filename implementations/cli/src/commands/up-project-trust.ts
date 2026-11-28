import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { trustProjectCommand } from "@cotal-ai/core";
import { canonicalRoot, isCommandFailure, trustProject } from "@cotal-ai/workspace";
import { c, stderrLine } from "../ui.js";
import { displayRemedy } from "../lib/self-exec.js";

const freshControlFolders = new AsyncLocalStorage<Set<string>>();

/** Track control directories created by this startup and its re-entries, which share one channel file cache. */
export function withUpProjectTrust<T>(run: () => T): T {
  return freshControlFolders.run(new Set(), run);
}

export function noteUpProjectCreated(root: string): void {
  freshControlFolders.getStore()?.add(canonicalRoot(root));
}

export function createUpControlDirectory(root: string): void {
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  noteUpProjectCreated(root);
}

/** Remove the `.cotal` a failed `up` made for a fresh folder when the run wrote nothing in it. One
 *  that holds anything stays, as the run's records. */
export function removeEmptyRecords(path: string): void {
  try { rmdirSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") console.error(c.yellow(`! ${path} was left in place (${code ?? "an error"})`));
  }
}

/** Record trust only after a fresh local stack starts. A trust write cannot undo that start. */
export function trustFreshUpProject(root: string): void {
  if (!freshControlFolders.getStore()?.has(canonicalRoot(root))) return;
  recordNewProjectTrust(root);
}

export function recordNewProjectTrust(root: string): void {
  try { trustProject(root); }
  catch (error) {
    const remedy = isCommandFailure(error) && error.remedy ? ` ${error.remedy}.` : "";
    stderrLine("! ", displayRemedy(`${root} was not recorded as a trusted project: ${(error as Error).message}.${remedy} After fixing that, run \`${trustProjectCommand(root)}\``), c.yellow);
  }
}
