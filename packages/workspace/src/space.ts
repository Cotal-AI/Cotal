import { DEFAULT_SPACE } from "@cotal-ai/core";
import { authDir, findCotalRoot, soleSpaceOf } from "./auth-paths.js";

/** The space this folder operates on: its `.cotal/auth` space if set up, else the default.
 *  Commands resolve it through here so they always match the folder's mesh instead of assuming the
 *  global default. A root that has grown to hold SEVERAL space accounts makes this question
 *  ambiguous, and {@link soleSpaceOf} fails loud there rather than picking one - such a caller has
 *  to name its space (`--space`). */
export function resolveSpace(cwd: string): string {
  return soleSpaceOf(authDir(findCotalRoot(cwd))) ?? DEFAULT_SPACE;
}
