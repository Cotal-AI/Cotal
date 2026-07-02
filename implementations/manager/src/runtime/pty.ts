import * as pty from "@lydell/node-pty";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { AgentHandle, AttachSession, LaunchSpec, Runtime } from "@cotal-ai/core";
import { preparePtyLaunch } from "./windows-launch.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** How many rows of history the attach-time screen mirror retains (see spawn) so a late attach
 *  still sees output that scrolled past. */
const SCROLLBACK_ROWS = 1000;
/** Spacing between auto-confirm Enter presses, and how many to send. Claude's startup gates
 *  (workspace-trust, then the dev-channels warning) each wait for Enter and neither has a headless
 *  override. The count is variable — a fresh folder shows both, a re-launch on a now-trusted folder
 *  shows only the channels gate — and each gate's screen is static once rendered, so we don't match
 *  text or count prompts: press Enter blindly a few times, spaced so each press lands on the next
 *  gate and a dropped press is retried. Both gates default-highlight "proceed", so Enter accepts the
 *  safe option; any extra press lands on Claude's empty input as a no-op. */
const CONFIRM_INTERVAL_MS = 1_000;
const MAX_CONFIRMS = 5;
/** Grace window for a clean exit before a graceful stop escalates to SIGKILL. */
const GRACE_MS = 3_000;

/**
 * The default runtime: the manager spawns the agent in a pseudo-terminal it owns
 * via `@lydell/node-pty`. A real native TUI — the manager keeps full OS-signal
 * control, and `cotal attach` streams the same PTY. Terminal I/O stays off the
 * mesh; the agent's own plugin still talks to NATS directly.
 */
export class PtyRuntime implements Runtime {
  readonly kind = "pty" as const;

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    // POSIX: passthrough (node-pty's exec resolves the bare name). win32: resolve the EXACT file and
    // adapt — a `.cmd`/`.bat` shim runs through cmd.exe with a pre-escaped command line. Resolve
    // against `spec.env` (the env we actually launch with), not the manager's, so executable
    // selection stays inside P3 isolation.
    const { command, args } = preparePtyLaunch(spec.command, spec.args, spec.env ?? {});
    const proc = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      // P3: pass ONLY the connector-declared env (OS allow-list + identity + named model key) —
      // never `...process.env`. The operator's unrelated secrets (AWS/GH/other service keys) don't
      // bleed into the child. `spec.env ?? {}` so a connector that forgets env fails loud (no
      // PATH) instead of silently inheriting the manager's env.
      env: spec.env ?? {},
    });

    const dataSubs = new Set<(c: Buffer) => void>();
    const exitSubs = new Set<() => void>();
    // Mirror the child's PTY into a headless terminal, so on attach we hand the new client a
    // reconstructed screen image — the alternate-screen buffer of a full-screen TUI, or the
    // scrollback of an inline one — instead of a raw byte replay. A raw replay can't rebuild an
    // alt-screen, which left a late or concurrent attach staring at a partial screen (see `backlog`).
    const term = new Headless.Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK_ROWS,
      allowProposedApi: true, // the serialize addon reads buffer internals via proposed API
    });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    let alive = true;
    let cols = DEFAULT_COLS;
    let rows = DEFAULT_ROWS;

    // Clear Claude's startup gates (workspace-trust, dev-channels warning) by pressing Enter on a
    // timer during the startup window — see CONFIRM_INTERVAL_MS for why this is blind, not output-
    // driven. A spawn that opts in sets `spec.confirm` truthy.
    let confirmTimer: ReturnType<typeof setInterval> | undefined;
    if (spec.confirm) {
      let presses = 0;
      confirmTimer = setInterval(() => {
        if (!alive || presses++ >= MAX_CONFIRMS) {
          clearInterval(confirmTimer);
          confirmTimer = undefined;
          return;
        }
        proc.write("\r");
      }, CONFIRM_INTERVAL_MS);
    }

    proc.onData((d) => {
      term.write(d); // mirror into the screen model for attach-time reconstruction
      const b = Buffer.from(d, "utf8");
      for (const fn of dataSubs) fn(b);
    });
    proc.onExit(() => {
      alive = false;
      if (confirmTimer) clearInterval(confirmTimer);
      for (const fn of exitSubs) fn();
    });

    return {
      name,
      kind: "pty",
      pid: proc.pid,
      status: () => (alive ? "running" : "exited"),
      stop: (opts) => {
        if (!alive) return;
        // node-pty's ConPTY backend has no signals: kill(<signal>) throws on Windows, and a
        // pseudoconsole can't deliver SIGTERM for a graceful mesh-leave. The manager instead sends a
        // cooperative `{op:"shutdown"}` over the agent's control endpoint BEFORE a graceful stop, so
        // here we just give the agent a window to run its exit handlers (leave the mesh, publish
        // offline) and exit on its own, then hard-kill (ConPTY close) as a fallback. A hard stop
        // (graceful:false — emergency reap) skips the window and kills immediately.
        if (process.platform === "win32") {
          if (opts?.graceful === false) {
            proc.kill();
            return;
          }
          // `alive` guards the already-exited case; the try/catch covers the narrow race where the
          // ConPTY tears down between the check and the kill (node-pty throws on a dead handle).
          setTimeout(() => {
            if (!alive) return;
            try {
              proc.kill();
            } catch {
              /* already gone */
            }
          }, GRACE_MS);
          return;
        }
        if (opts?.graceful === false) {
          proc.kill("SIGKILL");
          return;
        }
        // Graceful: SIGTERM lets the session run its exit handlers (incl. leaving the
        // mesh); escalate to SIGKILL if it's still up after a grace window.
        proc.kill("SIGTERM");
        setTimeout(() => alive && proc.kill("SIGKILL"), GRACE_MS);
      },
      interrupt: () => {
        if (alive) proc.write("\x03");
      },
      attach: (): AttachSession => ({
        get cols() {
          return cols;
        },
        get rows() {
          return rows;
        },
        backlog: () =>
          // Serialize the mirrored screen into bytes that repaint it exactly — the alt-screen buffer
          // (and modes) of a full-screen TUI, or the scrollback of an inline one. The empty write
          // drains the parser first (xterm writes are FIFO), so the snapshot reflects every byte the
          // child has emitted so far, not a state that lags behind in-flight output.
          new Promise<Buffer>((resolve) =>
            term.write("", () => resolve(Buffer.from(serializer.serialize(), "utf8"))),
          ),
        onData: (fn) => {
          dataSubs.add(fn);
          return () => dataSubs.delete(fn);
        },
        onExit: (fn) => {
          exitSubs.add(fn);
          return () => exitSubs.delete(fn);
        },
        write: (data) => {
          if (alive) proc.write(data);
        },
        resize: (c, r) => {
          cols = c;
          rows = r;
          if (c > 0 && r > 0) term.resize(c, r); // keep the mirror in step so snapshots reconstruct at size
          if (alive) proc.resize(c, r);
        },
      }),
    };
  }
}
