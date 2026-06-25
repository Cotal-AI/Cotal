import { join } from "node:path";
import { findCotalRoot } from "@cotal-ai/workspace";

/** The project's `.cotal/` root, found by walking up from cwd (like git finds `.git`), so every
 *  command resolves the same `.cotal/` whether you're at the project root or a subdirectory. */
export function cotalRoot(): string {
  return findCotalRoot();
}

/** A path inside the project's `.cotal/` directory. Use instead of `resolve(".cotal/…")` so paths
 *  don't break when `cotal` runs from a subdirectory. */
export function cotalPath(...segments: string[]): string {
  return join(cotalRoot(), ".cotal", ...segments);
}
