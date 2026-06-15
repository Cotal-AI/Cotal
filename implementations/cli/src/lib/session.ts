import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeSession {
  /** The session id `claude --resume <id>` expects — the transcript filename without `.jsonl`. */
  id: string;
  path: string;
  mtimeMs: number;
}

/** Claude Code stores a project's session transcripts under
 *  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` is the absolute
 *  working directory with every non-alphanumeric character replaced by `-`. Returns the sessions
 *  for `cwd`, newest first; empty when the project has none. */
export function listClaudeSessions(cwd: string): ClaudeSession[] {
  const dir = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no project dir → no sessions for this cwd (the caller turns this into a clear error)
  }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => {
      const path = join(dir, n);
      return { id: n.slice(0, -".jsonl".length), path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The most-recently-active Claude Code session for `cwd`, or undefined if there is none. */
export function findClaudeSession(cwd: string): ClaudeSession | undefined {
  return listClaudeSessions(cwd)[0];
}
