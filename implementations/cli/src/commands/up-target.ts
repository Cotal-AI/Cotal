import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { authDir, canonicalRoot, CommandFailure, findMesh, findPreparedSpace, homeCotalDir, listSpaceAccounts } from "@cotal-ai/workspace";
import { retainedOpenSpace } from "../lib/legacy-start.js";
import { cotalRoot } from "../lib/paths.js";
import { readStackJournal } from "../lib/stack-journal.js";
import { checkSpaceName } from "./meshes-add.js";

/** An explicit root is an existing local workspace, not a hint to find another ancestor or
 *  create trust in an arbitrary directory. Validation runs before the dispatcher seeds extensions. */
export function preparedUpRoot(value: string): string {
  if (!value) throw new CommandFailure("refused", "USAGE_INVALID", "--root needs an existing prepared project directory; an empty value is not the current folder");
  let root: string;
  try {
    root = realpathSync(resolve(value));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    const cotal = lstatSync(join(root, ".cotal"));
    if (!cotal.isDirectory() || cotal.isSymbolicLink()) throw new Error("not a private project directory");
  } catch {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "--root must name an existing prepared local project with its own .cotal directory; no ancestor or other space was selected", { target: { root: resolve(value) }, remedy: "prepare it with `cotal space create <space> --root <dir>`, then retry with that root" });
  }
  if (canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir()))
    throw new CommandFailure("refused", "CONFLICT", "--root names the machine's home store, not a prepared project; no stack was started there", { target: { root }, remedy: "prepare the space in a project folder with `cotal space create <space> --root <dir>`" });
  return root;
}

/** Only new spaces need the creation grammar. A stopped legacy stack may have lost its
 *  registration while its own journal, broker configuration or account still names it. */
export function checkNewUpSpace(space: unknown, root: string | undefined): void {
  if (typeof space !== "string") return;
  const named = checkSpaceName(space);
  const resolvedRoot = root ?? cotalRoot();
  if (!named.ok && !findMesh(space) && !findPreparedSpace(space) &&
      readStackJournal(resolvedRoot)?.journal.space !== space && retainedOpenSpace(resolvedRoot) !== space &&
      !listSpaceAccounts(authDir(resolvedRoot)).includes(space))
    throw new CommandFailure("refused", "USAGE_INVALID", `${named.message.replace(/^✗ /, "")}; nothing was started or written`, { remedy: named.remedy });
}
