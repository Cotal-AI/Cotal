import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  discardLaunchArtifacts,
  registry,
  type AgentHandle,
  type AttachSession,
  type Runtime,
  type RuntimeKind,
  type RuntimeProvider,
  type RuntimeReference,
} from "@cotal-ai/core";
import { CustodialPtyRuntime } from "./custodial-pty.js";
import { LegacyPtyRuntime } from "./pty.js";
import { unsupportedTransport } from "@cotal-ai/seat";

export type { Runtime, RuntimeKind, AgentHandle, AttachSession } from "@cotal-ai/core";

/** Adopt a durable handle, or refuse by name when this runtime has no adopt method. */
export function requireRuntimeAdopt(runtime: Runtime, reference: RuntimeReference): AgentHandle {
  if (typeof runtime.adopt !== "function")
    throw new Error(`runtime "${runtime.kind}" does not support adopt`);
  return runtime.adopt(reference);
}

/** What a {@link CustodialRuntime.reap} proved. `absent`: the custody record for that reference
 *  could not be read. That is a statement about ADDRESSABILITY, not about liveness, and the two are
 *  not the same fact: a custodian that dies after spawning its child and before writing the record
 *  leaves a LIVE seat and no record, and a stale or wrong reference looks for a record that exists
 *  at a different path. `reaped`: every process the record named was signalled and verified gone, or
 *  found already gone by identity. Only `reaped` proves anything about a process. */
export type RuntimeReapEvidence = { outcome: "absent" } | { outcome: "reaped"; detail: string };

/** A reap that could not PROVE the seat gone, thrown by {@link requireRuntimeReap} on an `absent`
 *  outcome so no caller can render it as a disposal it did not make. Carries the reference so the
 *  operator has the one thing that lets them go look: what to search for. */
export class RuntimeReapUnproven extends Error {
  readonly reference: RuntimeReference;
  constructor(runtimeKind: string, reference: RuntimeReference) {
    super(
      `runtime "${runtimeKind}" holds no custody record for ${reference.kind}:${reference.id}, so the seat it addresses is NOT proved gone; ` +
        `a custodian that died before writing its record leaves a live seat behind this same outcome`,
    );
    this.name = "RuntimeReapUnproven";
    this.reference = reference;
  }
}

/**
 * A runtime that OWNS the processes it starts, durably enough to address them after the manager
 * that started them is gone.
 *
 * This is deliberately NOT on the core {@link Runtime} contract. Core hosts the extension contracts
 * so that any backend can implement them, and these two cannot be implemented by a backend that
 * delegates to an external surface: `tmux`, `cmux`, `orca` and `herdr` do not own a process to
 * signal or a custody record to pre-mint against, so the methods would have no meaning for them
 * rather than merely no implementation. `adopt` stays on the generic contract because "reattach to
 * a handle you created" is something a delegating backend could one day mean.
 *
 * `reserve` mints the custody reference BEFORE any process exists, so the caller can record it
 * durably and hand the same reference to `spawn`; the reference then precedes the processes it
 * addresses. `reap` signals only a process whose identity it verifies against its own record,
 * proves it and its descendants gone, and forgets the record.
 */
export interface CustodialRuntime extends Runtime {
  reserve(): RuntimeReference;
  /** Also removes the launch artifacts (core launch-artifacts) the custody record still lists, once
   *  the seat is proved gone, even when another manager launched it. */
  reap(reference: RuntimeReference): Promise<RuntimeReapEvidence>;
}

/** Whether this backend custodies its own processes. Both methods are required together: a runtime
 *  that could mint references but never prove them gone would have the manager record references no
 *  successor can act on, which is worse than recording none. */
export function isCustodialRuntime(runtime: Runtime): runtime is CustodialRuntime {
  const r = runtime as Partial<CustodialRuntime>;
  return typeof r.reserve === "function" && typeof r.reap === "function";
}

/** Reap an orphaned custody by reference, or refuse by name when this runtime does not custody its
 *  own processes. Absent means REFUSE, never "assume gone": the lifecycle stays held rather than
 *  retiring over a live seat. */
export async function requireRuntimeReap(
  runtime: Runtime,
  reference: RuntimeReference,
): Promise<{ outcome: "reaped"; detail: string }> {
  if (typeof (runtime as Partial<CustodialRuntime>).reap !== "function")
    throw new Error(`runtime "${runtime.kind}" does not support reap; the orphaned process for ${reference.kind}:${reference.id} cannot be proved gone`);
  const evidence = await (runtime as CustodialRuntime).reap(reference);
  // The refusal this function's contract promises, made structural: `absent` never leaves here, so
  // the return type carries no branch a caller could render as success. Placing it at the callsites
  // instead left each one free to describe an unread record as a reaped process, which is what both
  // of them did.
  if (evidence.outcome === "absent") throw new RuntimeReapUnproven(runtime.kind, reference);
  return evidence;
}

