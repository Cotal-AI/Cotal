import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { acquireLock, globalConfigDir, oneLine, parseAgentFileBytes, projectTrustProblem, rejectionText, writeSecretFileAtomic, type AgentDef } from "@cotal-ai/core";
import { parseLaunchPersonaSource, PersonaSourceError } from "./launch-persona.js";
import { CommandFailure, isCommandFailure, recordOperationWarning } from "./output.js";
import { assertCotalHomeWriteProtection, configLinkChecks, localRecordAccess, prepareCotalHomeForWrite } from "./protected-records.js";
import { assertProtectedLinkWrite } from "./protected-link-write.js";
import { localWriteFailure } from "./local-write.js";
import { canonicalRoot, homeCotalDir, isMeshRegistryError, readMeshRegistry } from "./mesh-registry.js";
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
function readFile(path = trustedProjectsPath()): TrustedProjects | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (localRecordAccess() === "posix") {
    if (stat.isSymbolicLink())
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} is a symbolic link; it is kept only in a regular file, so nothing was read`, { target: { path }, remedy: `replace the link ${path} with a regular copy of the file it names` });
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} belongs to another user, so nothing was read`, { target: { path }, remedy: `remove ${path}; no folder is trusted until you run \`cotal trust <path>\` for each one` });
    if ((stat.mode & 0o022) !== 0)
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the trusted projects file ${path} can be written by other accounts, so nothing was read`, { target: { path }, remedy: `check that every folder in its \`roots\` is one you trust, since another account may have added it, then run \`chmod 600 ${path}\`` });
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

/** Check the existing config path before a trust write, without creating directories. A symbolic
 *  link is followed when its physical folder and every link parent are protected, and the returned
 *  path is the physical directory the write uses. */
function assertTrustConfigWriteProtection(dir: string): string {
  return assertProtectedLinkWrite(dir, "the Cotal config folder", configLinkChecks, "no folder was trusted");
}

