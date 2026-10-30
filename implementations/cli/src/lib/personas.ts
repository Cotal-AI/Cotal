import { accessSync, constants, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAgentFile, personaDir, utf16Problem, type AgentDef } from "@cotal-ai/core";
import { codeSpan, CommandFailure, unsearchableFolder } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";

/**
 * The persona catalog: the local `.cotal/agents/*.md` files an operator manages with
 * `cotal personas` and spawns by name. Filesystem-only and side-effect-free — it never
 * touches the mesh — so it is safe to call from a <TAB> completion as well as from `list`.
 * The single source of truth for "what personas exist", shared by both surfaces.
 *
 * `root` IS REQUIRED ON EVERY EXPORT HERE, and deliberately has no default.
 *
 * It used to default to `cotalRoot()` — the directory the cwd walks up to. That reads as a
 * convenience and behaves as a trap: "which personas exist" is not a property of where the
 * operator happens to be standing, it is a property of the MESH the command acts on, and the two
 * disagree the moment a mesh is selected (`cotal use`) or named (`--space`) from another project.
 * Because the default was silent, a caller that forgot to pass a root did not fail — it answered
 * confidently about the wrong directory. Measured at ccd99461: from one cwd, `cotal personas`
 * listed that directory's catalog while `cotal spawn` — the one caller that passed `target.root`
 * — launched only from the resolved mesh's. The two sets had zero members in common, and neither
 * surface said anything was wrong.
 *
 * So the argument is required, and forgetting it is a compile error (TS2554) instead of a wrong
 * answer at runtime. A caller that genuinely wants the cwd-derived root says so out loud by
 * passing `cotalRoot()`; a caller acting on a mesh passes that mesh's `target.root`. This module
 * does not import `cotalRoot` at all, precisely so it cannot quietly reintroduce the fallback.
 */
export interface PersonaEntry {
  /** The filename stem (`.cotal/agents/<name>.md`), which is also the spawn name. */
  name: string;
  path: string;
  /** Parsed definition, or undefined when the file failed to parse (see `error`). */
  def?: AgentDef;
  /** Parse error message, if the file is malformed — surfaced rather than crashing the list. */
  error?: string;
  /** Why the file cannot be read when it was saved as UTF-16: the one parse reason that quotes nothing
   *  from the file, so a list that keeps `error` private can still name it. */
  encoding?: string;
  /** Set when the file is not a regular file, such as a FIFO, so it was not opened (see `error`). */
  notRegular?: true;
  /** The file a persona that is a symbolic link names. `persona show`, `edit` and `remove` refuse
   *  a link, so a listing warns about it. */
  link?: string;
}

/** The refusal for a catalog folder `dir` that exists but is no folder, such as a file or a link that
 *  loops, which holds no personas. Undefined for a folder, or when nothing is there. */
export function catalogFolderProblem(dir: string): CommandFailure | undefined {
  let what: string;
  try {
    if (statSync(dir).isDirectory()) return undefined;
    const own = lstatSync(dir);
    what = own.isSymbolicLink() ? "a link to something that is not a folder" : own.isFile() ? "a file, not a folder" : "not a folder";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOOP") return undefined;
    what = "a link that loops back on itself";
  }
  return new CommandFailure("refused", "CONFLICT", `${dir} is ${what}, so it holds no personas`, {
    remedy: `move ${dir} out of the way; \`cotal persona create <name>\` then makes the folder`,
  });
}

/** The refusal for a catalog folder `dir` that {@link readPersonas} could not read. Its next step
 *  names a chmod only for a folder this account owns whose owner bits lack read or search. A folder
 *  above it that this account cannot enter, or a folder another account owns, is named without one,
 *  and any other error is refused without a step. */
