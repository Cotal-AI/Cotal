/** Claude's workspace trust, which a supervised seat cannot grant for itself. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The `.claude.json` Claude reads beside a config directory: inside a `CLAUDE_CONFIG_DIR`, else in HOME. */
function stateFile(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(env.HOME || homedir(), ".claude.json");
}

/**
 * Refuse a supervised launch in a directory the manager's Claude home does not trust. Claude opens
 * such a directory on its workspace-trust dialog, whose default answer exits, and no one is at a
 * supervised seat to answer it. Trust recorded for a parent directory counts, as it does in Claude.
 */
export function refuseUntrustedCwd(cwd: string): void {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }> | undefined;
  try {
    projects = (JSON.parse(readFileSync(stateFile(process.env), "utf8")) as { projects?: typeof projects }).projects;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (let dir = cwd; projects?.[dir]?.hasTrustDialogAccepted !== true; dir = dirname(dir)) {
    if (dirname(dir) === dir)
      throw new Error(
        `claude connector: the manager's Claude home does not trust ${cwd}, and a supervised seat cannot answer Claude's workspace-trust dialog; open \`claude\` in that directory on the manager host once and trust it, then launch again`,
      );
  }
}
