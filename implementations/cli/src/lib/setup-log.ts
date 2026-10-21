import { closeSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openPrivateAppend } from "@cotal-ai/core";
import { oneLine } from "@cotal-ai/workspace";

export interface SetupLog {
  path: string;
  line(s: string): void;
}

/** Timestamped append log for `cotal setup` — one file, also the first thing a
 *  Claude handoff is pointed at. Setup keeps it at `<project>/.cotal/setup.log`. Each entry stays on
 *  its one timestamped line, since a newline in an interpolated path or error message would
 *  otherwise start a line that reads as an entry of its own. The log is owner-private and is never
 *  appended through a symlink ({@link openPrivateAppend}). */
export function openSetupLog(path: string): SetupLog {
  mkdirSync(dirname(path), { recursive: true });
  const append = (text: string): void => {
    const fd = openPrivateAppend(path);
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
  };
  append(`\n=== cotal setup - ${new Date().toISOString()} ===\n`);
  return {
    path,
    line(s: string) {
      append(`${new Date().toISOString()} ${oneLine(s)}\n`);
    },
  };
}
