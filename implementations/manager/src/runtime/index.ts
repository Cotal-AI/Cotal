import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registry, type AgentHandle, type Runtime, type RuntimeKind, type RuntimeProvider, type RuntimeReference } from "@cotal-ai/core";
import { CustodialPtyRuntime } from "./custodial-pty.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";

/** Adopt a durable handle, or refuse by name when this runtime has no adopt method. */
export function requireRuntimeAdopt(runtime: Runtime, reference: RuntimeReference): AgentHandle {
  if (typeof runtime.adopt !== "function")
    throw new Error(`runtime "${runtime.kind}" does not support adopt`);
  return runtime.adopt(reference);
}

/** How a manager picks its backend. `auto` is the deterministic default — always `pty`. External
 *  runtimes are never auto-selected; choose one explicitly, which resolves
 *  the integration from the registry and fails loud if it isn't imported. No fallbacks. */
export type RuntimeMode = RuntimeKind | "auto";

/** Build the runtime a manager will spawn through. `pty` ships with the manager and is what `auto`
 *  resolves to. Every other name resolves a self-registered {@link RuntimeProvider}; an explicit
 *  provider that is absent or unreachable throws, never a silent fallback to pty. */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  const kind: RuntimeKind = mode === "auto" ? "pty" : mode;
  if (kind === "pty") {
    // node-pty's native spawn-helper hangs before exec under Bun — it never becomes the child, so
    // every agent wedges at "starting…" with no error. Fail loud rather than silently break the mesh:
    // the pty runtime is Node-only. External runtimes drive their own CLIs (no node-pty), so they're fine.
    if (process.versions.bun)
      throw new Error(
        `the pty runtime requires Node.js - the manager is running under Bun (v${process.versions.bun}), ` +
          `where @lydell/node-pty's spawn-helper hangs before exec and every agent wedges at "starting…". ` +
          `Run the manager under node, or install and select an external runtime.`,
      );
    return new CustodialPtyRuntime();
  }
  let provider: RuntimeProvider;
  try {
    provider = registry.resolve<RuntimeProvider>("runtime", kind);
  } catch {
    throw new Error(
      `unknown runtime "${kind}" - install its integration with \`cotal ext add <npm-package>\`, or import it in this composition root`,
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
