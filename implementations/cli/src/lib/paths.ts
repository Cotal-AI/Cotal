import { existsSync, lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalRoot, CommandFailure, findCotalRoot, homeCotalDir } from "@cotal-ai/workspace";

/** The project's `.cotal/` root, found by walking up from cwd (like git finds `.git`), so every
 *  command resolves the same `.cotal/` whether you're at the project root or a subdirectory. */
export function cotalRoot(): string {
  return findCotalRoot();
}

/** A path inside the project's `.cotal/` directory. Use instead of `resolve(".cotal/…")` so paths
 *  don't break when `cotal` runs from a subdirectory. */
export function cotalPath(...segments: string[]): string {
  return join(cotalRoot(), ".cotal", ...segments);
}

/** A `.cotal` link that the walk {@link cotalRoot} takes from the working folder meets first: a link
 *  to another folder, or one that leads nowhere, which the walk passes over. `target` is where it
 *  leads. The machine's home `.cotal` is left to the commands that use it. Undefined when the first
 *  `.cotal` the walk meets is a real directory, or there is none. */
export function cotalLinkHere(): { root: string; path: string; target: string; dangling: boolean } | undefined {
  let dir = resolve(process.cwd());
  for (;;) {
    const path = join(dir, ".cotal");
    let stat: Stats | undefined;
    try { stat = lstatSync(path); } catch { stat = undefined; }
    if (stat !== undefined) {
      if (!stat.isSymbolicLink() || canonicalRoot(dir) === canonicalRoot(homedir()) || resolve(homeCotalDir()) === path) return undefined;
      const dangling = !existsSync(path);
      return { root: dir, path, target: dangling ? resolve(dir, readlinkSync(path)) : realpathSync(path), dangling };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The next step in a folder whose `.cotal` links to `target`: the project whose `.cotal` it is, when
 *  it is one, or giving this folder records of its own. */
export function linkedCotalRemedy(root: string, target: string): string {
  const prepare = `remove the link and prepare this folder with cotal space create <space> --root ${root}`;
  return basename(target) === ".cotal" ? `run commands for that project from ${dirname(target)}, or ${prepare}` : prepare;
}

/** The refusal of `up` or `down` in a folder whose `.cotal` is a link ({@link cotalLinkHere}). A stack
 *  runs only from a folder whose `.cotal` is its own directory, so neither reads or writes through it. */
export function linkedCotalRefusal(command: "up" | "down"): CommandFailure | undefined {
  const link = cotalLinkHere();
  if (link === undefined) return undefined;
  const { root, path, target } = link;
  const effect = command === "up" ? "started" : "stopped";
  const failureTarget = { root, path, link: target };
  const here = command === "up" ? `remove the link and prepare this folder with cotal space create <space> --root ${root}` : "remove the link, then run cotal down again";
  if (link.dangling) return new CommandFailure("refused", "TARGET_NOT_FOUND", `${path} links to ${target}, which does not exist; nothing was ${effect}`, { target: failureTarget, remedy: here });
  return new CommandFailure("refused", "CONFLICT", `${path} is a link to ${target}, and a stack runs only from a folder whose .cotal is its own directory; nothing was ${effect}`, {
    target: failureTarget,
    remedy: basename(target) === ".cotal" ? `run cotal ${command} from ${dirname(target)}, whose .cotal this links to, or ${here}` : here,
  });
}
