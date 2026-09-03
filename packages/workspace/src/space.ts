import { DEFAULT_SPACE } from "@cotal-ai/core";
import { authDir, findCotalRoot, soleSpaceOf } from "./auth-paths.js";
import { recordedRuntimeSpaces } from "./local-process.js";

/** The space this folder operates on: its `.cotal/auth` space if set up, else the default.
 *  Commands resolve it through here so they always match the folder's mesh instead of assuming the
 *  global default. A root that has grown to hold SEVERAL space accounts makes this question
 *  ambiguous, and {@link soleSpaceOf} fails loud there rather than picking one - such a caller has
 *  to name its space (`--space`). */
export function resolveSpace(cwd: string): string {
  return soleSpaceOf(authDir(findCotalRoot(cwd))) ?? DEFAULT_SPACE;
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
