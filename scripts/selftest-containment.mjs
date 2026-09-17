/**
 * Containment for a self-test's own recursive cleanup.
 *
 * A self-test creates its working directory with `mkdtempSync(join(tmpdir(), ...))` and removes it
 * in a `finally`. Under a mutation run the directory helper is itself under test, so a mutant that
 * made the helper return the PARENT of the directory it created handed `tmpdir()` to that cleanup,
 * which then walked the shared temp directory and unlinked every entry it could reach. Among them
 * were the listening control sockets of every connector on the host, whose sessions kept a listener
 * on an unlinked path and lost their whole tool surface until respawn (#1625).
 *
 * So a cleanup may only remove the directory it was GIVEN by `mkdtemp`, and only where that
 * directory resolves strictly beneath the base it was created in. A guard that fails refuses to
 * delete and exits 2: an escaped cleanup is a defect in the suite, not something to clean up after.
 */
import { realpathSync, rmSync } from "node:fs";
import { sep } from "node:path";

/** The reason `dir` may not be removed, or undefined when the removal is contained. */
export function containmentRefusal(dir, base, created) {
  if (dir !== created) return `cleanup target ${dir} is not the path mkdtemp returned (${created})`;
  let realDir;
  let realBase;
  try {
    realDir = realpathSync(dir);
    realBase = realpathSync(base);
  } catch (error) {
    return `cleanup target ${dir} could not be resolved against ${base}: ${error.message}`;
  }
  if (!realDir.startsWith(realBase + sep)) return `cleanup target ${realDir} is not strictly beneath ${realBase}`;
  return undefined;
}

/**
 * Remove a self-test's own `mkdtemp` directory, or refuse and exit 2.
 *
 * `created` is the exact string `mkdtempSync` returned; `base` is the directory it was created in.
 */
export function removeSelfTestDir(dir, base, created) {
  const refusal = containmentRefusal(dir, base, created);
  if (refusal !== undefined) {
    console.error(`\nREFUSING to clean up: ${refusal}`);
    console.error("A recursive delete outside its own mkdtemp root would take other processes' files with it.");
    process.exit(2);
  }
  rmSync(dir, { recursive: true, force: true });
}
