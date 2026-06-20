import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAgentFile, type AgentDef } from "@cotal-ai/core";
import { cotalRoot } from "./paths.js";

/**
 * The persona catalog: the local `.cotal/agents/*.md` files an operator manages with
 * `cotal personas` and spawns by name. Filesystem-only and side-effect-free — it never
 * touches the mesh — so it is safe to call from a <TAB> completion as well as from `list`.
 * The single source of truth for "what personas exist", shared by both surfaces.
 */
export interface PersonaEntry {
  /** The filename stem (`.cotal/agents/<name>.md`), which is also the spawn name. */
  name: string;
  path: string;
  /** Parsed definition, or undefined when the file failed to parse (see `error`). */
  def?: AgentDef;
  /** Parse error message, if the file is malformed — surfaced rather than crashing the list. */
  error?: string;
}

/** The directory persona files live in: `<root>/.cotal/agents`. */
export function personasDir(root = cotalRoot()): string {
  return join(root, ".cotal", "agents");
}

/** List the persona files, each parsed (a malformed file becomes an entry with `error`, not a
 *  throw). Returns `[]` when the directory is absent. Filesystem-only — no mesh, no network. */
export function listPersonas(root = cotalRoot()): PersonaEntry[] {
  const dir = personasDir(root);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return []; // no .cotal/agents yet — an empty catalog, not an error
  }
  return files.sort().map((f) => {
    const name = f.slice(0, -3);
    const path = join(dir, f);
    try {
      return { name, path, def: loadAgentFile(path) };
    } catch (e) {
      return { name, path, error: (e as Error).message };
    }
  });
}

/** Just the persona names — the completion source for `cotal spawn` and `personas show/rm`. */
export function listPersonaNames(root = cotalRoot()): string[] {
  return listPersonas(root).map((p) => p.name);
}
