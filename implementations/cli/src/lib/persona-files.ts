import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  acquireLock, agentFilePath, assertValidName, hardenPrivate, linkTarget, MAX_NAME_LENGTH, mkSecretDir,
  parseAgentFileSource, saveAgentFile, utf16Problem, writeSecretFile, writeSecretFileAtomic,
  type AgentDef,
} from "@cotal-ai/core";
import {
  cachedPreferences, CommandFailure, ConfirmationRequired, inputDisabledByFlag, isCommandFailure, isGenuineSpace, isWorkspaceTargetError, loadMeshes, movedProject,
  resolveMeshTarget, resolvePreference, targetErrorCode, workspaceErrorParts,
} from "@cotal-ai/workspace";
import { DEFAULT_AGENT_NAME } from "./default-persona.js";
import { shellWord } from "./endpoint-errors.js";
import { exitInterrupted, INTERRUPT_SIGNALS, type InterruptSignal } from "./interrupt-notice.js";
import { catalogFolderProblem } from "./personas.js";

export interface PersonaCatalog { root: string; space: string }
export interface PersonaSource { bytes: Buffer; ino: number; dev: number; mtimeMs: number }

/** Resolve once, without inventing a broker for a prepared space or falling back to the cwd. */
export function personaCatalog(values: { space?: string; server?: string }): PersonaCatalog {
  try {
    const target = resolveMeshTarget(process.cwd(), { ...values, readOnly: true });
    // A `--server` that no registration names resolves to this folder's project, as launch does.
    // Outside a project there is no catalog there, and the folder is not made into one.
    if (values.server !== undefined && values.space === undefined && !loadMeshes().some((m) => m.server === values.server) && !isGenuineSpace(target.root))
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space registered here is at ${values.server}, and this folder is not a space's project`, {
        remedy: "name a prepared or registered space with `--space <name>`, or run this in its project folder", target: { server: values.server },
      });
    return catalogAt(target.root, target.space);
  } catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && !values.server && error.details.root && error.details.space && !error.details.rootMissing)
      return catalogAt(error.details.root, error.details.space);
    const { message, remedy } = workspaceErrorParts({ kind: "target", error });
    // Every caller selects with --space, and some take no --server, so the shared remedy's
    // `--server` would name a flag the command refuses. A prepared space is selectable by name.
    // The catalog is read offline, so no running mesh is not the reason: nothing selects a space.
    const none = error.code === "no-meshes";
    const next = none ? "run `cotal up` in a project, or name a prepared or registered space with `--space <name>`" : remedy;
    throw new CommandFailure("refused", targetErrorCode(error.code), none ? "no space is selected, and this folder is not a space's project" : message, next ? { remedy: next } : {});
  }
}

function catalogAt(root: string, space: string): PersonaCatalog {
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return { root: realpathSync(root), space };
  } catch {
    const moved = movedProject(space, root);
    if (moved) throw new CommandFailure("refused", "CONFLICT", moved.message, { target: moved.target, remedy: moved.remedy });
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected persona catalog root is unavailable");
  }
}

/** Why a new persona cannot take `name`: the seeded default's agents already launch under it, so a
 *  second definition would launch under the same name. */
export function reservedPersonaName(name: string): string | undefined {
  return name === DEFAULT_AGENT_NAME ? `'${name}' is reserved: the seeded default persona launches its agents under that name` : undefined;
}

/** Why `name` cannot name a persona, or undefined when it can. */
export function personaNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return `persona names use letters, digits, '_' or '-', up to ${MAX_NAME_LENGTH} characters`;
  if (name.length > MAX_NAME_LENGTH) return `persona names are at most ${MAX_NAME_LENGTH} characters; this one has ${name.length}`;
  try { assertValidName(name); } catch (error) { return (error as Error).message; }
  return undefined;
}

export function personaPath(root: string, name: string): string {
  const problem = personaNameProblem(name);
  if (problem) throw new CommandFailure("refused", "USAGE_INVALID", problem);
  return agentFilePath(root, name);
}

/** Only absence is absent. Unreadable and non-regular sources refuse rather than becoming empty. */
export function readPersonaSource(path: string): PersonaSource | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      const link = stat.isSymbolicLink() ? linkTarget(path) : undefined;
      throw new CommandFailure("refused", "PERMISSION_DENIED", `persona is not a regular file: ${path}`, link === undefined ? {} : { remedy: `${path} is a link to ${link}; replace the link with a copy of that file` });
    }
    return { bytes: readFileSync(path), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (error instanceof CommandFailure) throw error;
    const folder = code === "ENOTDIR" || code === "ELOOP" ? catalogFolderProblem(dirname(path)) : undefined;
    if (folder) throw folder;
    throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona: ${path}`);
  }
}

export function requirePersonaSource(path: string): PersonaSource {
  const source = readPersonaSource(path);
  if (!source) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no persona at ${path}`, { remedy: "see the personas here with `cotal persona`" });
  return source;
}

