import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { acquireLock, globalConfigDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure } from "./output.js";
import { localRecordAccess, protectedLocalDirectory } from "./protected-records.js";
import { localWriteFailure } from "./local-write.js";
import { canonicalRoot, readMeshRegistry } from "./mesh-registry.js";
import { readPreparedSpaces } from "./prepared-spaces.js";

/**
 * The project folders whose own `.cotal` may declare MCP servers, `spawn.env` names and persona
 * launch options. The list lives in the operator's config folder, beside `config.json`, so nothing
 * inside a project can add itself. `cotal trust <path>` adds a folder; `cotal setup`, `cotal space
 * create` and `cotal up` add a folder only when they made its `.cotal` in that same run.
 *
 * Each root is stored in canonical form (symbolic links resolved) when it is added, and a folder is
 * trusted when its own canonical form equals a stored string. Trust follows the path: a folder
 * deleted and made again at a trusted path is trusted.
 *
 * `seeded` records that the one-time upgrade seed ran: the CLI writes the file, with every root a
 * space was registered or prepared at, before a command can register anything (see
 * {@link seedTrustedProjects}). A file that exists is never seeded again.
 */
interface TrustedProjects {
  schemaVersion: 1;
  seeded: true;
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
 *  file, one another account owns or may write, and one that does not validate all refuse rather
 *  than read as empty. */
function readFile(): TrustedProjects | undefined {
  const path = trustedProjectsPath();
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (localRecordAccess() === "posix") {
    if (stat.isSymbolicLink())
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} is a symbolic link; it is kept only in a regular file, so nothing was read`, { target: { path }, remedy: `replace the link ${path} with a regular copy of the file it names` });
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} belongs to another user, so nothing was read`, { target: { path }, remedy: `remove ${path}, then run \`cotal trust <path>\` for each folder you trust` });
    if ((stat.mode & 0o022) !== 0)
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} can be written by other accounts, so nothing was read`, { target: { path }, remedy: `run \`chmod 600 ${path}\`` });
  }
  if (!stat.isFile()) throw invalid("it is not a regular file");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw invalid(`not JSON (${(e as Error).message})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw invalid("not an object");
  const { schemaVersion, seeded, roots, ...rest } = doc as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw invalid(`unknown field "${extra[0]}"`);
  if (schemaVersion !== SCHEMA_VERSION) throw invalid(`schemaVersion ${JSON.stringify(schemaVersion)} is not ${SCHEMA_VERSION}`);
  if (seeded !== true) throw invalid("seeded is not true");
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !isAbsolute(root))) throw invalid("roots is not a list of absolute paths");
  return { schemaVersion: SCHEMA_VERSION, seeded: true, roots: roots as string[] };
}

/** Every root a space this machine registered or prepared is recorded at, skipping a record that
 *  cannot be read (it names no root anyone can use). */
function knownSpaceRoots(): string[] {
  return [...readMeshRegistry().entries.map((m) => m.root), ...readPreparedSpaces().spaces.map((p) => p.root)];
}

/** Run `change` on the current file (undefined when there is none) under its lock and write what it
 *  returns, or nothing when it returns undefined. A config folder another account could write
 *  refuses before anything is written. */
function update(change: (current: TrustedProjects | undefined) => TrustedProjects | undefined): void {
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
    const next = change(readFile());
    if (next === undefined) return;
    try {
      writeSecretFileAtomic(trustedProjectsPath(), `${JSON.stringify({ ...next, roots: [...new Set(next.roots)].sort() }, null, 2)}\n`);
    } catch (e) {
      throw localWriteFailure(e, trustedProjectsPath(), {});
    }
  } finally {
    lock.release();
  }
}

/** The one-time upgrade seed: when no trusted projects file exists, write one that trusts every root
 *  a space was registered or prepared at, so a project that worked before upgrading keeps working.
 *  The CLI calls it before a command runs, so a registration made after the upgrade is never seeded;
 *  a file that exists, even an empty one, is left as it is. */
export function seedTrustedProjects(): void {
  if (readFile() !== undefined) return;
  update((current) => current ?? { schemaVersion: SCHEMA_VERSION, seeded: true, roots: knownSpaceRoots().map(canonicalRoot) });
}

/** Whether the project at `root` is trusted: its canonical path equals a stored root. Stored roots
 *  are compared as written, never resolved again, so a trusted path later replaced by a link does
 *  not pass its trust to the link's target. With no trusted projects file, nothing is trusted. */
export function isTrustedProject(root: string): boolean {
  const wanted = canonicalRoot(root);
  return (readFile()?.roots ?? []).includes(wanted);
}

/** The refusal for a trusted-only entry a project folder declares while it is not trusted: the
 *  file, what it declares, the folder and the command that trusts it. */
export function untrustedProjectRefusal(file: string, declared: readonly string[], root: string): string {
  return `${file} declares ${declared.join(", ")}, which a project may declare only when its folder is trusted. ${root} is not trusted, so nothing was launched. If you trust this folder, run \`cotal trust ${root}\``;
}

/** The project folder a persona file belongs to, when it sits in one: the folder holding the
 *  `.cotal/agents` directory that contains it. Undefined for a file elsewhere. */
export function personaProjectRoot(file: string): string | undefined {
  const agents = dirname(resolve(file));
  const control = dirname(agents);
  return agents.endsWith(join(".cotal", "agents")) && dirname(control) !== control ? dirname(control) : undefined;
}

/** Why a persona file may not contribute its `launchOptions` to a launch, or undefined when it may:
 *  a file in a project folder that is not trusted may name none, since the connector renders each
 *  key into the host's own flags or config. A file outside any project, and a file whose project is
 *  trusted, may. */
export function personaLaunchOptionsRefusal(file: string, launchOptions: Record<string, unknown> | undefined): string | undefined {
  const keys = Object.keys(launchOptions ?? {});
  if (!keys.length) return undefined;
  const root = personaProjectRoot(file);
  if (root === undefined || isTrustedProject(root)) return undefined;
  return untrustedProjectRefusal(file, keys.map((key) => `launchOptions.${key}`), root);
}

/** Trust the project at `root`, which must be an existing folder whose `.cotal`, when it has one,
 *  belongs to this account. Returns its canonical path and whether it was newly trusted. With no
 *  trusted projects file yet, it writes one holding this root alone: only {@link seedTrustedProjects}
 *  reads the registrations. */
export function trustProject(root: string): { root: string; added: boolean } {
  if (!existsSync(root) || !lstatSync(canonicalRoot(root)).isDirectory())
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${root} is not a folder, so it was not trusted`, { target: { root }, remedy: "name an existing project folder" });
  const canonical = canonicalRoot(root);
  const control = statSync(join(canonical, ".cotal"), { throwIfNoEntry: false });
  if (control && typeof process.getuid === "function" && control.uid !== process.getuid())
    throw new CommandFailure("refused", "PERMISSION_DENIED", `${join(canonical, ".cotal")} belongs to another user, so ${canonical} was not trusted`, { target: { root: canonical }, remedy: "trust a project folder your own account owns" });
  let added = false;
  update((current) => {
    const roots = current?.roots ?? [];
    added = !roots.includes(canonical);
    return added ? { schemaVersion: SCHEMA_VERSION, seeded: true, roots: [...roots, canonical] } : undefined;
  });
  return { root: canonical, added };
}
