import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { authDir, canonicalRoot, CommandFailure, findMesh, findPreparedSpace, homeCotalDir, isMeshRegistryError, listSpaceAccounts, oneLine, preparedRootRemedy, projectRootProblem, projectRootProblemText, readPreparedSpaces, type NativeCause, type ProjectRootProblem } from "@cotal-ai/workspace";
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
  let root: string;
  try { root = realpathSync.native(requested); }
  catch (error) { throw unusableUpRoot(requested, unresolvedRootProblem(requested, error)); }
  const problem = projectRootProblem(root);
  if (problem !== undefined) throw unusableUpRoot(requested, problem);
  try {
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

type ExplicitRootProblem = ProjectRootProblem | "dangling-link" | "looping-link" | "parent-link-loop";

function unresolvedRootProblem(root: string, error: unknown): ExplicitRootProblem {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOTDIR") return "not-directory";
  if (code !== "ENOENT" && code !== "ELOOP") return "inaccessible";
  try {
    const link = lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink();
    if (code === "ELOOP") return link ? "looping-link" : "parent-link-loop";
    return link ? "dangling-link" : "missing";
  } catch (entryError) {
    const entryCode = (entryError as NodeJS.ErrnoException).code;
    if (entryCode === "ELOOP") return "parent-link-loop";
    return entryCode === "ENOTDIR" ? "not-directory" : "inaccessible";
  }
}

/** Match the requested entry through its nearest resolvable parent, without following the final link. */
function rootEntry(root: string): string | undefined {
  let parent = dirname(root), suffix = basename(root);
  for (;;) {
    try { return join(realpathSync.native(parent), suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code, above = dirname(parent);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || above === parent) return undefined;
      suffix = join(basename(parent), suffix);
      parent = above;
    }
  }
}

function unusableUpRoot(root: string, problem: ExplicitRootProblem): CommandFailure {
  const shown = `--root ${oneLine(root)}`;
  if (problem === "inaccessible")
    return unavailableUpRoot(root, `${shown} ${projectRootProblemText(problem)}`, "restore access to the directory, then try again");
  if (problem === "parent-link-loop")
    return unavailableUpRoot(root, `${shown} passes through a symbolic link loop`, "repair the symbolic link loop above the requested path, then try again");
  const reported = problem === "dangling-link" ? "is a dangling symbolic link" : problem === "looping-link"
    ? "is a symbolic link that leads to a loop" : projectRootProblemText(problem);
  const message = `${shown} ${problem === "missing" ? "does not exist" : reported}`;
  const { matches, cause } = upRootPreparations(root);
  if (cause) {
    const step = problem === "missing" ? "restore the folder if this is its recorded path" : "if this is the recorded project path, move the obstructing entry aside and restore the original project folder";
    return unavailableUpRoot(root, message, step, cause);
  }
  if (matches.length === 0)
    return unavailableUpRoot(root, message, problem === "missing" ? prepareRoot : "pass the path to an existing prepared project directory");
  if (matches.length > 1)
    return unavailableUpRoot(root, message, "use `cotal space` to check which preparations record this project path before making changes");
  const restore = problem === "missing" ? "restore the original project folder at its recorded path, or " : "move the obstructing entry aside and ";
  const remedy = preparedRootRemedy(matches[0]!.space, problem === "missing" ? "missing" : "not-directory");
  return unavailableUpRoot(root, `${shown} ${reported}`, `${restore}${remedy}, using a different directory for <dir>`);
}

function upRootPreparations(root: string) {
  try {
    const { spaces, unusable } = readPreparedSpaces();
    const first = unusable[0];
    if (first !== undefined) {
      const more = unusable.length > 1 ? ` and ${unusable.length - 1} more` : "";
      const code = unusable.every((error) => error.refusal === "PERMISSION_DENIED") ? "PERMISSION_DENIED" : "SCHEMA_INVALID";
      const cause: NativeCause = { code, detail: `preparation lookup is incomplete: could not use ${oneLine(first.file)}${more}. Check \`cotal space\` for details before preparing again` };
      return { matches: [], cause };
    }
    const entry = rootEntry(root);
    const matches = spaces.filter((space) => {
      const recorded = resolve(space.root);
      return recorded === root || (entry !== undefined && rootEntry(recorded) === entry);
    });
    return { matches };
  } catch (error) {
    if (!isMeshRegistryError(error)) throw error;
    const registry = registryFailure(error);
    const cause: NativeCause = { code: registry.code, detail: oneLine([registry.message, registry.remedy].filter(Boolean).join(". ")) };
    return { matches: [], cause };
  }
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
