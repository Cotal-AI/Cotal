import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateRecord } from "@cotal-ai/core";
import { personaDir } from "@cotal-ai/workspace";

/** The default persona `cotal spawn` (no name) launches: a generic mesh agent, seeded once and
 *  then the user's to shape. Unlike the demo team it is not generally refreshed; only the
 *  byte-exact legacy template below is migrated, so any edit stands. Deleting it means the next
 *  `cotal setup` or local `cotal up` writes a fresh copy.
 *
 *  Channel scope is split intentionally: the ACTIVE set (`subscribe`) is EMPTY, so a fresh agent
 *  isn't firehosed every channel on the mesh at boot, while the read and post ACLs permit it to
 *  join, create, read, and post channels on demand. (`subscribe: [">"]` would auto-subscribe to
 *  every channel, the old behavior.) */
export const DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: []
allowSubscribe: [">"]
allowPublish: [">"]
capabilities: [spawn, run]
---

You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and
coordinate as peers rather than working in silos. Use the Cotal tools available to you to find
your peers and work with them. Edit this file to give yourself a name, role, and purpose.
`;

/** The byte-exact default template shipped before wildcard post permission. Keep this frozen: a
 *  future edit to the current template must not make an older untouched file ineligible for repair. */
export const LEGACY_DEFAULT_AGENT = [
  "---",
  "name: default_agent",
  "role: default",
  "description: An agent on the mesh",
  "tags: []",
  "subscribe: []",
  'allowSubscribe: [">"]',
  "allowPublish: []",
  "capabilities: [spawn]",
  "---",
  "",
  "You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and",
  "coordinate as peers rather than working in silos. Use the Cotal tools available to you to find",
  "your peers and work with them. Edit this file to give yourself a name, role, and purpose.",
  "",
].join("\n");

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
  mkdirSync(dirname(path), { recursive: true });
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

/** The command that puts a missing default persona back into a space's catalog. A space this
 *  machine started gets it from `up` run in its root, named as `cwd`; any other space needs the
 *  file created in its catalog. */
export function defaultPersonaFix(space: { space: string; root: string; origin?: string | null }, cmd = "cotal"): { command: string; cwd?: string } {
  return space.origin === "up"
    ? { command: `${cmd} up`, cwd: space.root }
    : { command: `${cmd} persona create default --space ${space.space} --file <persona.md>` };
}
