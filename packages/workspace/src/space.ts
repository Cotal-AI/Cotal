import { DEFAULT_SPACE } from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth } from "./auth-paths.js";

/** The space this folder operates on: its `.cotal/auth` space if set up, else the default.
 *  A folder has exactly one space (its auth) — commands resolve it through here so they always
 *  match the folder's mesh instead of assuming the global default. */
export function resolveSpace(cwd: string): string {
  return loadSpaceAuth(authDir(findCotalRoot(cwd)))?.space ?? DEFAULT_SPACE;
}
