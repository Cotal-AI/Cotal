import type { Extension } from "./registry.js";
import type { LaunchSpec } from "./connector.js";

/** Which backend a manager spawns through. Open-ended: `pty` ships with the
 *  manager; `tmux` and `cmux` are extensions contributed by a {@link RuntimeProvider}. */
export type RuntimeKind = string;

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
  /** OS pid of the spawned child, when the backend owns a real process (pty/host); absent for
   *  backends that don't (tmux/cmux attach to an externally-owned process). */
  readonly pid?: number;
  status(): "running" | "exited";
  /** Tear the agent down. `graceful` (default) signals a clean exit (so the session
   *  leaves the mesh on its own) before ensuring the process/tab is gone; otherwise
   *  it's a hard, immediate kill. */
  stop(opts?: { graceful?: boolean }): void;
  interrupt(): void;
  /** Open a live attach. Throws on backends that can't stream (e.g. tmux/cmux, which
   *  you attach to natively). */
  attach(): AttachSession;
}

/** A pluggable agent backend — `pty` (default) owns a real pseudo-terminal; `tmux`
 *  drives a multiplexer pane; `cmux` (an integration) opens a tab. */
export interface Runtime {
  readonly kind: RuntimeKind;
  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle;
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

