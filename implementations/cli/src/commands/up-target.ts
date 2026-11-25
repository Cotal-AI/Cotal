import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { authDir, canonicalRoot, CommandFailure, findMesh, findPreparedSpace, homeCotalDir, isMeshRegistryError, listSpaceAccounts, loadPreparedSpaces, oneLine, preparedRootRemedy, projectRootProblem, projectRootProblemText, type PreparedSpace, type ProjectRootProblem } from "@cotal-ai/workspace";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { retainedOpenSpace } from "../lib/legacy-start.js";
import { cotalRoot } from "../lib/paths.js";
import { registryFailure } from "../lib/registry-errors.js";
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
  const requested = resolve(value);
  const problem = projectRootProblem(requested);
  if (problem !== undefined)
    throw unavailableUpRoot(requested, `--root ${oneLine(requested)} ${projectRootProblemText(problem)}`, unavailableRootRemedy(requested, problem));
  let root: string;
  try {
    root = realpathSync(requested);
    const cotal = lstatSync(join(root, ".cotal"));
    if (!cotal.isDirectory() || cotal.isSymbolicLink()) throw new Error("not a private project directory");
  } catch {
    throw unavailableUpRoot(requested, "--root must name an existing prepared local project with its own .cotal directory", "prepare it with `cotal space create <space> --root <dir>`, then retry with that root");
  }
  if (canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir()))
    throw new CommandFailure("refused", "CONFLICT", "--root names the machine's home store, not a prepared project; no stack was started there", { target: { root }, remedy: "prepare the space in a project folder with `cotal space create <space> --root <dir>`" });
  return root;
}

function unavailableUpRoot(root: string, message: string, remedy: string): CommandFailure {
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", `${message}; no ancestor or other space was selected`, { target: { root }, remedy });
}

function unavailableRootRemedy(root: string, problem: ProjectRootProblem): string {
  if (problem === "inaccessible") return "restore access to the original project folder, then try again";
  // A replacement link can point at a different preparation's root.
  let prepared: PreparedSpace | undefined;
  try { prepared = loadPreparedSpaces().find((space) => resolve(space.root) === root); }
  catch (error) { throw isMeshRegistryError(error) ? registryFailure(error) : error; }
  if (prepared === undefined) return "pass the path to an existing prepared project directory";
  const restore = problem === "missing" ? "restore the original project folder at its recorded path, or " : "move the obstructing entry aside and ";
  return `${restore}${preparedRootRemedy(prepared.space, problem)}, using a different directory for <dir>`;
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
