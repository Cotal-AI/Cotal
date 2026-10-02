// @ts-check
/**
 * One answer to "was this module run, or imported?", for every script that has to ask.
 *
 * Eight scripts here hand-rolled the question and seven of them got it wrong in the same
 * direction: they compared `process.argv[1]` against `import.meta.url` as strings. Node resolves
 * the main module through its symlinks before it becomes `import.meta.url` and leaves `argv[1]`
 * as the caller typed it, so the two disagree whenever any component of the path is a link. The
 * guard is then false, `main()` never runs, and the process exits 0 having done nothing. For a
 * gate that is the dangerous direction: `node scripts/check-attribution.mjs --range A..B` from a
 * checkout under `/tmp` on macOS (a symlink to `private/tmp`) printed nothing and exited 0.
 *
 * Two other spellings of the same string comparison were in use and are also wrong, differently:
 * a template literal drops the percent-encoding `import.meta.url` always carries, so a path with
 * a space or a `#` in it never matches, and `new URL("file://" + p)` reads everything after a `#`
 * as a fragment.
 *
 * So the comparison is between two REAL PATHS, which is the identity the question is actually
 * about. `realpathSync` on both sides rather than on the entry alone: under
 * `--preserve-symlinks-main` it is `import.meta.url` that keeps the link, and a guard that is
 * correct in only one of the two directions is a guard someone has to remember the direction of.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when `moduleUrl` names the file this process was started with.
 *
 * @param {string} moduleUrl the caller's own `import.meta.url`
 * @returns {boolean}
 */
export function isMainEntry(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl);
  if (entry === self) return true;
  // A path that cannot be resolved is not the entry point: `node --eval` leaves an `argv[1]` that
  // is not a file at all. Answering false is right, and it is also the only safe answer, because
  // throwing here would take down a module whose only crime was being imported.
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}
