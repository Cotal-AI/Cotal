import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { authDir, canonicalRoot, CommandFailure, findMesh, findPreparedSpace, homeCotalDir, isMeshRegistryError, listSpaceAccounts, loadPreparedSpaces, oneLine, preparedRootRemedy, projectRootProblem, projectRootProblemText, type NativeCause, type ProjectRootProblem } from "@cotal-ai/workspace";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { retainedOpenSpace } from "../lib/legacy-start.js";
import { cotalRoot } from "../lib/paths.js";
import { registryFailure } from "../lib/registry-errors.js";
import { readStackJournal } from "../lib/stack-journal.js";
import { checkSpaceName } from "./meshes-add.js";

const prepareRoot = "prepare it with `cotal space create <space> --root <dir>`, then retry with that root";

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
  const requested = resolve(value);
  const problem = explicitRootProblem(requested);
  if (problem !== undefined) throw unusableUpRoot(requested, problem);
  let root: string;
  try {
    root = realpathSync(requested);
    const cotal = lstatSync(join(root, ".cotal"));
    if (!cotal.isDirectory() || cotal.isSymbolicLink()) throw new Error("not a private project directory");
  } catch {
    throw unavailableUpRoot(requested, "--root must name an existing prepared local project with its own .cotal directory", prepareRoot);
  }
  if (canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir()))
    throw new CommandFailure("refused", "CONFLICT", "--root names the machine's home store, not a prepared project; no stack was started there", { target: { root }, remedy: "prepare the space in a project folder with `cotal space create <space> --root <dir>`" });
  return root;
}

function unavailableUpRoot(root: string, message: string, remedy: string, native?: NativeCause): CommandFailure {
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", `${message}; no ancestor or other space was selected`, { target: { root }, remedy, native });
}

function explicitRootProblem(root: string): ProjectRootProblem | "dangling-link" | undefined {
  const problem = projectRootProblem(root);
  if (problem !== "missing") return problem;
  try { return lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink() ? "dangling-link" : problem; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "not-directory" : "inaccessible"; }
}

// Resolve parent aliases without following a replacement link at the recorded entry itself.
const rootEntry = (root: string) => join(canonicalRoot(dirname(root)), basename(root));

function unusableUpRoot(root: string, problem: ProjectRootProblem | "dangling-link"): CommandFailure {
  const shown = `--root ${oneLine(root)}`;
  if (problem === "inaccessible")
    return unavailableUpRoot(root, `${shown} ${projectRootProblemText(problem)}`, "restore access to the directory, then try again");
  const reported = problem === "dangling-link" ? "is a dangling symbolic link" : projectRootProblemText(problem);
  const message = `${shown} ${problem === "missing" ? "does not exist" : reported}`;
  const entry = rootEntry(root);
  let matches;
  try { matches = loadPreparedSpaces().filter((space) => rootEntry(resolve(space.root)) === entry); }
  catch (error) {
    if (!isMeshRegistryError(error)) throw error;
    const registry = registryFailure(error);
    const step = problem === "missing" ? "restore the folder if this is its recorded path" : "if this is the recorded project path, move the obstructing entry aside and restore the original project folder";
    return unavailableUpRoot(root, message, step, { code: registry.code, detail: oneLine([registry.message, registry.remedy].filter(Boolean).join(". ")) });
  }
  if (matches.length === 0)
    return unavailableUpRoot(root, message, problem === "missing" ? prepareRoot : "pass the path to an existing prepared project directory");
  if (matches.length > 1)
    return unavailableUpRoot(root, message, "use `cotal space` to check which preparations record this project path before making changes");
  const restore = problem === "missing" ? "restore the original project folder at its recorded path, or " : "move the obstructing entry aside and ";
  const remedy = preparedRootRemedy(matches[0]!.space, problem === "missing" ? "missing" : "not-directory");
  return unavailableUpRoot(root, `${shown} ${reported}`, `${restore}${remedy}, using a different directory for <dir>`);
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
