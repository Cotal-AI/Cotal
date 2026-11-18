import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { acquireLock, globalConfigDir, loadAgentFile, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure } from "./output.js";
import { localRecordAccess, prepareCotalHomeForWrite, protectedLocalDirectory } from "./protected-records.js";
import { localWriteFailure } from "./local-write.js";
import { canonicalRoot, homeCotalDir, readMeshRegistry } from "./mesh-registry.js";
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
 * `seeded` marks a file the upgrade seed could have written. Whether the seed ran is recorded apart
 * from this file, beside the space registry it reads (see {@link seedTrustedProjects}), so removing,
 * corrupting or never writing this file never runs the seed again, and a config folder that another
 * shell selects sees the same record.
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
    remedy: `fix ${trustedProjectsPath()}. If you remove it instead, no folder is trusted until you run \`cotal trust <path>\` for each one`,
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
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} belongs to another user, so nothing was read`, { target: { path }, remedy: `remove ${path}; no folder is trusted until you run \`cotal trust <path>\` for each one` });
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

/** The record that the upgrade seed was attempted, kept in the Cotal home beside the space registry
 *  it reads: the roots known at the first attempt, and when the trusted projects file received them.
 *  It is written before the trusted projects file, so a seed attempt that fails is still recorded. */
interface SeedRecord {
  schemaVersion: 1;
  attemptedAt: string;
  roots: string[];
  completedAt?: string;
}

/** `<Cotal home>/trusted-projects-seed.json`. */
export function trustSeedPath(): string {
  return join(homeCotalDir(), "trusted-projects-seed.json");
}

const seedInvalid = (problem: string, remedy: string): CommandFailure =>
  new CommandFailure("refused", "SCHEMA_INVALID", `the trusted projects seed record ${trustSeedPath()} is invalid: ${problem}`, { remedy });

/** What to do with a seed record that cannot be used. `cotal trust` does not change it. Removing it
 *  runs the seed again on the next command, from the spaces registered at that time. */
const seedRemoveRemedy = (): string =>
  `remove ${trustSeedPath()} to stop this warning. The next command then trusts every folder a space is registered or prepared at, so first run \`cotal meshes rm <space>\` for any space whose folder you do not trust. \`cotal trust <path>\` trusts one folder without it`;

/** The seed record, or undefined when the seed was never attempted. A record that is linked, owned
 *  or writable by another account, or invalid refuses: it is never read as "not attempted". */
function readSeedRecord(): SeedRecord | undefined {
  const path = trustSeedPath();
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (localRecordAccess() === "posix") {
    if (stat.isSymbolicLink()) throw seedInvalid("it is a symbolic link", seedRemoveRemedy());
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw seedInvalid("it belongs to another user", seedRemoveRemedy());
    if ((stat.mode & 0o022) !== 0) throw seedInvalid("other accounts can write it", `run \`chmod 600 ${path}\``);
  }
  if (!stat.isFile()) throw seedInvalid("it is not a regular file", seedRemoveRemedy());
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw seedInvalid("it is not JSON", seedRemoveRemedy()); }
  const { schemaVersion, attemptedAt, roots, completedAt, ...rest } = (doc ?? {}) as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc) || Object.keys(rest).length || schemaVersion !== SCHEMA_VERSION || typeof attemptedAt !== "string"
    || (completedAt !== undefined && typeof completedAt !== "string")
    || !Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !isAbsolute(root)))
    throw seedInvalid("its fields do not match the record format", seedRemoveRemedy());
  return { schemaVersion: SCHEMA_VERSION, attemptedAt, roots: roots as string[], ...(completedAt !== undefined ? { completedAt } : {}) };
}

function writeSeedRecord(record: SeedRecord): void {
  try {
    prepareCotalHomeForWrite();
    writeSecretFileAtomic(trustSeedPath(), `${JSON.stringify(record, null, 2)}\n`);
  } catch (e) {
    if (isCommandFailure(e)) throw e;
    throw localWriteFailure(e, trustSeedPath(), {});
  }
}

/** The one-time upgrade seed, so a project that worked before upgrading keeps working. The first
 *  attempt records, beside the space registry, every root a space was registered or prepared at, and
 *  then adds those roots to the trusted projects file. The CLI calls it before a command body runs,
 *  so a registration made after the upgrade is never in that record.
 *
 *  Once a record exists the registry is never read for this again: an attempt whose file write
 *  failed adds only the recorded roots when it later succeeds, and a completed seed adds nothing,
 *  whether the trusted projects file was removed, is invalid, or lives in another config folder. */
