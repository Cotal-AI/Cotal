import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registry, type Runtime, type RuntimeKind, type RuntimeProvider } from "@cotal-ai/core";
import { PtyRuntime } from "./pty.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";

/** How a manager picks its backend. `auto` is the deterministic default — always `pty`. tmux and
 *  cmux are never auto-selected; choose them explicitly (`--runtime tmux`/`cmux`), which resolves
 *  the integration from the registry and fails loud if it isn't imported. No fallbacks. */
export type RuntimeMode = RuntimeKind | "auto";

/** Build the runtime a manager will spawn through. `pty` ships with the manager and is what `auto`
 *  resolves to. `tmux` and `cmux` are extensions, selected only by an explicit kind and resolved
 *  from a registered {@link RuntimeProvider} they self-register on import (`@cotal-ai/tmux`,
 *  `@cotal-ai/cmux`); an explicit kind whose integration isn't imported — or whose backend isn't
 *  reachable — throws, never a silent fallback to pty. `session` names the tmux session (per space). */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  const kind: RuntimeKind = mode === "auto" ? "pty" : mode;
  if (kind === "pty") return new PtyRuntime();
  let provider: RuntimeProvider;
  try {
    provider = registry.resolve<RuntimeProvider>("runtime", kind);
  } catch {
    throw new Error(
      `unknown runtime "${kind}" — is its integration imported? (e.g. import "@cotal-ai/tmux" or "@cotal-ai/cmux")`,
    );
  }
  if (!provider.available())
    throw new Error(`${kind} runtime requested but it is not reachable`);
  return provider.create({ session });
}

/** Walk up from `startDir` to the pnpm workspace root (for spawning `pnpm cotal …`). */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
