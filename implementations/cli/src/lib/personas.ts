import { lstatSync, statSync } from "node:fs";
import { personaDir, personaLinkTarget, listPersonaCatalog, readPersonaCatalog, type AgentDef, type PersonaCatalogEntry } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";

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
 *
 * The walk itself is {@link readPersonaCatalog} in core, which the manager's catalog reads too.
 * This module keeps the operator-facing refusals and the completion readers over that one walk.
 */

/** One catalog row, as {@link readPersonaCatalog} reads it. */
export type PersonaEntry = PersonaCatalogEntry;

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
    remedy: `move ${dir} out of the way; cotal persona create <name> then makes the folder`,
  });
}

/** The file `path` links to when it is a symbolic link, as {@link personaLinkTarget} reads it. */
export function linkTarget(path: string): string | undefined {
  return personaLinkTarget(path);
}

/** List the persona files, each parsed (a malformed file becomes an entry with `error`, not a
 *  throw). A directory that is absent, or that exists and cannot be read, is an empty catalog:
 *  this caller lists either as empty. */
export function listPersonas(root: string): PersonaEntry[] {
  return listPersonaCatalog(root);
}

/** {@link listPersonas}, except that only an absent directory is an empty catalog: one that exists
 *  and cannot be read throws, for a report that must not show it as empty. */
export function readPersonas(root: string): PersonaEntry[] {
  return readPersonaCatalog(root);
}

/** Just the persona names: the completion source for `cotal spawn`, `persona show` and `personas
 *  show/rm`. Only an absent folder is an empty catalog. One that cannot be read throws an error that
 *  names it, so the completion offers nothing and COTAL_COMPLETE_DEBUG says why. */
export function listPersonaNames(root: string): string[] {
  try {
    return readPersonas(root).map((p) => p.name);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`cannot read the persona catalog ${personaDir(root)}: ${code === "EACCES" || code === "EPERM" ? "permission denied" : code ?? (e as Error).message}`);
  }
}

/** Collect a deduped, sorted set of values declared across every persona file, via `pick`.
 *  Fail-closed: a single malformed file throws — the aggregate can't be trusted, so a derived
 *  completer must decline rather than offer a silently-partial set. The broken file is named loudly
 *  by `cotal personas list`, so the error stays visible; it's just not buried in a <TAB>. */
function declaredValues(root: string, pick: (def: AgentDef) => (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const e of listPersonas(root)) {
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
