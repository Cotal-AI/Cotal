import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Create private directories, returning the first one made. Use non-recursive mkdir so Node
 *  preserves native storage errors instead of replacing a quota failure with ENOENT. */
export function mkdirPrivate(path: string): string | undefined {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const parent = dirname(path);
  const first = parent === path ? undefined : mkdirPrivate(parent);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    // Another creator may have made the directory after the check. Keep files and dangling links
    // as errors, and leave a genuine missing parent distinguishable from a storage failure.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !statSync(path).isDirectory()) throw error;
    return first;
  }
  return first ?? path;
}
