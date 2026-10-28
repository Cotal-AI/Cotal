import { lstatSync, statSync } from "node:fs";
import { listPersonaCatalog, personaDir, readPersonaCatalog, type AgentDef } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";

// The persona catalog readers in the CLI: thin helpers over `@cotal-ai/core`'s
// `listPersonaCatalog` and `readPersonaCatalog`. `root` is required on every export here and
// deliberately has no default, so a caller cannot silently read the cwd's catalog instead of the
// resolved mesh's.

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

/** Just the persona names: the completion source for `cotal spawn`, `persona show` and `personas
 *  show/rm`. Only an absent folder is an empty catalog. One that cannot be read throws an error that
 *  names it, so the completion offers nothing and COTAL_COMPLETE_DEBUG says why. */
export function listPersonaNames(root: string): string[] {
  try {
    return readPersonaCatalog(root).map((p) => p.name);
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
  for (const e of listPersonaCatalog(root)) {
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
