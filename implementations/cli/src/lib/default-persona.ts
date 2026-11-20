import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateRecord, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { DEFAULT_AGENT, LEGACY_DEFAULT_AGENT, personaDir } from "@cotal-ai/workspace";
import { mkdirPrivate } from "./private-directory.js";
export { DEFAULT_AGENT, LEGACY_DEFAULT_AGENT } from "@cotal-ai/workspace";

/** The name the seeded default persona's agents launch under, as its template declares. */
export const DEFAULT_AGENT_NAME = "default_agent";

/** Return the shipped replacement only for the byte-exact legacy default. Any user edit, including
 *  whitespace or frontmatter changes, keeps the persona under user ownership. Exported so the
 *  static template smoke can grade the upgrade decision without touching real setup state. */
export function migrateLegacyDefaultAgent(current: string): string | undefined {
  return current === LEGACY_DEFAULT_AGENT ? DEFAULT_AGENT : undefined;
}

export function reconcileDefaultAgent(path: string): "seeded" | "migrated" | "unchanged" {
  if (existsSync(path)) {
    const replacement = migrateLegacyDefaultAgent(readFileSync(path, "utf8"));
    if (replacement === undefined) return "unchanged";
    writePrivateRecord(path, replacement);
    return "migrated";
  }
  mkdirPrivate(dirname(path));
  writePrivateRecord(path, DEFAULT_AGENT);
  return "seeded";
}

/** Seed the default persona into `<root>/.cotal/agents`: write it when the root has none, and upgrade
 *  only the byte-exact legacy template. `cotal setup`, `cotal space create` and a local `cotal up`
 *  all call this, so a space has its default however it was prepared. Returns the write, or
 *  nothing when the file stands as it was. */
export function seedDefaultPersona(root: string): { what: string; path: string } | undefined {
  const path = join(personaDir(root), "default.md");
  const seeded = reconcileDefaultAgent(path);
  if (seeded === "unchanged") return undefined;
  return { what: seeded === "seeded" ? "default persona" : "updated default persona permissions", path };
}

/** Write the shipped default persona into `<root>/.cotal/agents/default.md` for a launch of the
 *  implicit default that found none there, as a catalog no setup or up prepared has none. Create-only:
 *  a file that appears meanwhile is kept and loaded as it stands. Returns the path written, or
 *  undefined when the file was already there. */
export function writeDefaultPersonaForLaunch(root: string): string | undefined {
  const path = join(personaDir(root), "default.md");
  mkdirPrivate(dirname(path));
  try {
    writeSecretFileCreateOnly(path, DEFAULT_AGENT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }
  return path;
}

/** The command that puts a missing default persona back into a space's catalog. A space this
 *  machine started gets it from `up` run in its root, named as `cwd`; any other space needs the
 *  file created in its catalog. */
export function defaultPersonaFix(space: { space: string; root: string; origin?: string | null }, cmd = "cotal"): { command: string; cwd?: string } {
  return space.origin === "up"
    ? { command: `${cmd} up`, cwd: space.root }
    : { command: `${cmd} persona create default --space ${space.space} --file <persona.md>` };
}
