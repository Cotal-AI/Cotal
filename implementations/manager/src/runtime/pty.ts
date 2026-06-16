import * as pty from "@lydell/node-pty";
import type { AgentHandle, AttachSession, LaunchSpec, Runtime } from "@cotal-ai/core";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** How much terminal output to retain for late-attach scrollback replay. */
const SCROLLBACK_BYTES = 256 * 1024;
/** Stop watching for spawn-confirm prompts after this long (they appear at startup). */
const CONFIRM_WINDOW_MS = 20_000;
/** Min gap between auto-confirm keypresses, so one rendered prompt isn't pressed twice. */
const CONFIRM_COOLDOWN_MS = 700;
/** Safety cap on auto-confirm presses — startup shows a small fixed set of prompts, never a loop. */
const MAX_CONFIRMS = 6;
/** Grace window for a clean exit before a graceful stop escalates to SIGKILL. */
const GRACE_MS = 3_000;

/** Strip ANSI control sequences and whitespace so a confirm prompt matches regardless
 *  of how a TUI positions its text (cursor moves between words, not spaces). */
function normalizeForMatch(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // other escapes
    .replace(/\s+/g, "");
}

/**
 * The default runtime: the manager spawns the agent in a pseudo-terminal it owns
 * via `@lydell/node-pty`. A real native TUI — the manager keeps full OS-signal
 * control, and `cotal attach` streams the same PTY. Terminal I/O stays off the
 * mesh; the agent's own plugin still talks to NATS directly.
 */
export class PtyRuntime implements Runtime {
  readonly kind = "pty" as const;

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const proc = pty.spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: { ...process.env, ...spec.env },
    });

    const dataSubs = new Set<(c: Buffer) => void>();
    const exitSubs = new Set<() => void>();
    const ring: Buffer[] = [];
    let ringBytes = 0;
    let alive = true;
    let cols = DEFAULT_COLS;
    let rows = DEFAULT_ROWS;

    // Auto-clear one-time spawn prompts. Claude shows up to two back-to-back "Enter to confirm"
    // screens on a fresh workspace (the trust-folder prompt, then the dev-channels warning), each
    // waiting for input. So matching can't be one-shot (it would clear only the first and hang on
    // the second), nor purely output-driven (a prompt renders then goes quiet — no data to react
    // to). Instead poll on a timer within the startup window: when `spec.confirm` is on screen and
    // the cooldown has elapsed, press Enter and clear the buffer so the SAME screen isn't pressed
    // twice; the next prompt re-populates it. Capped, so it can never become an Enter loop.
    const confirmTarget = spec.confirm ? normalizeForMatch(spec.confirm) : "";
    let confirmBuf = "";
    let confirmPresses = 0;
    let lastConfirmAt = 0;
    let confirmTimer: ReturnType<typeof setInterval> | undefined;
    const stopConfirm = () => {
      confirmBuf = "";
      if (confirmTimer) {
        clearInterval(confirmTimer);
        confirmTimer = undefined;
      }
    };
    const tryConfirm = () => {
      if (!alive || !confirmTimer) return;
      if (Date.now() - lastConfirmAt < CONFIRM_COOLDOWN_MS) return;
      if (!normalizeForMatch(confirmBuf).includes(confirmTarget)) return;
      lastConfirmAt = Date.now();
      confirmBuf = "";
      proc.write("\r");
      if (++confirmPresses >= MAX_CONFIRMS) stopConfirm();
    };
    if (confirmTarget) {
      confirmTimer = setInterval(tryConfirm, 250);
      setTimeout(stopConfirm, CONFIRM_WINDOW_MS);
    }

    proc.onData((d) => {
      const b = Buffer.from(d, "utf8");
      ring.push(b);
      ringBytes += b.length;
      while (ringBytes > SCROLLBACK_BYTES && ring.length > 1) {
        ringBytes -= ring.shift()!.length;
      }
      if (confirmTimer) {
        confirmBuf = (confirmBuf + d).slice(-8192);
        tryConfirm();
      }
      for (const fn of dataSubs) fn(b);
    });
    proc.onExit(() => {
      alive = false;
      stopConfirm();
      for (const fn of exitSubs) fn();
    });

    return {
      name,
      kind: "pty",
      pid: proc.pid,
      status: () => (alive ? "running" : "exited"),
      stop: (opts) => {
        if (!alive) return;
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
        backlog: () => Buffer.concat(ring),
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
          if (alive) proc.resize(c, r);
        },
      }),
    };
  }
}