export function seedTrustedProjects(): void {
  let record = readSeedRecord();
  if (record?.completedAt !== undefined) return;
  if (record === undefined) {
    record = { schemaVersion: SCHEMA_VERSION, attemptedAt: new Date().toISOString(), roots: [...new Set(knownSpaceRoots().map(canonicalRoot))].sort() };
    writeSeedRecord(record);
  }
  const roots = record.roots;
  update((current) => ({ schemaVersion: SCHEMA_VERSION, seeded: true, roots: [...(current?.roots ?? []), ...roots] }));
  writeSeedRecord({ ...record, completedAt: new Date().toISOString() });
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

/** The project folder a persona path belongs to, when it sits in one: the folder holding the
 *  `.cotal/agents` directory the path is in, directly or in a folder below it. Matched by whole path
 *  segments, so `foo.cotal/agents` is not a project's. Undefined for a path elsewhere. The path is
 *  judged as given; {@link untrustedPersonaRoot} also judges the file a read of it reaches. */
export function personaProjectRoot(file: string): string | undefined {
  const parts = resolve(file).split(sep);
  // The last `.cotal` followed by `agents`, with the file somewhere below that `agents` folder.
  for (let i = parts.length - 3; i >= 1; i--) {
    if (parts[i] === ".cotal" && parts[i + 1] === "agents") return parts.slice(0, i).join(sep) || sep;
  }
  return undefined;
}

/** The untrusted project a persona file belongs to, judged twice: by the path as written and by the
 *  file a read of that path reaches, with every symbolic link resolved as the loaders follow them.
 *  A link outside any `.cotal/agents` to a persona inside an untrusted project's, and a link in a
 *  trusted project's `.cotal/agents` to a persona under an untrusted project, both belong to the
 *  untrusted project. Undefined when neither spelling lies under an untrusted project's
 *  `.cotal/agents`. `file` is the path as written; `read` is the resolved file, when there is one. */
function untrustedPersonaRoot(file: string): { root: string; read?: string } | undefined {
  const read = canonicalRoot(file);
  for (const root of new Set([personaProjectRoot(file), personaProjectRoot(read)])) {
    if (root !== undefined && !isTrustedProject(root)) return { root, ...(read !== resolve(file) ? { read } : {}) };
  }
  return undefined;
}

/** Why a persona file may not contribute its `launchOptions` to a launch, or undefined when it may:
 *  a file in a project folder that is not trusted may name none, since the connector renders each
 *  key into the host's own flags or config. Both the path as written and the file it reads are
 *  judged. A file outside any project, and a file whose project is trusted, may. */
export function personaLaunchOptionsRefusal(file: string, launchOptions: Record<string, unknown> | undefined): string | undefined {
  const keys = Object.keys(launchOptions ?? {});
  if (!keys.length) return undefined;
  const untrusted = untrustedPersonaRoot(file);
  if (untrusted === undefined) return undefined;
  return untrustedProjectRefusal(untrusted.read ? `${file} (a link to ${untrusted.read})` : file, keys.map((key) => `launchOptions.${key}`), untrusted.root);
}

/** The same rule for a manifest launch, whose spec carries the persona's launch options already
 *  merged with the manifest's own. The persona file it names is read again here, on the host that
 *  launches: a key that file declares, in a project folder that is not trusted, refuses. The
 *  manifest's own `launchOptions` are not gated. As on every launch path, the path as written and
 *  the file it reads are both judged. A file that is not on this host, as with a spec a
 *  remote machine deployed, was checked where that machine read it. A file this host has but
 *  cannot read refuses, since what it declares is unknown. */
export function manifestPersonaLaunchOptionsRefusal(personaPath: string | undefined, launchOptions: Record<string, unknown> | undefined): string | undefined {
  if (personaPath === undefined || !Object.keys(launchOptions ?? {}).length) return undefined;
  const untrusted = untrustedPersonaRoot(personaPath);
  if (untrusted === undefined) return undefined;
  const root = untrusted.root;
  let declared: Record<string, unknown> | undefined;
  try { declared = loadAgentFile(personaPath).launchOptions; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `${personaPath} could not be read to check its launch options, and ${root} is not trusted, so nothing was launched. If you trust this folder, run \`cotal trust ${root}\``;
  }
  return personaLaunchOptionsRefusal(personaPath, declared);
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
