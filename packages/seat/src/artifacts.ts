import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Every launch artifact directory name starts with this (core launch-artifacts). Repeated here
 *  because this package depends on nothing else in the repo, and it guards a recursive removal. */
const DIR_PREFIX = "cotal-";

/**
 * Remove a seat's launch artifacts (the record's `artifacts`). Called only where this package
 * can prove the seat's child gone or never started: the custodian when it observes its child's exit
 * or fails to start one, and the launcher when it refuses before any process exists. Losing a
 * connection to the custodian proves neither, so nothing on the client side calls this.
 *
 * `root` is the temp dir of the process that wrote them. Refuses, before removing anything, a path
 * that is not a `cotal-` directory directly under it.
 */
export function discardSeatArtifacts(artifacts: readonly string[] | undefined, root: string): void {
  if (!artifacts?.length) return;
  const base = resolve(root);
  for (const dir of artifacts) {
    if (dirname(resolve(dir)) !== base || !basename(dir).startsWith(DIR_PREFIX))
      throw new Error(`refusing to remove launch artifact ${dir}: not a ${DIR_PREFIX}* directory directly under ${base}`);
  }
  for (const dir of artifacts) rmSync(dir, { recursive: true, force: true });
}
