import { realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CommandFailure, homeCotalDir, protectedLocalDirectory } from "@cotal-ai/workspace";

/** The entry at `path`, or nothing when it is missing. A path under a regular file is missing too,
 *  so the walk up reaches that file and names it. */
function statIfPresent(path: string): Stats | undefined {
  try { return statSync(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
}

/** The control directory `path` is or lies in: a root's `.cotal`, or the machine home's. */
function controlDirectory(path: string): string | undefined {
  const home = resolve(homeCotalDir());
  if (path === home || path.startsWith(`${home}${sep}`)) return home;
  const parts = path.split(sep), at = parts.indexOf(".cotal");
  return at === -1 ? undefined : parts.slice(0, at + 1).join(sep);
}

/** Check an explicit `--store-dir` before anything is written. Its nearest existing part must be a
 *  directory, so a regular file there is a usage refusal that names it, and that directory's chain
 *  is held to the project-root rule for other local writers. A non-empty directory is accepted,
 *  because it may be an existing store. A control directory, or a path in one, is refused unless it
 *  is `root`'s own default store: its files would mix with credentials and records, or with another
 *  root's store, and no reset could remove it alone. */
export function assertStoreDirArgument(value: string, root: string): void {
  const path = resolve(value);
  let existing = path, stat = statIfPresent(existing);
  while (!stat) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
    stat = statIfPresent(existing);
  }
  const physical = stat ? join(realpathSync.native(existing), relative(existing, path)) : path;
  const control = controlDirectory(path) ?? controlDirectory(physical);
  if (control !== undefined && path !== join(resolve(root), ".cotal", "nats"))
    throw new CommandFailure("refused", "USAGE_INVALID", `the --store-dir path ${path} is ${path === control ? "" : "in "}the control directory ${control}; nothing was started or written`, { target: { storeDir: path, controlDirectory: control }, remedy: "name a directory outside any .cotal with --store-dir, or omit it to use this root's .cotal/nats" });
  if (!stat) return;
  if (!stat.isDirectory())
    throw new CommandFailure("refused", "USAGE_INVALID", `${existing === path ? `the --store-dir path ${path}` : `${existing}, in the --store-dir path ${path},`} is not a directory; nothing was started or written`, { target: { storeDir: path }, remedy: "name a directory, or a path to create in one, with --store-dir" });
  protectedLocalDirectory(realpathSync.native(existing), "the --store-dir path");
}
