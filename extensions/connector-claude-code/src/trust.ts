/** Claude's workspace trust, which a supervised seat cannot grant for itself. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The `.claude.json` Claude reads beside a config directory: inside a `CLAUDE_CONFIG_DIR`, else in HOME. */
function stateFile(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(env.HOME || homedir(), ".claude.json");
}

/** The nearest directory at or above `dir` with a `.git` entry: the repository root Claude stops its trust walk at. */
function repoRoot(dir: string): string | undefined {
  for (;; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The directory Claude records a repository's trust under. A linked worktree's `.git` file names a
 * git dir under its repository's `worktrees/` that names the worktree back, and then the key is the
 * main checkout, or the repository itself when it is bare. Any other root, a submodule's included,
 * is its own key.
 */
function trustKey(root: string): string {
  const dotGit = join(root, ".git");
  const link = statSync(dotGit).isFile() && /^gitdir:(.*)/.exec(readFileSync(dotGit, "utf8").trim());
  if (!link) return root;
  const gitDir = resolve(root, link[1].trim());
  const pointer = (name: string) => (existsSync(join(gitDir, name)) ? resolve(gitDir, readFileSync(join(gitDir, name), "utf8").trim()) : undefined);
  const common = pointer("commondir"), back = pointer("gitdir");
  if (common === undefined || back === undefined || dirname(gitDir) !== join(common, "worktrees")) return root;
  if (!existsSync(back) || realpathSync(back) !== join(realpathSync(root), ".git")) return root;
  return basename(common) === ".git" ? dirname(common) : common;
}

/**
 * Refuse a supervised launch in a directory the manager's Claude home does not trust. Claude opens
 * such a directory on its workspace-trust dialog, whose default answer exits, and no one is at a
 * supervised seat to answer it. Trust is read as Claude reads it: the repository's key, or the
 * directory or a parent of it up to its repository's root, or any parent outside a repository.
 */
export function refuseUntrustedCwd(cwd: string): void {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }> | undefined;
  try {
    projects = (JSON.parse(readFileSync(stateFile(process.env), "utf8")) as { projects?: typeof projects }).projects;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const trusted = (dir: string) => projects?.[dir]?.hasTrustDialogAccepted === true;
  const root = repoRoot(cwd);
  if (root !== undefined && trusted(trustKey(root))) return;
  for (let dir = cwd; !trusted(dir); dir = dirname(dir)) {
    if (dir === root || dirname(dir) === dir)
      throw new Error(
        `claude connector: the manager's Claude home does not trust ${cwd}, and a supervised seat cannot answer Claude's workspace-trust dialog; open \`claude\` in that directory on the manager host once and trust it, then launch again`,
      );
  }
}
