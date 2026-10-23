import { statSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";

/** The entry at `path`, or nothing when it is missing. A path under a regular file is missing too,
 *  so the walk up reaches that file and names it. */
function statIfPresent(path: string): Stats | undefined {
  try { return statSync(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
}

/** Check an explicit `--store-dir` before anything is written. Its nearest existing part must be a
 *  directory, so a regular file there is a usage refusal that names it. A non-empty directory is
 *  accepted, because it may be an existing store. */
export function assertStoreDirArgument(value: string): void {
  const path = resolve(value);
  let existing = path, stat = statIfPresent(existing);
  while (!stat) {
    const parent = dirname(existing);
    if (parent === existing) return;
    existing = parent;
    stat = statIfPresent(existing);
  }
  if (!stat.isDirectory())
    throw new CommandFailure("refused", "USAGE_INVALID", `${existing === path ? `the --store-dir path ${path}` : `${existing}, in the --store-dir path ${path},`} is not a directory; nothing was started or written`, { target: { storeDir: path }, remedy: "name a directory, or a path to create in one, with --store-dir" });
}
