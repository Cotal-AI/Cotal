import type { Extension } from "./registry.js";
import type { LaunchSpec } from "./connector.js";
import { MANAGED_HANDOFF_FILE_ENV, type ManagedLifecycleHandoff, type ManagedLifecycleTarget } from "./managed-handoff.js";

/** Which backend a manager spawns through. Open-ended: `pty` ships with the manager; every other
 *  name is contributed by a {@link RuntimeProvider}. */
export type RuntimeKind = string;

/**
 * A runtime-owned durable handle reference. Its contents are intentionally opaque to the manager
 * and to the mesh protocol: a runtime may use a local socket name, a provider resource id, or
 * another private capability to identify a handle it can adopt.
 */
export interface RuntimeReference {
  readonly kind: RuntimeKind;
  readonly id: string;
}

/** A live attach onto a running agent's terminal — the stream `cotal attach`
 *  (and, later, the browser console) consumes. PTY frames flow here directly,
 *  never over the mesh. */
export interface AttachSession {
  readonly cols: number;
  readonly rows: number;
  /** A snapshot to bootstrap a late/concurrent attach: bytes that repaint the current screen.
   *  May be async — a backend can reconstruct a full-screen (alternate-screen) TUI's buffer rather
   *  than replay raw scrollback, so an attach paints correctly without the child having to repaint. */
  backlog(): Buffer | Promise<Buffer>;
  /** Subscribe to live output; returns an unsubscribe fn. */
  onData(fn: (chunk: Buffer) => void): () => void;
  /** Fires when the underlying process exits; returns an unsubscribe fn. */
  onExit(fn: () => void): () => void;
  /** Forward keystrokes to the process. */
  write(data: string): void;
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): void;
}

/** An OS handle on one spawned agent — the manager owns this to *control* the
 *  process (the mesh observes its presence separately). */
export interface AgentHandle {
  readonly name: string;
  readonly kind: RuntimeKind;
  /** A local durable reference for a runtime that can later adopt this handle. */
  readonly reference?: RuntimeReference;
  /** OS pid of the spawned child, when the backend owns a real process (pty/host); absent for
   *  backends that don't (tmux/cmux attach to an externally-owned process). */
  readonly pid?: number;
  status(): "running" | "exited";
  /** Tear the agent down. `graceful` (default) signals a clean exit (so the session
   *  leaves the mesh on its own) before ensuring the process/tab is gone; otherwise
   *  it's a hard, immediate kill. */
  stop(opts?: { graceful?: boolean }): void;
  /** Release this manager's local handle without stopping or deprovisioning the agent. Optional,
   *  and absent means the runtime cannot survive manager exit, so callers must fail closed. */
  release?(): void;
  /** Resolve only after the runtime has authoritatively proved the process/window/workspace is gone.
   * Optional during the preservation rollout; a manager maintenance cut must fail closed when absent. */
  waitForExit?(): Promise<void>;
  interrupt(): void;
  /** Type `data` into the agent as if it came from the keyboard: the one-shot sibling of
   *  {@link interrupt} (which already writes `\x03`). A caller that wants to deliver a line of
   *  text, not to watch a terminal, uses this instead of standing up an {@link AttachSession} for
   *  it: a session carries a backlog, a subscriber set and a lifetime, and none of that is wanted
   *  for one write.
   *
   *  OPTIONAL, and absent means REFUSE, never degrade: a backend that does not own the child's
   *  input stream (tmux/cmux/orca/herdr attach to an externally-owned process) leaves it off, and
   *  the manager answers `input is not supported by runtime <kind>`. A silent no-op here would be
   *  a dropped keystroke, which is worse than an error.
   *
   *  Resolves only after the runtime has accepted the write, with the number of UTF-8 bytes it
   *  accepted. Rejects when the runtime cannot accept it. A caller must derive any delivery receipt
   *  from this acknowledgement, never from the buffer it intended to send. */
  write?(data: string): Promise<number>;
  /** What the runtime OBSERVED when the child ended: the OS exit code, and/or the signal number
   *  that killed it. Meaningful only once {@link status} reports `exited`; before that a backend
   *  returns undefined.
   *
   *  OPTIONAL, and absent means UNKNOWN — never "clean": a backend that does not own the child
   *  process (tmux/cmux/orca/herdr attach to an externally-owned one) cannot see how it ended, and
   *  a caller must say so rather than print a zero it never measured. Defaulting to `code: 0` here
   *  would fabricate a clean exit on exactly the seats whose death nobody can account for, which is
   *  the failure this exists to end.
   *
   *  `diagnostic` is the backend's own reason when it stopped the child itself (a startup
   *  confirmation that never appeared), otherwise the last line the child printed under a
   *  connector's `[cotal-<name>]` or `[cotal-<name>/<part>]` prefix, for a backend that reads the
   *  child's output; absent when there is neither. */
  exitInfo?(): { code?: number; signal?: number; diagnostic?: string } | undefined;
  /** Open a live attach. Throws on backends that can't stream (e.g. tmux/cmux, which
   *  you attach to natively). */
  attach(): AttachSession;
}

/** A pluggable agent backend — `pty` (default) owns a real pseudo-terminal; extension runtimes
 *  can delegate to an external terminal or process surface. */
