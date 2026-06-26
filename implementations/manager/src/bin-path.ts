import { accessSync, constants } from "node:fs";
import { join, delimiter, resolve } from "node:path";

/** Windows executable extensions (PATHEXT) used to resolve a bare command to its on-disk file: an
 *  agent ships as a `.cmd`/`.exe` shim (`claude` → `claude.cmd`) that an extension-less probe misses
 *  and node-pty can't launch by bare name. POSIX needs none (the name is the file). */
const EXE_EXTS =
  process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];

/** Resolve `bin` to an executable path — absolute when found via PATH — or null if absent. A
 *  side-effect-free preflight for a connector's `requires` (scans PATH with `accessSync(X_OK)`, no
 *  `which` shell-out, so it can't hang or run the harness) AND the source of the concrete command
 *  the pty runtime launches: on Windows node-pty doesn't resolve a bare `claude` (a `.cmd`) the way
 *  a POSIX exec does, so it's handed the resolved path. An absolute/relative path is checked as
 *  given; a bare name is looked up across PATH entries (empty entries skipped). On Windows each
 *  candidate is tried with every PATHEXT extension (or as-is if it already carries one). */
export function resolveOnPath(bin: string): string | null {
  const variants = (base: string): string[] => {
    if (process.platform !== "win32") return [base];
    const hasExt = EXE_EXTS.some((e) => base.toLowerCase().endsWith(e.toLowerCase()));
    return hasExt ? [base] : EXE_EXTS.map((e) => base + e);
  };
  const probe = (base: string): string | null => {
    for (const cand of variants(base)) {
      try {
        accessSync(cand, constants.X_OK);
        return cand;
      } catch {
        // not this candidate — keep trying
      }
    }
    return null;
  };
  if (bin.includes("/") || bin.includes("\\")) return probe(resolve(bin));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const hit = probe(join(dir, bin));
    if (hit) return hit;
  }
  return null;
}
