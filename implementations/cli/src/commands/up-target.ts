import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { authDir, canonicalRoot, CommandFailure, findMesh, findPreparedSpace, homeCotalDir, listSpaceAccounts, preparedRootRemedy, preparedSpaceAt, projectRootProblem, shellPath } from "@cotal-ai/workspace";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { retainedOpenSpace } from "../lib/legacy-start.js";
import { cotalRoot } from "../lib/paths.js";
import { readStackJournal } from "../lib/stack-journal.js";
import { checkSpaceName } from "./meshes-add.js";

/** Port 0 asks the auth service to let the OS pick a free loopback port. */
export function checkPublicExchangePort(raw: string | undefined): void {
  if (raw === undefined) return;
  const port = Number(raw);
  if (!raw.trim() || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new FlagValueRefusal("--exchange-public-port must be a whole number from 0 to 65535; nothing was started or written", "pass a loopback port from 1 to 65535, or 0 to let the OS choose");
}

/** An explicit root is an existing local workspace, not a hint to find another ancestor or
 *  create trust in an arbitrary directory. Validation runs before the dispatcher seeds extensions. */
export function preparedUpRoot(value: string): string {
  if (!value) throw new CommandFailure("refused", "USAGE_INVALID", "--root needs an existing prepared project directory; an empty value is not the current folder");
  let root: string, hasControlDirectory: boolean;
  try {
    root = realpathSync(resolve(value));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    hasControlDirectory = lstatSync(join(root, ".cotal")).isDirectory();
  } catch {
    throw unavailableUpRoot(resolve(value));
  }
  if (!hasControlDirectory)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the .cotal entry in ${root} is not a project directory; nothing was started or changed`, {
      target: { root }, remedy: "use --root to name another prepared project, or restore this project's .cotal directory before retrying",
    });
  if (canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir()))
    throw new CommandFailure("refused", "CONFLICT", "--root names the machine's home store, not a prepared project; no stack was started there", { target: { root }, remedy: "prepare the space in a project folder with `cotal space create <space> --root <dir>`" });
  return root;
}

/** Preparing a path a file occupies, or one this account cannot enter, cannot succeed, so only a
 *  reachable directory with no `.cotal` of its own is told to prepare it. Nothing is changed. */
function unavailableUpRoot(requested: string): CommandFailure {
  const target = { target: { root: requested } };
  const problem = projectRootProblem(requested);
  if (problem === "not-directory") {
    let isFile = false, prepared: string | undefined;
    try { isFile = statSync(requested).isFile(); } catch { isFile = false; }
    try { prepared = preparedSpaceAt(requested)?.space; } catch { prepared = undefined; }
    const occupant = isFile ? "a file" : "something other than a directory";
    return new CommandFailure("refused", "TARGET_UNAVAILABLE", `--root ${requested} is not a directory: ${occupant} occupies the project path; nothing was started or changed`, {
      ...target,
      remedy: prepared !== undefined
        ? `move ${shellPath(requested)} aside and ${preparedRootRemedy(prepared, "not-directory")}`
        : `move ${shellPath(requested)} aside and restore the original project folder there, or pass the root of another prepared project`,
    });
  }
  if (problem === "inaccessible")
    return new CommandFailure("refused", "TARGET_UNAVAILABLE", `--root ${requested} could not be accessed by this account; nothing was started or changed`, { ...target, remedy: `restore this account's access to ${shellPath(requested)}, then try again` });
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", "--root must name an existing prepared local project with its own .cotal directory; no ancestor or other space was selected", { ...target, remedy: "prepare it with `cotal space create <space> --root <dir>`, then retry with that root" });
}

/** An invoking folder that vanished during up cannot be restored. Keep the operation's outcome. */
export function restoreUpCwd(previousCwd: string): void {
  try { process.chdir(previousCwd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