/** Why the agent-file parser refused a definition. A YAML error keeps only its position: the
 *  parser's own text can quote the document's sensitive values. */
function definitionProblem(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = `agent file ${path}: `;
  const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  if (!reason.startsWith("invalid YAML frontmatter")) return reason;
  // The parser counts lines from the first line after the opening `---`.
  const at = /at line (\d+), column (\d+)/.exec(reason);
  return `the frontmatter is not valid YAML${at ? ` at line ${Number(at[1]) + 1}, column ${at[2]}` : ""}`;
}

/** `name` is required of a new definition only. A stored one may launch under another name: the
 *  seeded `default` persona launches as `default_agent`. */
export function validatePersona(bytes: Buffer, path: string, name?: string): AgentDef {
  // Its encoding names no value from the file, so it is the one reason given.
  const encoding = utf16Problem(bytes.toString("utf8"));
  if (encoding) throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid persona definition: ${path}: ${encoding}`, { remedy: `save ${path} as UTF-8` });
  let def: AgentDef;
  try { def = parseAgentFileSource(bytes.toString("utf8"), path); }
  catch (error) { throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid persona definition ${path}: ${definitionProblem(error, path)}`, { remedy: "check the agent-file frontmatter and channel declarations" }); }
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
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", `the persona catalog ${dir} is not writable; nothing was changed`, { remedy: `make it writable with \`chmod u+w ${shellWord(dir)}\` to change its personas` }); }
}

/** The largest persona definition the CLI saves, the bound a create on a manager applies to its input. */
export const PERSONA_LIMIT = 1024 * 1024;

/** The refusal of a definition over {@link PERSONA_LIMIT}, the same for create and edit. */
function tooLarge(bytes: Buffer, remedy: string): CommandFailure | undefined {
  return bytes.length > PERSONA_LIMIT ? new CommandFailure("refused", "SCHEMA_INVALID", `the persona definition is ${bytes.length} bytes, over the 1 MiB limit, so it was not saved`, { remedy }) : undefined;
}

/** The persona whose file name differs from `path`'s only in case. A case-insensitive file system
 *  holds the two as one file. */
function caseTwin(path: string): string | undefined {
  const file = basename(path);
  const twin = readdirSync(dirname(path)).find(entry => entry !== file && entry.toLowerCase() === file.toLowerCase());
  return twin === undefined ? undefined : basename(twin, ".md");
}

/** Shared by canonical and legacy CLI writes only. Manager and external writers do not take this lock.
 *  A new persona whose name differs from an existing one only in case is refused. */
export function commitPersona(path: string, expected: PersonaSource | undefined, bytes: Buffer | undefined): void {
  const oversized = bytes && tooLarge(bytes, "shorten its instructions to 1 MiB or less");
  if (oversized) throw oversized;
  const dir = dirname(path);
  assertCatalogWritable(dir);
  mkSecretDir(dir);
  const lockPath = join(realpathSync(dirname(path)), `.${basename(path)}.lock`);
  const lock = acquireLock(lockPath, { label: "local persona write", onTimeout: () => new CommandFailure("refused", "CONFLICT", "another local persona write holds the catalog lock") });
  try {
    const current = readPersonaSource(path);
    if (!sameSource(expected, current))
      throw new CommandFailure("refused", "CONFLICT", `persona ${current === undefined ? "was removed" : "changed"} while the operation was open: ${path}`, { remedy: current === undefined ? "list the catalog with `cotal persona` and retry" : "read the current definition and retry" });
    const twin = current === undefined && bytes !== undefined ? caseTwin(path) : undefined;
    if (twin !== undefined)
      throw new CommandFailure("refused", "CONFLICT", `persona '${basename(path, ".md")}' differs from the existing '${twin}' only in case; nothing was written`, { remedy: `choose another name, or change the existing one with cotal persona edit ${twin}` });
    if (bytes === undefined) unlinkSync(path);
    else writeSecretFileAtomic(path, bytes);
  } finally { lock.release(); }
}

/** A new private folder for a draft in the temporary directory. A temporary directory this account
 *  cannot write, or one that is missing or not a folder, is refused by name before anything is made. */
