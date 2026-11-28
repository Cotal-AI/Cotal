import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { CommandFailure, isCommandFailure } from "./output.js";
import { localRecordAccess } from "./local-record-source.js";

/** The checks a protected-link write uses, passed in so this module does not import the file
 *  that defines them. */
export interface ProtectedLinkChecks {
  readonly resolved: (path: string, what: string) => string;
  readonly spelled: (path: string, what: string) => void;
}

/** Refuse a write under `path` while another local account could replace a folder on the way, and
 *  follow a symbolic link whose physical folder and every link parent are protected. Returns the
 *  physical directory the later lock, read and write use, so a link swapped after the check cannot
 *  move them. A folder not made yet is checked from the nearest one above it that exists, and the
 *  returned path is the spelled one. A relative path gets the same spelled-chain check a path that is
 *  not a link gets, and is returned unchanged so the later write uses the spelled path. Only POSIX
 *  follows links here. Other platforms use the spelled-chain check with their existing access model.
 *  `suffix` is appended to a refusal, such as "nothing was written". */
export function assertProtectedLinkWrite(path: string, what: string, checks: ProtectedLinkChecks, suffix = "nothing was written"): string {
  let dir = path;
  while (!lstatSync(dir, { throwIfNoEntry: false }) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    if (localRecordAccess() !== "posix" || !isAbsolute(path)) {
      checks.spelled(dir, what);
      return path;
    }
    if (dir === path) {
      const physical = join(checks.resolved(dirname(path), what), basename(path));
      checks.spelled(physical, what);
      return physical;
    }
    const physical = checks.resolved(dir, what);
    const rest = relative(dir, path);
    return rest && !rest.startsWith("..") && !isAbsolute(rest) ? join(physical, rest) : physical;
  } catch (e) {
    if (!isCommandFailure(e) || e.code !== "PERMISSION_DENIED") throw e;
    throw new CommandFailure(e.outcome, e.code, `${e.message}; ${suffix}`, { remedy: e.remedy, target: e.target });
  }
}
