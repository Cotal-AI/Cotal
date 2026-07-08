import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { cotalPath } from "./paths.js";

export interface SetupLog {
  path: string;
  line(s: string): void;
}

/** Timestamped append log for `cotal setup` — one file, also the first thing a
 *  Claude handoff is pointed at. Resolves the project's `.cotal/` (walks up from cwd). */
export function openSetupLog(_cwd: string): SetupLog {
  const path = cotalPath("setup.log");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n=== cotal setup - ${new Date().toISOString()} ===\n`);
  return {
    path,
    line(s: string) {
      appendFileSync(path, `${new Date().toISOString()} ${s}\n`);
    },
  };
}