function draftFolder(): string {
  const parent = tmpdir();
  try { return mkdtempSync(join(parent, "cotal-persona-")); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS")
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the temporary directory ${parent} is not writable by this account (${code}), so no private draft was made; nothing was changed`, { target: { path: parent }, remedy: `make ${parent} writable by you, or set TMPDIR to a folder you own` });
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the temporary directory ${parent} ${code === "ENOENT" ? "does not exist" : "is not a directory"}, so no private draft was made; nothing was changed`, { target: { path: parent }, remedy: "set TMPDIR to an existing folder you own, or unset it" });
    throw error;
  }
}

/** Own a private draft and remove only that draft. A cleanup failure is not a successful operation.
 *  When `keep` says so, the draft stays in place, because it holds work that was not saved. */
async function withDraft<T>(name: string, action: (path: string) => T | Promise<T>, keep?: () => boolean): Promise<T> {
  const dir = draftFolder();
  let kept = false;
  try {
    hardenPrivate(dir, "dir");
    const value = await action(join(dir, `${name}.md`));
    kept = keep?.() === true;
    return value;
  }
  catch (error) {
    kept = keep?.() === true;
    throw error;
  }
  finally {
    if (!kept) {
      try { rmSync(dir, { recursive: true }); }
      catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", `cannot remove private persona draft: ${dir}`, { changed: [{ kind: "private-draft", path: dir }], remedy: "remove the private draft after reviewing the operation outcome" }); }
    }
  }
}

/** Refuse a `--role` or `--model` that holds control characters by name, before any rule quotes it. */
export function assertLabels(values: { role?: string; model?: string }): void {
  for (const [flag, value] of [["--role", values.role], ["--model", values.model]] as const)
    if (value !== undefined && /[\u0000-\u001f\u007f]/u.test(value))
      throw new CommandFailure("refused", "USAGE_INVALID", `${flag} takes a label without control characters`);
}

