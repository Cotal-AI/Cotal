import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
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
