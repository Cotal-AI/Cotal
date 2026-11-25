import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { trustProjectCommand } from "@cotal-ai/core";
import { canonicalRoot, trustProject } from "@cotal-ai/workspace";
import { c, stderrLine } from "../ui.js";
import { displayRemedy } from "../lib/self-exec.js";

const freshControlFolders = new AsyncLocalStorage<Set<string>>();

/** Only an ancestor of the invoking directory that had no control entry can be trusted by up.
 * An explicit `--root` requires an existing control directory and never adds a folder. */
export function withUpProjectTrust<T>(run: () => T): T {
  const fresh = new Set<string>();
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    if (!lstatSync(join(dir, ".cotal"), { throwIfNoEntry: false })) fresh.add(canonicalRoot(dir));
    if (dirname(dir) === dir) break;
  }
  return freshControlFolders.run(fresh, run);
}

/** Record trust only after a fresh local stack starts. A trust write cannot undo that start. */
export function trustFreshUpProject(root: string): void {
  if (!freshControlFolders.getStore()?.has(canonicalRoot(root))) return;
  if (!lstatSync(join(root, ".cotal"), { throwIfNoEntry: false })?.isDirectory()) return;
  try { trustProject(root); }
  catch (error) {
    stderrLine("! ", displayRemedy(`${root} was not recorded as a trusted project: ${(error as Error).message}. After fixing that, run \`${trustProjectCommand(root)}\``), c.yellow);
  }
}
