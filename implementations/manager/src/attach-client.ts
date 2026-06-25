import WebSocket from "ws";

/** Detach key — Ctrl-] (0x1d), as in telnet/ssh escape conventions. */
const DETACH = 0x1d;

/**
 * Terminal modes a full-screen child (e.g. Claude's TUI) commonly turns on but that we must undo
 * locally on detach/exit: the agent keeps running after Ctrl-], so it never restores OUR terminal.
 * Without this, detaching from a mouse-tracking TUI leaves the terminal reporting every cursor move
 * as input (a stream of `ESC[<…M` escape codes), or its focus in/out as `ESC[I`/`ESC[O`. Disables
 * all mouse-report modes + focus reporting + bracketed paste, shows the cursor, and resets
 * attributes. Deliberately does NOT toggle the alternate screen.
 */
const RESTORE =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" + // mouse tracking off
  "\x1b[?1004l" + // focus reporting off
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?25h" + // show cursor
  "\x1b[0m"; // reset attributes

/**
 * Drive a manager's attach endpoint from the terminal: raw-mode stdin streams to
 * the PTY, PTY output streams to stdout, and SIGWINCH-style resizes are forwarded.
 * Ctrl-] detaches without killing the agent.
 */
export function attachClient(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;

    // A broken local pipe (terminal closed / SIGHUP) makes stdout writes async-error on a later
    // tick; with no listener that EPIPE/EIO becomes an uncaughtException — crashing on the per-frame
    // PTY write or the on-detach restore write. Register a no-op listener once here (not in cleanup,
    // so it outlives the async error tick) to turn it into a handled no-op.
    process.stdout.on("error", () => {});

    const sendResize = () =>
      ws.send(`r:${process.stdout.columns ?? 80},${process.stdout.rows ?? 24}`);
    const onInput = (d: Buffer) => {
      if (d.length === 1 && d[0] === DETACH) {
        ws.close();
        return;
      }
      ws.send(d);
    };
    const cleanup = () => {
      stdin.off("data", onInput);
      process.stdout.off("resize", sendResize);
      // Undo terminal modes the (still-running) agent's TUI enabled — it won't restore us on detach.
      if (process.stdout.isTTY) process.stdout.write(RESTORE);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    ws.on("open", () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      sendResize();
      process.stdout.on("resize", sendResize);
      stdin.on("data", onInput);
    });
    ws.on("message", (data: Buffer) => process.stdout.write(data));
    ws.on("close", () => {
      cleanup();
      resolve();
    });
    ws.on("error", (e) => {
      cleanup();
      reject(e);
    });
  });
}