/**
 * The built-in `pty` runtime on every platform. It spawns in-process and never starts a custodian
 * (#1391). On Linux it still adopts and reaps seats that an earlier `CustodialPtyRuntime` launched,
 * so a manager can drain custody records left by a pre-repair manager. It has no `reserve`, so the
 * manager records no custody reference for a new spawn.
 */
class PtyRuntime extends LegacyPtyRuntime {
  private custodial?: CustodialPtyRuntime;

  private legacyCustody(): CustodialPtyRuntime {
    if (process.platform !== "linux") throw unsupportedTransport();
    return (this.custodial ??= new CustodialPtyRuntime());
  }

  override adopt(reference: RuntimeReference): AgentHandle {
    return this.legacyCustody().adopt(reference);
  }

  reap(reference: RuntimeReference): Promise<RuntimeReapEvidence> {
    return this.legacyCustody().reap(reference);
  }
}

/** How a manager picks its backend. `auto` is the deterministic default — always `pty`. External
 *  runtimes are never auto-selected; choose one explicitly, which resolves
 *  the integration from the registry and fails loud if it isn't imported. No fallbacks. */
export type RuntimeMode = RuntimeKind | "auto";

/** Build the runtime a manager will spawn through. `pty` ships with the manager and is what `auto`
 *  resolves to. Every other name resolves a self-registered {@link RuntimeProvider}; an explicit
 *  provider that is absent or unreachable throws, never a silent fallback to pty. */
export function createRuntime(mode: RuntimeMode, session: string): Runtime {
  return ownLaunchArtifacts(createBackend(mode, session));
}

function createBackend(mode: RuntimeMode, session: string): Runtime {
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
    return new PtyRuntime();
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

/**
 * The launcher's half of core launch-artifacts, installed on every runtime this module creates so it
 * holds for every backend: a spec's private files are removed only once the runtime has proved its
 * child gone.
 *
 * - A custodial runtime (pty on Linux) hands the files to the seat's custodian, the parent of the
 *   child: it removes them when it sees that child exit, so they go on exit, stop and the custodian's
 *   own unattended timeout whether or not any manager is still alive. The runtime removes them on a
 *   refusal made before any process existed. The end of this manager's attach stream proves nothing,
 *   since a custodian that dies leaves its child running, so nothing here listens to it. Its reap,
 *   once it proves the seat gone, removes what the custody record still lists, which covers a
 *   custodian killed before its child exited and a removal that failed.
 * - Any other runtime discards on the exit its attach session streams (the in-process pty). One that
 *   cannot attach (tmux, cmux, orca, herdr) is polled through `status()`, and its `waitForExit`, the
 *   proof every stop already awaits, confirms the exit before the files go.
 * - Any other spawn that throws is not proof that nothing started (a backend can fail after its
 *   child is up), so its files stay for the OS temp reaper.
 */
function ownLaunchArtifacts(runtime: Runtime): Runtime {
  if (isCustodialRuntime(runtime)) return runtime;
  const spawn = runtime.spawn.bind(runtime);
  runtime.spawn = (name, spec, cwd, reference) => {
    const handle = spawn(name, spec, cwd, reference);
    if (spec.artifacts?.length) discardOnExit(handle, discardOnce(name, spec.artifacts));
    return handle;
  };
  return runtime;
}

function discardOnce(name: string, artifacts: readonly string[] | undefined): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      discardLaunchArtifacts(artifacts);
    } catch (e) {
      console.error(`! ${name}: ${(e as Error).message}`);
    }
  };
}

/** How often a handle with no exit stream is asked whether its child has exited. */
const EXIT_POLL_MS = 5_000;

function discardOnExit(handle: AgentHandle, discard: () => void): void {
  let poll: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (poll) clearInterval(poll);
    discard();
  };
  // Wrapped, never called at spawn: a runtime bounds its wait for a stop (tmux gives up after
  // seconds), so a wait started at spawn would give up on every seat that outlives that bound.
  const wait = handle.waitForExit?.bind(handle);
  if (wait) handle.waitForExit = () => wait().then(finish);
  let session: AttachSession;
  try {
    session = handle.attach();
  } catch {
    // No exit stream. Poll the runtime's own status and let its wait prove the exit, so a seat that
    // ends on its own is cleaned up as well as one that is stopped.
    if (!wait) return;
    let waiting = false;
    poll = setInterval(() => {
      if (waiting) return;
      let exited: boolean;
      try {
        exited = handle.status() === "exited";
      } catch {
        return;
      }
      if (!exited) return;
      waiting = true;
      wait().then(finish, () => {
        waiting = false;
      });
    }, EXIT_POLL_MS);
    poll.unref();
    return;
  }
  session.onExit(finish);
  if (handle.status() === "exited") finish();
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
