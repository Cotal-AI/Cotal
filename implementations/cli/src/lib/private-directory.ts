import { lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CommandFailure, protectedLocalDirectory } from "@cotal-ai/workspace";

/** Create private directories, returning the first one made. If named, check the existing
 *  ancestry for other local writers first. Non-recursive mkdir preserves native storage errors. */
export function mkdirPrivate(path: string, protectedPathName?: string): string | undefined {
  if (protectedPathName !== undefined) {
    if (lstatSync(path, { throwIfNoEntry: false })) {
      protectedLocalDirectory(path, protectedPathName);
      return undefined;
    }
  } else if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const parent = dirname(path);
  const first = parent === path ? undefined : mkdirPrivate(parent, protectedPathName);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (protectedPathName !== undefined && (code === "EACCES" || code === "EPERM" || code === "EROFS"))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `${path} could not be created because this account cannot write ${parent}`, { target: { path }, remedy: "choose a project path inside a directory you can write" });
    // Another creator may have made the directory after the check. Keep files and dangling links
    // as errors, and leave a genuine missing parent distinguishable from a storage failure.
    if (protectedPathName !== undefined || code !== "EEXIST" || !statSync(path).isDirectory()) throw error;
    return first;
  }
  return first ?? path;
}
