import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registry, type AgentHandle, type Runtime, type RuntimeKind, type RuntimeProvider, type RuntimeReapEvidence, type RuntimeReference } from "@cotal-ai/core";
import { CustodialPtyRuntime } from "./custodial-pty.js";
import { LegacyPtyRuntime } from "./pty.js";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";
export type { RuntimeReapEvidence } from "@cotal-ai/core";

/**
 * A runtime with durable process custody: it can reserve a seat reference before the seat exists,
 * and reap an orphaned seat by that reference after the owning manager died. Only runtimes that
 * own real OS processes (the custodial PTY runtime on Linux) implement this. Runtimes that attach
 * to externally-owned processes (tmux/cmux/orca/herdr) do not.
 *
 * The manager type-guards at each spawn site with {@link isCustodialRuntime} and narrows to this
 * interface, so the core Runtime contract stays free of custody concerns.
 */
export interface CustodialRuntime extends Runtime {
  /**
   * Mint the durable custody reference for a seat this runtime is ABOUT to spawn, before any
   * process exists. The caller records it durably and then hands the SAME reference back to
   * {@link Runtime.spawn}, so the reference precedes the processes it addresses: a crash anywhere
   * after the spawn leaves an orphan a successor can still address, never a live seat nobody can
   * name. A runtime that implements this MUST spawn the seat under exactly the reference it
   * returned, and report it back on the handle.
   */
  reserve(): RuntimeReference;
  /**
   * Reap a process this runtime custodies that no live manager owns any more: the orphan a crashed
   * manager left behind, addressed by the reference its handle carried. It must signal only a
   * process whose identity it can verify against its own custody record, prove the process and its
   * descendants gone, and forget the record.
   */
  reap(reference: RuntimeReference): Promise<RuntimeReapEvidence>;
}

/** Type guard: true when the runtime implements the custodial sub-interface. */
export function isCustodialRuntime(rt: Runtime): rt is CustodialRuntime {
  return typeof (rt as CustodialRuntime).reserve === "function" && typeof (rt as CustodialRuntime).reap === "function";
}

/** Adopt a durable handle, or refuse by name when this runtime has no adopt method. */
export function requireRuntimeAdopt(runtime: Runtime, reference: RuntimeReference): AgentHandle {
  if (typeof runtime.adopt !== "function")
    throw new Error(`runtime "${runtime.kind}" does not support adopt`);
  return runtime.adopt(reference);
}

/** Reap an orphaned custody by reference, or refuse by name when this runtime has no reap method. */
export function requireRuntimeReap(runtime: Runtime, reference: RuntimeReference): Promise<RuntimeReapEvidence> {
  if (!isCustodialRuntime(runtime))
    throw new Error(`runtime "${runtime.kind}" does not support reap; the orphaned process for ${reference.kind}:${reference.id} cannot be proved gone`);
  return runtime.reap(reference);
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
    if (process.platform === "linux") return new CustodialPtyRuntime();
    return new LegacyPtyRuntime();
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