/** Run `change` on the current file under its lock and write the returned document, if any. */
function update(change: (current: TrustedProjects | undefined) => TrustedProjects | undefined): void {
  const dir = assertTrustConfigWriteProtection(globalConfigDir());
  const file = join(dir, "trusted-projects.json");
  let lock: ReturnType<typeof acquireLock>;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireLock(`${file}.lock`, { label: "a trusted projects write", waitMs: 10_000 });
  } catch (e) {
    throw localWriteFailure(e, trustedProjectsPath(), {});
  }
  try {
    const next = change(readFile(file));
    if (next === undefined) return;
    try {
      writeSecretFileAtomic(file, `${JSON.stringify({ ...next, roots: [...new Set(next.roots)].sort() }, null, 2)}\n`);
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
    // Another account may have written its roots, which a retried seed would trust: never repaired
    // in place, only removed.
    if ((stat.mode & 0o022) !== 0) throw seedInvalid("other accounts can write it", seedRemoveRemedy());
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

/** The roots eligible for migration, or the registry error that prevents choosing them. */
function seedRoots(): string[] | Error {
  try { return [...new Set(knownSpaceRoots().map(canonicalRoot))].sort(); }
  catch (error) { return error instanceof Error ? error : new Error(rejectionText(error)); }
}

/** Migrate once per home. A durable snapshot excludes later registrations even when the trust
 *  store write fails. With no roots there is no trust store to create. */
export function seedTrustedProjects(beforeRegistration = false): void {
  const current = readSeedRecord();
  if (current?.completedAt !== undefined) return;
  const initial = current ? undefined : seedRoots();
  if (!beforeRegistration && Array.isArray(initial) && initial.length === 0) return;
  prepareCotalHomeForWrite();
  const lock = acquireLock(`${trustSeedPath()}.lock`, { label: "the project trust upgrade seed", waitMs: 10_000 });
  try {
    let record = readSeedRecord();
    if (record?.completedAt !== undefined) return;
    if (!record) {
      const roots = seedRoots();
      const attemptedAt = new Date().toISOString();
      if (roots instanceof Error) {
        writeSeedRecord({ schemaVersion: SCHEMA_VERSION, attemptedAt, roots: [], completedAt: attemptedAt });
        throw roots;
      }
      if (!roots.length) {
        if (beforeRegistration) writeSeedRecord({ schemaVersion: SCHEMA_VERSION, attemptedAt, roots, completedAt: attemptedAt });
        return;
      }
      record = { schemaVersion: SCHEMA_VERSION, attemptedAt, roots };
      writeSeedRecord(record);
    }
    const roots = record.roots;
    if (roots.length) update((current) => {
      const prior = current?.roots ?? [];
      return roots.every((root) => prior.includes(root)) ? undefined : { schemaVersion: SCHEMA_VERSION, seeded: true, roots: [...prior, ...roots] };
    });
    writeSeedRecord({ ...record, completedAt: new Date().toISOString() });
  } finally { lock.release(); }
}

const migration = new AsyncLocalStorage<{ json: boolean; attempted: boolean } | undefined>();

/** Enable migration for this invocation without reading or writing trust during dispatch. */
export function withProjectTrustMigration<T>(enabled: boolean, json: boolean, run: () => T): T {
  return migration.run(enabled ? { json, attempted: false } : undefined, run);
}

/** Record upgrade trust at an admitted launch or explicit migration point. Reads of the trust
 *  store do not call this. A registry writer must first have a durable snapshot, even if empty. */
export function migrateProjectTrust(beforeRegistration = false): void {
  const scope = migration.getStore();
  if (!scope || (!beforeRegistration && scope.attempted)) return;
  scope.attempted = true;
  try { seedTrustedProjects(beforeRegistration); }
  catch (error) {
    const remedy = isCommandFailure(error) || isMeshRegistryError(error) ? error.remedy : undefined;
    const details = `${rejectionText(error)}${remedy ? `; ${remedy}` : ""}`;
    recordOperationWarning({ code: "PROJECT_TRUST_SEED_FAILED", target: null, message: `the project trust upgrade seed did not complete: ${oneLine(details)}` }, { echo: !scope.json });
    if (beforeRegistration) {
      try { if (readSeedRecord() !== undefined) return; } catch { /* without a valid cutoff, no registration is safe to add */ }
      throw error;
    }
  }
}

/** Whether the project at `root` is trusted: its canonical path equals a stored root. Stored roots
 *  are compared as written, never resolved again, so a trusted path later replaced by a link does
 *  not pass its trust to the link's target. With no trusted projects file, nothing is trusted. */
export function isTrustedProject(root: string): boolean {
  const wanted = canonicalRoot(root);
  return (readFile()?.roots ?? []).includes(wanted);
}

/** Predict migration eligibility for one read-only preview. Never use this predicate to authorize
 * execution: a real launch must run migration and check the recorded trust. */
export function projectTrustForPreview(): (root: string) => boolean {
  let pending: Set<string> | undefined;
  return (root) => {
    if (isTrustedProject(root)) return true;
    if (pending === undefined) {
      pending = new Set();
      try {
        const record = readSeedRecord();
        if (record?.completedAt === undefined) {
          assertCotalHomeWriteProtection();
          assertTrustConfigWriteProtection(globalConfigDir());
          const roots = record?.roots ?? seedRoots();
          if (!(roots instanceof Error)) pending = new Set(roots);
        }
      } catch { /* Unreadable records or unprotected write paths do not establish eligibility. */ }
    }
    return pending.has(canonicalRoot(root));
  };
}

/** The refusal for a trusted-only entry a project folder declares while it is not trusted: the
 *  file, what it declares, the folder and the command that trusts it. */
export function untrustedProjectRefusal(file: string, declared: readonly string[], root: string): string {
  return `${file} ${projectTrustProblem(declared, root)}`;
}

/** The project folder a persona path belongs to, when it sits in one: the folder holding the
 *  `.cotal/agents` directory the path is in, directly or in a folder below it. Matched by whole path
 *  segments, so `foo.cotal/agents` is not a project's. Undefined for a path elsewhere. The path is
 *  judged as given; {@link loadTrustCheckedPersona} judges every spelling on the way to the file. */
export function personaProjectRoot(file: string): string | undefined {
  const parts = resolve(file).split(sep);
  // The last `.cotal` followed by `agents`, with the file somewhere below that `agents` folder.
  for (let i = parts.length - 3; i >= 1; i--) {
    if (parts[i] === ".cotal" && parts[i + 1] === "agents") return parts.slice(0, i).join(sep) || sep;
  }
  return undefined;
}

/** The most symbolic links followed on the way to a persona file, as Linux allows in one lookup. */
const MAX_LINK_HOPS = 40;

/** A persona path resolved one link at a time: the file it ends at, with no link left in its path,
 *  that file's status, and every absolute spelling met on the way. */
interface WalkedPersona {
  final: string;
  stat: Stats;
  spellings: string[];
}

const walkFailure = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

/** Resolve `file` component by component with lstat and readlink, as the kernel does. It records the
 *  path as written, each link's own path with the rest of the path after it, the path each link leads
 *  to, every folder the walk steps through (so a path that enters a `.cotal/agents` and leaves it with
 *  `..` is still judged by that folder), and the file reached. A relative link resolves against the
 *  folder that holds it, and `..` leaves the real folder reached, never a link's own folder. More than
 *  {@link MAX_LINK_HOPS} links, as a loop makes, throws `ELOOP`; a missing component throws `ENOENT`,
 *  and any other failure its own error. */
function walkPersonaPath(file: string): WalkedPersona {
  const written = isAbsolute(file) ? file : `${process.cwd()}${sep}${file}`;
  const spellings = [written];
  const separator = sep === "\\" ? /[\\/]/ : "/";
  const split = (p: string): string[] => p.slice(parse(p).root.length).split(separator).filter(Boolean);
  // Joined without collapsing `..`: a spelling is judged as the walk met it.
  const at = (dir: string, rest: string[]): string => (rest.length ? `${dir.endsWith(sep) ? dir : dir + sep}${rest.join(sep)}` : dir);
  let done = parse(written).root;
  let todo = split(written);
  let hops = 0;
  while (todo.length) {
    const part = todo.shift()!;
    if (part === ".") continue;
    if (part === "..") { done = dirname(done); continue; }
    const next = join(done, part);
    if (!lstatSync(next).isSymbolicLink()) {
      done = next;
      // A folder passed through, judged as if the persona were inside it.
      if (todo.length) spellings.push(join(done, "_"));
      continue;
    }
    if (++hops > MAX_LINK_HOPS)
      throw walkFailure("ELOOP", `${file} passes through more than ${MAX_LINK_HOPS} symbolic links, as a loop does, so it was not read`);
    const target = readlinkSync(next);
    spellings.push(at(next, todo));
    if (isAbsolute(target)) done = parse(target).root;
    todo = [...split(target), ...todo];
    spellings.push(at(done, todo));
  }
  spellings.push(done);
  return { final: done, stat: lstatSync(done), spellings: [...new Set(spellings)] };
}

/** Read the file a walk ended at, refusing if it differs from the file the walk judged: the last
 *  component is opened without following a link, and the opened file must be the same one. */
function readWalked(file: string, walked: WalkedPersona, as: "launch" | "agent"): Buffer {
  const notRegular = () => as === "launch" ? new PersonaSourceError(`persona is not a regular file: ${file}`, { remedy: "pass a regular persona file" }) : new Error(`agent file ${file} is not a regular file`);
  if (!walked.stat.isFile()) throw notRegular();
  const fd = openSync(walked.final, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw notRegular();
    if (localRecordAccess() === "posix" && (opened.dev !== walked.stat.dev || opened.ino !== walked.stat.ino))
      throw walkFailure("ESTALE", `${file} changed while it was read, so it was not used`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The first spelling on the way to a persona file that lies under the `.cotal/agents` of a project
 *  folder that is not trusted, with that folder. */
function untrustedSpelling(walked: WalkedPersona, trusted = isTrustedProject): { root: string; spelling: string } | undefined {
  for (const spelling of walked.spellings) {
    const root = personaProjectRoot(spelling);
    if (root !== undefined && !trusted(root)) return { root, spelling };
  }
  return undefined;
}

function launchOptionsRefusal(file: string, walked: WalkedPersona, launchOptions: Record<string, unknown> | undefined, trusted = isTrustedProject): string | undefined {
  const keys = Object.keys(launchOptions ?? {});
  if (!keys.length) return undefined;
  const untrusted = untrustedSpelling(walked, trusted);
  if (untrusted === undefined) return undefined;
  const shown = untrusted.spelling === resolve(file) ? file : `${file} (which leads to ${untrusted.spelling})`;
  return untrustedProjectRefusal(shown, keys.map((key) => `launchOptions.${key}`), untrusted.root);
}

/** Read a persona file for a launch and say whether its `launchOptions` may apply. A file in a project
 *  folder that is not trusted may name none, since the connector renders each key into the host's own
 *  flags or config. The path is resolved one symbolic link at a time and every spelling met is judged:
 *  the path as written, each link and the path it leads to, and the file reached. Any of them under
 *  the `.cotal/agents` of a folder that is not trusted refuses. The persona is then read from the file
 *  the walk reached, so the file judged is the file whose definition is returned. A file outside any
 *  project, and one reached only through trusted projects, may declare launch options.
 *
 *  `as` picks the parser: `launch` refuses a Mesh manifest as {@link loadLaunchPersonaFile} does,
 *  `agent` parses as `loadAgentFile`. A missing file throws `ENOENT` and a loop `ELOOP`, as a read
 *  would. */
export function loadTrustCheckedPersona(file: string, as: "launch" | "agent", beforeTrustCheck?: () => void): { def: AgentDef; refusal?: string } {
  return readPersonaWithTrust(file, as, beforeTrustCheck, isTrustedProject);
}

/** Read a persona for preview only, without granting or recording trust. */
export function previewPersonaReader(as: "launch" | "agent", trusted = projectTrustForPreview()): (file: string) => { def: AgentDef; refusal?: string } {
  return (file) => readPersonaWithTrust(file, as, undefined, trusted);
}

function readPersonaWithTrust(file: string, as: "launch" | "agent", beforeTrustCheck: (() => void) | undefined, trusted: (root: string) => boolean): { def: AgentDef; refusal?: string } {
  const walked = walkPersonaPath(file);
  const source = readWalked(file, walked, as);
  const def = as === "launch" ? parseLaunchPersonaSource(source, file) : parseAgentFileBytes(source, file);
  beforeTrustCheck?.();
  const refusal = launchOptionsRefusal(file, walked, def.launchOptions, trusted);
  return { def, ...(refusal ? { refusal } : {}) };
}

/** The same rule for a manifest launch, whose spec carries the persona's launch options already
 *  merged with the manifest's own. The persona file it names is walked and judged again here, on the
 *  host that launches; when a spelling lies under a folder that is not trusted, the file the walk
 *  reached is read, and a key it declares refuses. The manifest's own `launchOptions` are not gated.
 *  A file that is not on this host, as with a spec a remote machine deployed, was checked where that
 *  machine read it. A path this host cannot resolve or read for any other reason, a loop included,
 *  refuses. */
export function manifestPersonaLaunchOptionsRefusal(personaPath: string | undefined, launchOptions: Record<string, unknown> | undefined): string | undefined {
  if (personaPath === undefined || !Object.keys(launchOptions ?? {}).length) return undefined;
  const unreadable = (e: unknown) => `${personaPath} could not be read to check its launch options (${(e as Error).message}), so nothing was launched. Make the path resolve to a readable persona file, then retry`;
  let walked: WalkedPersona;
  try { walked = walkPersonaPath(personaPath); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return unreadable(e);
  }
  if (untrustedSpelling(walked) === undefined) return undefined;
  let declared: Record<string, unknown> | undefined;
  try { declared = parseAgentFileBytes(readWalked(personaPath, walked, "agent"), personaPath).launchOptions; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return unreadable(e);
  }
  return launchOptionsRefusal(personaPath, walked, declared);
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
  migrateProjectTrust();
  let added = false;
  update((current) => {
    const roots = current?.roots ?? [];
    added = !roots.includes(canonical);
    return added ? { schemaVersion: SCHEMA_VERSION, seeded: true, roots: [...roots, canonical] } : undefined;
  });
  return { root: canonical, added };
}