export function catalogReadRefusal(dir: string, error: unknown): CommandFailure {
  const refusal = (remedy?: string) => new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona catalog: ${dir}`, remedy ? { remedy } : {});
  const code = (error as NodeJS.ErrnoException).code;
  if ((code !== "EACCES" && code !== "EPERM") || process.getuid === undefined) return refusal();
  const above = unsearchableFolder(dir);
  if (above) return refusal(`this account cannot enter ${above}, which holds the catalog; get access to that folder from its owner, then run the command again`);
  let owner: number, mode: number;
  try { ({ uid: owner, mode } = statSync(dir)); } catch { return refusal(); }
  if (owner !== process.getuid()) return refusal("another account owns this folder; ask its owner to let this account read it");
  return (mode & 0o500) === 0o500 ? refusal() : refusal(`make it readable by you with ${codeSpan(`chmod u+rx ${shellWord(dir)}`)}`);
}

/** The file `path` links to when it is a symbolic link: its resolved path, or the link's own text
 *  when that does not resolve. Undefined for anything else. */
export function linkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  try { return realpathSync(path); } catch { /* a dangling link or a loop */ }
  try { return readlinkSync(path); } catch { return undefined; }
}

/** List the persona files, each parsed (a malformed file becomes an entry with `error`, not a
 *  throw). Returns `[]` when the directory is absent. Filesystem-only — no mesh, no network. */
export function listPersonas(root: string): PersonaEntry[] {
  try {
    return readPersonas(root);
  } catch {
    return []; // absent, or unreadable: this caller lists either as an empty catalog
  }
}

/** {@link listPersonas}, except that only an absent directory is an empty catalog: one that exists
 *  and cannot be read throws, for a report that must not show it as empty. So does one that lists
 *  but cannot be searched, such as mode 0600, whose files cannot be opened however they are written. */
export function readPersonas(root: string): PersonaEntry[] {
  const dir = personaDir(root);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    accessSync(dir, constants.X_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return files.sort().map((f) => {
    const name = f.slice(0, -3);
    const path = join(dir, f);
    const link = linkTarget(path);
    try {
      // A FIFO or a device would block the read, so only a regular file is opened. A link is
      // followed, as the read follows it.
      if (!statSync(path).isFile()) return { name, path, error: `persona is not a regular file: ${path}`, notRegular: true as const, ...(link !== undefined ? { link } : {}) };
      return { name, path, def: loadAgentFile(path), ...(link !== undefined ? { link } : {}) };
    } catch (e) {
      let encoding: string | undefined;
      try { encoding = utf16Problem(readFileSync(path, "utf8")); } catch { /* unreadable: `error` says so */ }
      return { name, path, error: (e as Error).message, ...(encoding ? { encoding } : {}), ...(link !== undefined ? { link } : {}) };
    }
  });
}

/** Just the persona names: the completion source for `cotal spawn`, `persona show` and `personas
 *  show/rm`. Only an absent folder is an empty catalog. One that cannot be read throws an error that
 *  names it, so the completion offers nothing and COTAL_COMPLETE_DEBUG says why. */
export function listPersonaNames(root: string): string[] {
  return completionPersonas(root).map((p) => p.name);
}

/** {@link readPersonas} for a completion: a catalog folder that cannot be read throws an error that
 *  names it. */
function completionPersonas(root: string): PersonaEntry[] {
  try {
    return readPersonas(root);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`cannot read the persona catalog ${personaDir(root)}: ${code === "EACCES" || code === "EPERM" ? "permission denied" : code ?? (e as Error).message}`);
  }
}

/** Collect a deduped, sorted set of values declared across every persona file, via `pick`.
 *  Fail-closed: a catalog folder that cannot be read, or a single malformed file, throws — the
 *  aggregate can't be trusted, so a derived completer must fail rather than offer a silently-partial
 *  or empty set. COTAL_COMPLETE_DEBUG prints the reason, and `cotal persona` names the broken file. */
function declaredValues(root: string, pick: (def: AgentDef) => (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const e of completionPersonas(root)) {
    if (e.error) throw new Error(`persona "${e.name}" is unparseable: ${e.error}`);
    for (const v of pick(e.def!)) if (v) out.add(v);
  }
  return [...out].sort();
}

/** Channels the persona files declare (`subscribe` ∪ `allowSubscribe` ∪ `allowPublish`), as the
 *  completion source for `cotal msg`/`send`. Wildcard ACL scopes (`team.>`, `*`) are excluded —
 *  they're read/post patterns, not concrete send targets. Authoritative-for-intent, not a claim the
 *  channel exists on the broker. Fail-closed via {@link declaredValues}. Filesystem-only — no mesh. */
export function listDeclaredChannels(root: string): string[] {
  return declaredValues(root, (d) => [
    ...(d.subscribe ?? []),
    ...(d.allowSubscribe ?? []),
    ...(d.allowPublish ?? []),
  ]).filter((ch) => !ch.includes(">") && !ch.includes("*"));
}

/** Roles the persona files declare (the `role:` field), as the completion source for
 *  `cotal ask`/`anycast`. Fail-closed via {@link declaredValues}. Filesystem-only — no mesh. */
export function listDeclaredRoles(root: string): string[] {
  return declaredValues(root, (d) => [d.role]);
}
