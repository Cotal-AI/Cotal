import * as pty from "@lydell/node-pty";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { AgentHandle, AttachSession, LaunchSpec, Runtime, RuntimeReference } from "@cotal-ai/core";
import { StartupConfirmMatcher, unmatchedConfirmMessage, unsupportedTransport } from "@cotal-ai/seat";
import { preparePtyLaunch } from "./windows-launch.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** How many rows of history the attach-time screen mirror retains (see spawn) so a late attach
 *  still sees output that scrolled past. */
const SCROLLBACK_ROWS = 1000;
/** Bounded early-output window for the connector-declared startup confirmation prompt. */
const CONFIRM_TIMEOUT_MS = 15_000;
/** Grace window for a clean exit before a graceful stop escalates to SIGKILL. */
const GRACE_MS = 3_000;

/**
 * In-process node-pty ownership. The worker is the child's parent, so killing
 * the worker kills the seat. Production Linux pty goes through
 * `CustodialPtyRuntime`. Off Linux, `createRuntime("pty")` still spawns here;
 * `adopt` throws until that platform's custody transport lands. `legacy-pty-custody`
 * also instantiates this class on Linux as the honest M1 residual.
 */
export class LegacyPtyRuntime implements Runtime {
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
    // node-pty hands us the child's exit code and killing signal exactly once, and this runtime
    // used to drop them on the floor — leaving the manager unable to say why any seat had died.
    // Retained here so `exitInfo` can answer after the fact; stays undefined while the child lives,
    // because "not exited yet" and "exited cleanly" must never read the same.
    let exit: { code?: number; signal?: number } | undefined;

    // Honor LaunchSpec.confirm literally: match the connector-owned text in normalized early output,
    // press Enter exactly once when it appears, and fail loud if the declared gate never materializes.
    const confirmMatcher = spec.confirm ? new StartupConfirmMatcher(spec.confirm) : undefined;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    if (confirmMatcher) {
      confirmTimer = setTimeout(() => {
        if (!alive) return;
        const message = unmatchedConfirmMessage(confirmMatcher.prompt, CONFIRM_TIMEOUT_MS);
        term.write(`\r\n${message}\r\n`);
        const b = Buffer.from(`\r\n${message}\r\n`, "utf8");
        for (const fn of dataSubs) fn(b);
        proc.kill(process.platform === "win32" ? undefined : "SIGTERM");
      }, CONFIRM_TIMEOUT_MS);
    }

    proc.onData((d) => {
      term.write(d); // mirror into the screen model for attach-time reconstruction
      const b = Buffer.from(d, "utf8");
      for (const fn of dataSubs) fn(b);
      if (confirmMatcher?.push(d)) {
        proc.write("\r");
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = undefined;
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      alive = false;
      // `signal` is absent on an ordinary exit and 0 is a real exit code, so both are recorded as
      // present-or-absent rather than coalesced into one number.
      exit = { code: exitCode, ...(signal === undefined ? {} : { signal }) };
      if (confirmTimer) clearTimeout(confirmTimer);
      for (const fn of exitSubs) fn();
    });

    return {
      name,
      kind: "pty",
      pid: proc.pid,
      status: () => (alive ? "running" : "exited"),
      exitInfo: () => exit,
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
      waitForExit: () => alive
        ? new Promise<void>((resolve) => {
            const done = (): void => {
              exitSubs.delete(done);
              resolve();
            };
            exitSubs.add(done);
            if (!alive) done();
          })
        : Promise.resolve(),
      interrupt: () => {
        if (alive) proc.write("\x03");
      },
      // Type into the child without standing up an attach session. Guarded on `alive` exactly as
      // `interrupt` and the session's own `write` are: node-pty throws on a dead handle, and the
      // manager has already refused a non-running agent before it gets here, so this guard covers
      // only the narrow race where the child exits between that check and this call.
      write: (data) => {
        if (alive) proc.write(data);
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
          // Already exited (a session attaching over a just-dead pty): fire on the next tick so the
          // bridge surfaces a `process-exit` end frame instead of a silent zombie. proc.onExit fired
          // ONCE before this listener existed, so a late subscriber would otherwise never hear it
          // (waitForExit carries the same already-dead guard).
          if (!alive) { queueMicrotask(fn); return () => {}; }
          exitSubs.add(fn);
          return () => exitSubs.delete(fn);
        },
        write: (data) => {
          if (alive) proc.write(data);
        },
        resize: (c, r) => {
          // node-pty REJECTS a non-positive dimension (throws), and a console fitting BEFORE its pane
          // is laid out can send a 0. Guard BOTH the mirror and the pty resize so a degenerate geometry
          // is a safe no-op — never a throw that would propagate into and wedge the serving frame
          // handler (the live-e2e "zombie session" class).
          if (c <= 0 || r <= 0) return;
          cols = c;
          rows = r;
          term.resize(c, r); // keep the mirror in step so snapshots reconstruct at size
          if (alive) proc.resize(c, r);
        },
      }),
    };
  }

  adopt(_reference: RuntimeReference): AgentHandle {
    throw unsupportedTransport();
  }
}

/** @deprecated Use LegacyPtyRuntime. Kept so existing isolated fixtures keep compiling. */
export { LegacyPtyRuntime as PtyRuntime };
