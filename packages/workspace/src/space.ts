import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SPACE } from "@cotal-ai/core";
import { authDir, findCotalRoot, soleSpaceOf, stackJournalPath } from "./auth-paths.js";
import { recordedRuntimeSpaces } from "./local-process.js";
import { canonicalRoot, homeCotalDir, meshesForRoot } from "./mesh-registry.js";
import { preparedSpaceAt } from "./prepared-spaces.js";

/** The space this folder operates on: its `.cotal/auth` space if set up, else the space
 *  `cotal space create` prepared here, else the default. Commands resolve it through here so they
 *  always match the folder's mesh instead of assuming the global default. A root that has grown to
 *  hold SEVERAL space accounts makes this question ambiguous, and {@link soleSpaceOf} fails loud
 *  there rather than picking one - such a caller has to name its space (`--space`). */
export function resolveSpace(cwd: string): string {
  const root = findCotalRoot(cwd);
  return soleSpaceOf(authDir(root)) ?? preparedSpaceAt(root)?.space ?? DEFAULT_SPACE;
}

/** Whether this project's `.cotal/` holds records but names no space: no account, prepared space,
 *  registration, stack journal, daemon record or broker configuration. That is the folder of a
 *  prepared space that was forgotten or moved, or one where only a persona was written. A `.cotal/`
 *  that is empty, or none, names nothing. */
export function rootNamesNoSpace(root: string): boolean {
  const control = join(root, ".cotal");
  let entries: string[];
  try { entries = readdirSync(control); } catch { return false; }
  if (!entries.length || canonicalRoot(control) === canonicalRoot(homeCotalDir())) return false;
  try {
    if (soleSpaceOf(authDir(root)) !== undefined) return false;
  } catch { return false; }
  return !preparedSpaceAt(root) && !meshesForRoot(root).length && !existsSync(stackJournalPath(root)) && !recordedRuntimeSpaces(root).length
    && !existsSync(join(control, "server-open.conf")) && !existsSync(join(authDir(root), "server.conf"));
}

/**
 * The space THIS FOLDER'S LOCAL DAEMONS belong to: the one its runtime records name, else
 * {@link resolveSpace}.
 *
 * `down`, `status` and every "is the manager up" helper ask this. They must not inherit
 * {@link resolveSpace}'s blind spot: it reads the space from the `.cotal/auth` account records, an
 * OPEN mesh has none, and the default it then answers with is not the space the daemons here run
 * under. The records are consulted FIRST because they are the only source that always knows - a
 * daemon started by a container entrypoint or by `cotal supervise` typed by hand has one, whatever
 * else the root does or does not hold.
 *
 * RESIDUE NEVER WEDGES THE FOLDER, and TWO LIVE STACKS ARE REFUSED. A record left by a crash names
 * a space whose daemon is gone; if another space is running here, the running one is the answer, and
 * a dead record alone still names its space so a stop can clear it. Two spaces running under one
 * root is a state this cannot arbitrate - the broker, its store and this folder's stack are shared,
 * so no single answer is right - and it throws rather than picking one, the same refusal
 * `assertSingleSpaceBroker` makes for the tenants it can see.
 */
export function resolveRuntimeSpace(cwd: string): string {
  const root = findCotalRoot(cwd);
  const recorded = recordedRuntimeSpaces(root);
  const running = recorded.filter((r) => r.mayBeRunning);
  if (running.length > 1)
    throw new Error(
      `${root}/.cotal records running daemons for ${running.length} spaces (${running.map((r) => r.space).join(", ")}) - this folder's stack is not one mesh and a folder-wide command cannot scope to one; stop them by name (\`cotal down\` in each mesh's own root) or remove the record of the one that is gone`,
    );
  if (running.length === 1) return running[0].space;
  if (recorded.length === 1) return recorded[0].space; // dead residue, unambiguous: still this folder's space
  return resolveSpace(cwd);
}

/** What a space's broker store holds, all of which removing the store removes, as `reset store` and
 *  `reset space` do. They are named, not listed: a stopped broker is the only reader of its store. */
export const STORE_CONTENTS = ["workflow runs and their journals", "channel history", "stored messages", "every other record the broker kept there"];

/** {@link STORE_CONTENTS} as one phrase. */
export const storeContentsText = (items: readonly string[]) => `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
