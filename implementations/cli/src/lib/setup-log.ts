import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { oneLine } from "@cotal-ai/workspace";
import { cotalPath } from "./paths.js";

export interface SetupLog {
  path: string;
  line(s: string): void;
}

/** Timestamped append log for `cotal setup` — one file, also the first thing a
 *  Claude handoff is pointed at. It lives in the resolved project `.cotal/` (walked up from the
 *  process cwd). Each entry stays on its one timestamped line, since a newline in an interpolated
 *  path or error message would otherwise start a line that reads as an entry of its own. */
export function openSetupLog(): SetupLog {
  const path = cotalPath("setup.log");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n=== cotal setup - ${new Date().toISOString()} ===\n`);
  return {
    path,
    line(s: string) {
      appendFileSync(path, `${new Date().toISOString()} ${oneLine(s)}\n`);
    },
  };
}
