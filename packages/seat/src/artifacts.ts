import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Every launch artifact directory name starts with this (core launch-artifacts). Repeated here
 *  because this package depends on nothing else in the repo, and it guards a recursive removal. */
const DIR_PREFIX = "cotal-";

/**
 * Remove a seat's launch artifacts (the record's `artifacts`). Called only where this package
 * can prove the seat's child gone or never started: the custodian when it observes its child's exit
 * or fails to start one, the launcher when it refuses before any process exists, and the reap once it
 * has proved the seat gone. Losing a connection to the custodian proves none of these, so nothing on
 * the client side calls this.
 *
 * `root` is the temp dir of the process that wrote them (the record's `artifactRoot`). Refuses,
 * before removing anything, a path that is not a `cotal-` directory directly under it. Otherwise it
 * tries every directory and then throws naming each one it could not remove, so the caller can keep
 * those owned and try again.
 */
export function discardSeatArtifacts(artifacts: readonly string[] | undefined, root: string | undefined): void {
  if (!artifacts?.length) return;
  if (root === undefined) throw new Error(`refusing to remove launch artifacts ${artifacts.join(", ")}: no temp dir recorded for them`);
  const base = resolve(root);
  for (const dir of artifacts) {
    if (dirname(resolve(dir)) !== base || !basename(dir).startsWith(DIR_PREFIX))
      throw new Error(`refusing to remove launch artifact ${dir}: not a ${DIR_PREFIX}* directory directly under ${base}`);
  }
  const failed: string[] = [];
  for (const dir of artifacts) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      failed.push(`${dir} (${(e as Error).message})`);
    }
  }
  if (failed.length) throw new Error(`could not remove launch artifact ${failed.join(", ")}`);
}