/** Use the existing serializer for flag-built definitions; file inputs keep their original bytes. */
export function serializePersona(def: AgentDef): Promise<Buffer> {
  assertLabels(def);
  if (def.model !== undefined && !def.model.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "--model is empty", { remedy: "name a model, or leave --model out for the application default" });
  return withDraft(def.name, path => {
    try { writeSecretFile(path, ""); saveAgentFile(path, def); }
    catch (error) { throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid persona fields: ${(error as Error).message.replace(/^saveAgentFile: /, "")}`); }
    const bytes = readFileSync(path);
    validatePersona(bytes, path, def.name);
    return bytes;
  });
}

/** The editor value as a program, when it names an existing file by path: it runs with no shell, so a
 *  path that holds spaces needs no quoting. Any other value runs as a shell command. */
function editorProgram(editor: string): string | undefined {
  if (!editor.includes("/") && !editor.includes(sep)) return undefined;
  try { return statSync(editor).isFile() ? editor : undefined; }
  catch { return undefined; }
}

/** How the editor ended, and the first signal the CLI received while it ran. */
interface EditorExit { status: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException; received?: InterruptSignal }

/** Run the editor on the draft and wait for it to exit. A SIGINT, SIGTERM or SIGHUP the CLI receives
 *  meanwhile is passed to the editor, so the editor does not outlive the CLI. */
function runEditor(editor: string, draft: string): Promise<EditorExit> {
  const program = editorProgram(editor);
  const quoted = process.platform === "win32" ? `"${draft.replaceAll('"', '""')}"` : `'${draft.replaceAll("'", "'\\''")}'`;
  let received: InterruptSignal | undefined;
  // The editor starts running as soon as it is spawned, so the CLI holds the signals first.
  const pass = (signal: InterruptSignal) => { received ??= signal; child.kill(signal); };
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, pass);
  const child = program ? spawn(program, [draft], { stdio: "inherit" }) : spawn(`${editor} ${quoted}`, { shell: true, stdio: "inherit" });
  return new Promise(resolve => {
    const done = (exit: EditorExit) => {
      for (const signal of INTERRUPT_SIGNALS) process.off(signal, pass);
      resolve({ ...exit, ...(received ? { received } : {}) });
    };
    // An error after a successful start is a failed kill; the exit still follows.
    child.once("error", error => { if (child.pid === undefined) done({ status: null, signal: null, error }); });
    child.once("exit", (status, signal) => done({ status, signal }));
  });
}

/** What an edit did. An editor that exits non-zero cancels it, as vim's `:cq` does; a draft it changed
 *  is kept. A draft left as it was saves nothing. */
export type PersonaEdit = { action: "saved" } | { action: "unchanged" } | { action: "cancelled"; status: number; draft?: string };

/** Never expose the catalog file to an editor. Validate successful draft bytes, then compare under lock.
 *  An interrupt that stops the edit saves nothing, removes an unchanged draft, names a changed one, and
 *  exits with the signal's code. */
export async function editPersona(path: string, name: string, catalog: PersonaCatalog, json = false): Promise<PersonaEdit> {
  if (json || inputDisabledByFlag())
    throw new ConfirmationRequired("persona edit opens an editor, --no-input forbids one, as does --json", { remedy: "edit interactively without --json or --no-input" });
  const source = requirePersonaSource(path);
  validatePersona(source.bytes, path);
  assertCatalogWritable(dirname(path));
  const editor = resolvePreference("editor", { preferences: cachedPreferences(), space: catalog.space }).value;
  if (!editor) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "no editor is set", { remedy: "set VISUAL or EDITOR, or run `cotal config set editor vim`" });
  // A draft the editor may have changed and that was not saved is kept, and the failure names it.
  let keep = false;
  const edit = await withDraft(name, async (draft): Promise<PersonaEdit | { action: "interrupted"; signal: InterruptSignal; draft?: string }> => {
    writeSecretFile(draft, source.bytes);
    const result = await runEditor(editor, draft);
    // SIGTERM or SIGHUP stops the edit. Ctrl-C reaches the editor too, and stops the edit only when
    // it ends the editor, since an editor such as vim takes Ctrl-C as a key.
    if (result.received && (result.received !== "SIGINT" || result.signal)) {
      keep = readPersonaSource(draft)?.bytes.equals(source.bytes) === false;
      return { action: "interrupted", signal: result.received, ...(keep ? { draft } : {}) };
    }
    // A POSIX shell exits 127 when it finds no such command and 126 when it cannot run it: the editor
    // is missing, as it is when none is set, and nothing was edited. A program that cannot be run is
    // refused the same way.
    if (result.error?.code === "EACCES")
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the editor ${JSON.stringify(editor)} could not be run - not saved`, { remedy: `make ${editor} executable, or set VISUAL or EDITOR to an installed editor` });
    if (process.platform !== "win32" && !result.error && (result.status === 127 || result.status === 126))
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the editor ${JSON.stringify(editor)} ${result.status === 127 ? "was not found" : "could not be run"} - not saved`, {
        remedy: "set VISUAL or EDITOR to an installed editor, or run `cotal config set editor vim`; a value that is not the path of an existing file runs as a shell command, so quote a path that holds spaces",
      });
    if (result.error) throw new CommandFailure("failed", "OPERATION_FAILED", "the editor could not be started - not saved");
    if (result.signal) {
      keep = true;
      throw new CommandFailure("failed", "OPERATION_FAILED", `editor ended on ${result.signal} - not saved`, {
        remedy: `your draft is kept in ${draft}; remove ${dirname(draft)} when you are done`,
      });
    }
    if (result.status !== 0) {
      keep = readPersonaSource(draft)?.bytes.equals(source.bytes) === false;
      return { action: "cancelled", status: result.status ?? 1, ...(keep ? { draft } : {}) };
    }
    const edited = requirePersonaSource(draft).bytes;
    if (edited.equals(source.bytes)) return { action: "unchanged" };
    const oversized = tooLarge(edited, `your edit is kept in ${draft}; shorten it to 1 MiB or less, run cotal persona edit ${name} again and paste it in, then remove ${dirname(draft)}`);
    if (oversized) { keep = true; throw oversized; }
    try { validatePersona(edited, draft); }
    catch (error) {
      if (!isCommandFailure(error)) throw error;
      keep = true;
      throw new CommandFailure("refused", "SCHEMA_INVALID", `${error.message} - not saved`, {
        remedy: `your edit is kept in ${draft}; correct it, run cotal persona edit ${name} again and paste it in, then remove ${dirname(draft)}`,
      });
    }
    try { commitPersona(path, source, edited); }
    catch (error) {
      if (!isCommandFailure(error) || error.code !== "CONFLICT") throw error;
      // The edit was not saved, so the draft stays and the refusal says where it is.
      const removed = readPersonaSource(path) === undefined;
      keep = true;
      throw new CommandFailure("refused", "CONFLICT", error.message, {
        remedy: `your edit is kept in ${draft}; ${removed ? `restore it with \`cotal persona create ${name} --file ${draft}\`` : `compare it with \`cotal persona show ${name}\`, then edit again`}, and remove ${dirname(draft)} when you are done`,
      });
    }
    return { action: "saved" };
  }, () => keep);
  if (edit.action === "interrupted") {
    exitInterrupted(edit.signal, edit.draft
      ? `Interrupted while the editor was open, so nothing was saved. Your draft is kept in ${edit.draft}; remove ${dirname(edit.draft)} when you are done.`
      : `Interrupted while the editor was open, so nothing was saved and ${name} is unchanged.`);
  }
  return edit;
}
