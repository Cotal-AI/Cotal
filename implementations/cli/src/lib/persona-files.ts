import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  acquireLock, agentFilePath, assertValidName, hardenPrivate, mkSecretDir,
  parseAgentFileSource, saveAgentFile, writeSecretFile, writeSecretFileAtomic,
  type AgentDef,
} from "@cotal-ai/core";
import {
  cachedPreferences, CommandFailure, inputDisabledByFlag, isWorkspaceTargetError,
  resolveMeshTarget, resolvePreference, targetErrorCode, workspaceErrorParts,
} from "@cotal-ai/workspace";

export interface PersonaCatalog { root: string; space: string }
export interface PersonaSource { bytes: Buffer; ino: number; dev: number; mtimeMs: number }

/** Resolve once, without inventing a broker for a prepared space or falling back to the cwd. */
export function personaCatalog(values: { space?: string; server?: string }): PersonaCatalog {
  try {
    const target = resolveMeshTarget(process.cwd(), { ...values, readOnly: true });
    return catalogAt(target.root, target.space);
  } catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && !values.server && error.details.root && error.details.space)
      return catalogAt(error.details.root, error.details.space);
    const { message, remedy } = workspaceErrorParts({ kind: "target", error });
    // Every caller selects with --space, and some take no --server, so the shared remedy's
    // `--server` would name a flag the command refuses. A prepared space is selectable by name.
    const next = error.code === "no-meshes" ? "run `cotal up` in a project, or name a prepared or registered space with `--space <name>`" : remedy;
    throw new CommandFailure("refused", targetErrorCode(error.code), message, next ? { remedy: next } : {});
  }
}

function catalogAt(root: string, space: string): PersonaCatalog {
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return { root: realpathSync(root), space };
  } catch {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected persona catalog root is unavailable");
  }
}

export function personaPath(root: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new CommandFailure("refused", "USAGE_INVALID", "persona names use letters, digits, '_' or '-'");
  try { assertValidName(name); } catch { throw new CommandFailure("refused", "USAGE_INVALID", "invalid persona name"); }
  return agentFilePath(root, name);
}

/** Only absence is absent. Unreadable and non-regular sources refuse rather than becoming empty. */
export function readPersonaSource(path: string): PersonaSource | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new CommandFailure("refused", "PERMISSION_DENIED", `persona is not a regular file: ${path}`);
    return { bytes: readFileSync(path), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona: ${path}`);
  }
}

export function requirePersonaSource(path: string): PersonaSource {
  const source = readPersonaSource(path);
  if (!source) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no persona at ${path}`);
  return source;
}

/** Keep parser diagnostics private: YAML errors can contain the document's own sensitive values.
 *  `name` is required of a new definition only. A stored one may launch under another name: the
 *  seeded `default` persona launches as `default_agent`. */
export function validatePersona(bytes: Buffer, path: string, name?: string): AgentDef {
  let def: AgentDef;
  try { def = parseAgentFileSource(bytes.toString("utf8"), path); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid persona definition: ${path}`, { remedy: "check the agent-file frontmatter and channel declarations" }); }
  if (name !== undefined && def.name !== name) throw new CommandFailure("refused", "SCHEMA_INVALID", `persona name must match the catalog name '${name}'`);
  return def;
}

function sameSource(a: PersonaSource | undefined, b: PersonaSource | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs && a.bytes.equals(b.bytes);
}

/** A catalog folder its owner made read-only is refused as it is: hardening it would undo the lock. */
function assertCatalogWritable(dir: string): void {
  if (!existsSync(dir)) return;
  try { accessSync(dir, constants.W_OK); }
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", `the persona catalog ${dir} is not writable; nothing was changed`, { remedy: `make it writable with \`chmod u+w ${dir}\` to change its personas` }); }
}

/** Shared by canonical and legacy CLI writes only. Manager and external writers do not take this lock. */
export function commitPersona(path: string, expected: PersonaSource | undefined, bytes: Buffer | undefined): void {
  const dir = dirname(path);
  assertCatalogWritable(dir);
  mkSecretDir(dir);
  const lockPath = join(realpathSync(dirname(path)), `.${basename(path)}.lock`);
  const lock = acquireLock(lockPath, { label: "local persona write", onTimeout: () => new CommandFailure("refused", "CONFLICT", "another local persona write holds the catalog lock") });
  try {
    const current = readPersonaSource(path);
    if (!sameSource(expected, current))
      throw new CommandFailure("refused", "CONFLICT", `persona changed while the operation was open: ${path}`, { remedy: "read the current definition and retry" });
    if (bytes === undefined) unlinkSync(path);
    else writeSecretFileAtomic(path, bytes);
  } finally { lock.release(); }
}

/** Own a private draft and remove only that draft. A cleanup failure is not a successful operation. */
function withDraft<T>(name: string, action: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cotal-persona-"));
  try {
    hardenPrivate(dir, "dir");
    return action(join(dir, `${name}.md`));
  }
  finally {
    try { rmSync(dir, { recursive: true }); }
    catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", `cannot remove private persona draft: ${dir}`, { changed: [{ kind: "private-draft", path: dir }], remedy: "remove the private draft after reviewing the operation outcome" }); }
  }
}

/** Use the existing serializer for flag-built definitions; file inputs keep their original bytes. */
export function serializePersona(def: AgentDef): Buffer {
  return withDraft(def.name, path => {
    try { writeSecretFile(path, ""); saveAgentFile(path, def); }
    catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "invalid persona fields"); }
    const bytes = readFileSync(path);
    validatePersona(bytes, path, def.name);
    return bytes;
  });
}

/** Never expose the catalog file to an editor. Validate successful draft bytes, then compare under lock. */
export function editPersona(path: string, name: string, catalog: PersonaCatalog, json = false): void {
  if (json || inputDisabledByFlag())
    throw new CommandFailure("refused", "USAGE_INVALID", "persona edit opens an editor, --no-input forbids one, as does --json", { remedy: "edit interactively without --json or --no-input" });
  const source = requirePersonaSource(path);
  validatePersona(source.bytes, path);
  assertCatalogWritable(dirname(path));
  const editor = resolvePreference("editor", { preferences: cachedPreferences(), space: catalog.space }).value;
  if (!editor) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "no editor is set", { remedy: "set VISUAL or EDITOR, or run `cotal config set editor vim`" });
  const edited = withDraft(name, draft => {
    writeSecretFile(draft, source.bytes);
    const quoted = process.platform === "win32" ? `"${draft.replaceAll('"', '""')}"` : `'${draft.replaceAll("'", "'\\''")}'`;
    const result = spawnSync(`${editor} ${quoted}`, { shell: true, stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw new CommandFailure("failed", "OPERATION_FAILED", `editor ${result.signal ? `ended on ${result.signal}` : `exited with status ${result.status}`} - not saved`);
    const edited = requirePersonaSource(draft).bytes;
    validatePersona(edited, path);
    return edited;
  });
  commitPersona(path, source, edited);
}
