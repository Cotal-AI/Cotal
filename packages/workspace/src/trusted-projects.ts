import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { acquireLock, globalConfigDir, readCotalConfigFile, spaceConfigPath, trustedOnlyEntries, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure } from "./output.js";
import { localRecordAccess, protectedLocalDirectory } from "./protected-records.js";
import { localWriteFailure } from "./local-write.js";
import { canonicalRoot, loadMeshes } from "./mesh-registry.js";
import { loadPreparedSpaces } from "./prepared-spaces.js";

/**
 * The project folders whose own `.cotal/config.json` may declare MCP servers and `spawn.env` names.
 * The list lives in the operator's config folder, beside `config.json`, so nothing inside a project
 * can add itself. `cotal trust <path>` adds a folder; `cotal setup`, `cotal space create` and
 * `cotal up` add the folder they make a space in. Roots are kept canonical (symbolic links resolved).
 */
interface TrustedProjects {
  schemaVersion: 1;
  roots: string[];
}

const SCHEMA_VERSION = 1;

/** `<globalConfigDir()>/trusted-projects.json`, private to its owner. */
export function trustedProjectsPath(): string {
  return join(globalConfigDir(), "trusted-projects.json");
}

const invalid = (problem: string): CommandFailure =>
  new CommandFailure("refused", "SCHEMA_INVALID", `the trusted projects file ${trustedProjectsPath()} is invalid: ${problem}`, {
    remedy: `fix or remove ${trustedProjectsPath()}, then run \`cotal trust <path>\` for each folder you trust`,
  });

/** The trusted roots as written, or undefined when there is no file yet. A linked or non-regular
 *  file, and a file that does not validate, refuse rather than read as empty. */
function readFile(): TrustedProjects | undefined {
  const path = trustedProjectsPath();
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (localRecordAccess() === "posix" && stat.isSymbolicLink())
    throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} is a symbolic link; it is kept only in a regular file, so nothing was read`, { target: { path }, remedy: `replace the link ${path} with a regular copy of the file it names` });
  if (!stat.isFile()) throw invalid("it is not a regular file");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw invalid(`not JSON (${(e as Error).message})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw invalid("not an object");
  const { schemaVersion, roots, ...rest } = doc as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw invalid(`unknown field "${extra[0]}"`);
  if (schemaVersion !== SCHEMA_VERSION) throw invalid(`schemaVersion ${JSON.stringify(schemaVersion)} is not ${SCHEMA_VERSION}`);
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !isAbsolute(root))) throw invalid("roots is not a list of absolute paths");
  return { schemaVersion: SCHEMA_VERSION, roots: roots as string[] };
}

/** Every root a space this machine runs or prepared is recorded at. The first write of the trusted
 *  projects file records these, so a project that worked before upgrading keeps working. */
function knownSpaceRoots(): string[] {
  return [...loadMeshes().map((m) => m.root), ...loadPreparedSpaces().map((p) => p.root)];
}

/** Add `roots` to the file under its lock and report the canonical roots that were new. A missing file
 *  starts from every known space root, so the first write also records those. A config folder another
 *  account could write refuses before anything is written. */
function addRoots(roots: readonly string[]): string[] {
  const dir = globalConfigDir();
  let existing = dir;
  while (!lstatSync(existing, { throwIfNoEntry: false }) && dirname(existing) !== existing) existing = dirname(existing);
  try {
    protectedLocalDirectory(existing, "the Cotal config folder");
  } catch (e) {
    if (!isCommandFailure(e) || e.code !== "PERMISSION_DENIED") throw e;
    throw new CommandFailure(e.outcome, e.code, `${e.message}; no folder was trusted`, { remedy: e.remedy, target: e.target });
  }
  let lock: ReturnType<typeof acquireLock>;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireLock(`${trustedProjectsPath()}.lock`, { label: "a trusted projects write", waitMs: 10_000 });
  } catch (e) {
    throw localWriteFailure(e, trustedProjectsPath(), {});
  }
  try {
    const current = readFile();
    const kept = new Set((current?.roots ?? knownSpaceRoots()).map(canonicalRoot));
    const added = [...new Set(roots.map(canonicalRoot))].filter((root) => !kept.has(root));
    if (current && !added.length) return [];
    const next: TrustedProjects = { schemaVersion: SCHEMA_VERSION, roots: [...kept, ...added].sort() };
    try {
      writeSecretFileAtomic(trustedProjectsPath(), `${JSON.stringify(next, null, 2)}\n`);
    } catch (e) {
      throw localWriteFailure(e, trustedProjectsPath(), {});
    }
    return added;
  } finally {
    lock.release();
  }
}

/** Whether the project at `root` is trusted: its canonical path is in the trusted projects file. When
 *  that file does not exist yet, it is written first with every root a space this machine runs or
 *  prepared is recorded at. */
export function isTrustedProject(root: string): boolean {
  if (readFile() === undefined) addRoots([]);
  const roots = readFile()?.roots ?? [];
  const wanted = canonicalRoot(root);
  return roots.some((r) => canonicalRoot(r) === wanted);
}

/** Trust the project at `root`, which must be an existing folder whose `.cotal`, when it has one,
 *  belongs to this account. Returns its canonical path and whether it was newly trusted. */
export function trustProject(root: string): { root: string; added: boolean } {
  if (!existsSync(root) || !lstatSync(canonicalRoot(root)).isDirectory())
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${root} is not a folder, so it was not trusted`, { target: { root }, remedy: "name an existing project folder" });
  const canonical = canonicalRoot(root);
  const control = statSync(join(canonical, ".cotal"), { throwIfNoEntry: false });
  if (control && typeof process.getuid === "function" && control.uid !== process.getuid())
    throw new CommandFailure("refused", "PERMISSION_DENIED", `${join(canonical, ".cotal")} belongs to another user, so ${canonical} was not trusted`, { target: { root: canonical }, remedy: "trust a project folder your own account owns" });
  return { root: canonical, added: addRoots([canonical]).length > 0 };
}

/** Trust the folder a command is about to record a space in, unless its project config already
 *  declares an MCP server or a `spawn.env` name, or cannot be read: such a folder came with that
 *  config, and only `cotal trust` trusts it. Call it before the space is recorded, so the first write
 *  of the trusted projects file does not take the folder from the records either. Returns whether the
 *  folder is now newly trusted. */
export function trustCreatedProject(root: string): boolean {
  const path = spaceConfigPath(root);
  let declares = false;
  if (existsSync(path)) {
    try {
      declares = trustedOnlyEntries(readCotalConfigFile(path)).length > 0;
    } catch {
      declares = true;
    }
  }
  if (declares) {
    if (readFile() === undefined) addRoots([]);
    return false;
  }
  return trustProject(root).added;
}
