import { existsSync, lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { authDir, canonicalRoot, CommandFailure, findCotalRoot, homeCotalDir, localMeshesForRoot, moveRecordsBack, readMaintenanceJournal, recordsMovedTo, soleSpaceOf } from "@cotal-ai/workspace";

/** The project's `.cotal/` root, found by walking up from cwd (like git finds `.git`), so every
 *  command resolves the same `.cotal/` whether you're at the project root or a subdirectory. */
export function cotalRoot(): string {
  return findCotalRoot();
}

/** Whether the machine home already holds a stack an earlier release started there: a registration,
 *  a maintenance attempt, or a space account. Such a stack still starts, resumes and stops in place. */
export function homeHoldsStack(root: string): boolean {
  return localMeshesForRoot(root).length > 0 || readMaintenanceJournal(root) !== undefined || soleSpaceOf(authDir(root)) !== undefined;
}

/** A path inside the project's `.cotal/` directory. Use instead of `resolve(".cotal/…")` so paths
 *  don't break when `cotal` runs from a subdirectory. */
export function cotalPath(...segments: string[]): string {
  return join(cotalRoot(), ".cotal", ...segments);
}

/** Whether the working folder was removed before this process read it. Node then fails every cwd
 *  read, and caches the first read that succeeds. */
export function workingFolderRemoved(): boolean {
  try {
    process.cwd();
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return true;
  }
}

/** A folder's `.cotal` that is a link: where it is, where it leads, and whether that exists. */
export interface CotalLink { root: string; path: string; target: string; dangling: boolean }

/** A `.cotal` link that the walk {@link cotalRoot} takes from the working folder meets first: a link
 *  to another folder, or one that leads nowhere, which the walk passes over. `target` is where it
 *  leads. The machine's home `.cotal` is left to the commands that use it. Undefined when the first
 *  `.cotal` the walk meets is a real directory, or there is none. */
export function cotalLinkHere(): CotalLink | undefined {
  let dir = resolve(process.cwd());
  for (;;) {
    const link = linkAt(dir);
    if (link !== null) return link;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** {@link cotalLinkHere} for one folder, with no walk: its `.cotal` when that is a link. */
export function cotalLinkAt(root: string): CotalLink | undefined {
  return linkAt(resolve(root)) ?? undefined;
}

/** The `.cotal` link at `dir`, undefined when its `.cotal` is a directory or the home one, and null
 *  when it has no `.cotal` at all. */
function linkAt(dir: string): CotalLink | undefined | null {
  const path = join(dir, ".cotal");
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return null; }
  if (!stat.isSymbolicLink() || canonicalRoot(dir) === canonicalRoot(homedir()) || resolve(homeCotalDir()) === path) return undefined;
  const dangling = !existsSync(path);
  return { root: dir, path, target: dangling ? resolve(dir, readlinkSync(path)) : realpathSync(path), dangling };
}

/** The next step in a folder whose `.cotal` links to `target`: moving the records back when they are
 *  this folder's own ({@link recordsMovedTo}), else the project whose `.cotal` it is, when it is one,
 *  or giving this folder records of its own. */
export function linkedCotalRemedy(root: string, target: string): string {
  if (recordsMovedTo(root, dirname(target))) return moveRecordsBack(root, dirname(target));
  const prepare = `remove the link and prepare this folder with cotal space create <space> --root ${root}`;
  return basename(target) === ".cotal" ? `run commands for that project from ${dirname(target)}, or ${prepare}` : prepare;
}

/** The refusal of a command in a folder whose `.cotal` is a link ({@link cotalLinkHere}, or for a
 *  reset {@link cotalLinkAt} the root it selected). A stack runs only from a folder whose `.cotal` is
 *  its own directory, and `clean` and `reset` read and remove nothing through a link, so none of
 *  them reads or writes through it. A link that leads nowhere is not passed over either: `clean`
 *  would otherwise remove the records of a folder above it. */
export function linkedCotalRefusal(command: "up" | "down" | "clean" | "reset store" | "reset space", link: CotalLink | undefined = cotalLinkHere()): CommandFailure | undefined {
  if (link === undefined) return undefined;
  const { root, path, target } = link;
  const removes = command !== "up" && command !== "down";
  const effect = command === "up" ? "started" : command === "down" ? "stopped" : "removed";
  const failureTarget = { root, path, link: target };
  const here = command === "up" ? `remove the link and prepare this folder with cotal space create <space> --root ${root}`
    : command === "down" ? "remove the link, then run cotal down again"
    : "remove the link, then run it again where the records it should remove are";
  const why = removes ? `${command} reads and removes nothing through a link` : "a stack runs only from a folder whose .cotal is its own directory";
  if (link.dangling) return new CommandFailure("refused", "TARGET_NOT_FOUND", `${path} links to ${target}, which does not exist${removes ? `, and ${why}` : ""}; nothing was ${effect}`, { target: failureTarget, remedy: here });
  // A reset selects its root by the space's name, so running it from another folder changes nothing.
  const elsewhere = basename(target) === ".cotal" && !command.startsWith("reset") ? `run cotal ${command} from ${dirname(target)}, whose .cotal this links to, or ${here}` : here;
  return new CommandFailure("refused", "CONFLICT", `${path} is a link to ${target}, and ${why}; nothing was ${effect}`, {
    target: failureTarget,
    remedy: recordsMovedTo(root, dirname(target)) ? `${moveRecordsBack(root, dirname(target))}; then run ${removes ? "it" : `cotal ${command}`} again` : elsewhere,
  });
}