export interface Runtime {
  readonly kind: RuntimeKind;
  /** True only when every handle this runtime creates can release manager-local custody without
   * stopping the underlying agent. Absent is false for PTY runtimes and irrelevant for runtimes
   * that hold no process-owning PTY master. */
  readonly supportsRelease?: boolean;
  /**
   * Mint the durable custody reference for a seat this runtime is ABOUT to spawn, before any
   * process exists. The caller records it durably and then hands the SAME reference back to
   * {@link spawn}, so the reference precedes the processes it addresses: a crash anywhere after
   * the spawn leaves an orphan a successor can still address, never a live seat nobody can name.
   * Minting the id inside `spawn` cannot give that ordering, because the processes are already
   * running by the time it returns.
   *
   * OPTIONAL, and absent means this runtime has no durable custody to reserve; the caller spawns
   * without a reference, as before. Such a runtime may still report a reference on the handle after
   * the spawn and reap by it, which a successor can use once the handle exists. A runtime that implements
   * this MUST spawn the seat under exactly the reference it returned, and report it back on the
   * handle: a spawn that quietly mints its own id would leave the recorded reference addressing
   * nothing, which is worse than recording none.
   */
  reserve?(): RuntimeReference;
  /** Spawn the agent. `reference` is a custody reference from {@link reserve}, and a runtime that
   *  offers `reserve` must honour it exactly; it is absent for a runtime without durable custody. */
  spawn(name: string, spec: LaunchSpec, cwd: string, reference?: RuntimeReference): AgentHandle;
  /**
   * Reattach this runtime to a handle it created previously. This is a local runtime operation,
   * not a mesh operation. OPTIONAL, and absent means REFUSE, never spawn a replacement: a runtime
   * without durable custody omits it, and the caller must throw naming that runtime. A silent skip
   * here would drop custody on the floor.
   */
  adopt?(reference: RuntimeReference): AgentHandle;
  /**
   * Start one seat outside the manager's filesystem for an already-enrolled lifecycle. Optional;
   * absent means the runtime cannot host a delegated seat and the manager uses `spawn`.
   *
   * The runtime creates one provider resource under `managedRuntimeKey(handoff)`, writes the
   * handoff and the persona into it as private files, and runs {@link delegatedSeatCommand} there.
   * It calls the provider's create at most once per call and never retries a create whose answer
   * was lost. The handle's `status()` is `"exited"` only after the provider observed the child
   * exit, or after a fenced close by that key completed. A provider answer that no resource exists
   * under the key is never exit evidence. A lost, timed-out or ambiguous acknowledgement leaves it
   * `"running"`.
   *
   * `stop()` is the fenced close by that key. It completes only when no create for that key can
   * still materialize: the create was answered before the close, or the provider's close fences the
   * key so a create that arrives later is refused. Until one of those holds, `stop()` keeps the
   * close pending, `status()` stays `"running"`, and `waitForExit()` does not settle. The handle
   * carries no `reference` and no `release`.
   *
   * A provider that names its own resources may run the create as a durable operation keyed by
   * that key and close through the identifier its authenticated create response returned, recorded
   * where the host can read it without the manager. Only that response binds an identifier to the
   * key; one derived from the key or found by name or listing is never closed or adopted.
   */
  spawnDelegated?(launch: DelegatedSeatLaunch, handoff: ManagedLifecycleHandoff): AgentHandle;
}

/** What a non-local runtime needs to start one delegated seat, besides the handoff. Every field
 *  is a value; none is a path on the manager's filesystem. A spawn choice with no field here is
 *  refused by the manager before enrollment, never dropped. */
export interface DelegatedSeatLaunch {
  /** The connector name the child resolves, for example `claude-code`. */
  readonly agent: string;
  /** The agent-definition file text the manager resolved for this spawn. */
  readonly persona: string;
  /** The role the manager resolved (the `--role` override, else the persona's `role:`), the same
   *  value the enrollment carried. */
  readonly role?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly prompt?: string;
  readonly launchOptions?: Readonly<Record<string, string>>;
  readonly events?: boolean;
}

/** The argv (after the `cotal` binary in the child's image) and the environment a runtime runs
 *  in the child. `files` are paths inside the child. The child's working directory is the provider
 *  resource's own and its channel lists come from the handoff, so no cwd, resume, shared-tool or
 *  access-list flag is ever emitted. */
export function delegatedSeatCommand(
  launch: DelegatedSeatLaunch,
  target: ManagedLifecycleTarget,
  files: { readonly handoff: string; readonly persona: string },
): { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  const args = [
    "spawn", "--config", files.persona, "--space", target.space, "--name", target.actor, "--agent", launch.agent,
    "--expect-owner", target.owner, "--expect-lifecycle-uid", target.lifecycleUid,
  ];
  if (launch.role !== undefined) args.push("--role", launch.role);
  if (launch.model !== undefined) args.push("--model", launch.model);
  if (launch.variant !== undefined) args.push("--variant", launch.variant);
  if (launch.prompt !== undefined) args.push("--prompt", launch.prompt);
  for (const [k, v] of Object.entries(launch.launchOptions ?? {})) args.push("--opt", `${k}=${v}`);
  if (launch.events !== undefined) args.push(launch.events ? "--events" : "--no-events");
  return { args, env: { [MANAGED_HANDOFF_FILE_ENV]: files.handoff } };
}


/**
 * A bridge that contributes one runtime backend — an {@link Extension} of kind
 * `"runtime"`. `name` is the backend it provides (e.g. `"cmux"`), the key the
 * manager resolves by. Providers self-register on import (like {@link Connector}),
 * so the manager core stays ignorant of which runtimes exist beyond its built-ins.
 */
export interface RuntimeProvider extends Extension {
  readonly kind: "runtime";
  readonly name: RuntimeKind;
  /** Whether this backend is reachable right now (e.g. the cmux app is running). */
  available(): boolean;
  /** Build a runtime instance. `session` names a per-space multiplexer session
   *  when the backend uses one (tmux); others may ignore it. */
  create(opts: { session: string }): Runtime;
}
