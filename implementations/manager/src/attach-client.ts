import WebSocket from "ws";

/** Detach key — Ctrl-] (0x1d), as in telnet/ssh escape conventions. */
const DETACH = 0x1d;

/**
 * Terminal modes a full-screen child (e.g. Claude's TUI) commonly turns on but that we must undo
 * locally on detach/exit: the agent keeps running after Ctrl-], so it never restores OUR terminal.
 * Without this, detaching from a mouse-tracking TUI leaves the terminal reporting every cursor move
 * as input (a stream of `ESC[<…M` escape codes), or its focus in/out as `ESC[I`/`ESC[O`. Disables
 * all mouse-report modes + focus reporting + bracketed paste, resets the keypad/cursor-key modes,
 * shows the cursor, and resets attributes. Deliberately does NOT toggle the alternate screen.
 */
const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l"; // all mouse tracking off
const RESTORE =
  MOUSE_OFF +
  "\x1b[?1004l" + // focus reporting off
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?1l" + // application cursor keys off (DECCKM): a full-screen TUI enables it; left on, arrows emit ESC O A not ESC [ A
  "\x1b>" + // keypad → numeric (DECKPNM)
  "\x1b[?25h" + // show cursor
  "\x1b[0m"; // reset attributes

// Wheel-scroll for full-screen children. A full-screen TUI (e.g. OpenCode) runs in the alternate
// screen — where the terminal's native scrollback is dead — and scrolls its content itself off mouse
// reports. But it enables that mouse capture on ITS pty, and the enable doesn't reliably survive the
// attach hop (backlog eviction / nested pty), so our terminal never reports the wheel and scrolling
// dies. So while the child is in the alternate screen we enable SGR mouse reporting on OUR terminal
// and translate each wheel tick into PageUp/PageDown — the keystrokes every full-screen TUI treats
// as "scroll the view" (OpenCode: `messages_page_up`/`_down`). Inline children (Claude) never enter
// the alt-screen, so this stays off and their native terminal-scrollback wheel is untouched.
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h"; // button+drag tracking, SGR encoding
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
// Enter/leave the alternate screen: xterm `?1049`, plus the older `?1047`/`?47`.
const ALT_ENTER = /\x1b\[\?(?:1049|1047|47)h/g;
const ALT_LEAVE = /\x1b\[\?(?:1049|1047|47)l/g;
// A complete SGR mouse report: `ESC [ < btn ; col ; row (M|m)`.
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]/;

const lastIndexOfRe = (re: RegExp, s: string): number => {
  re.lastIndex = 0;
  let last = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) last = m.index;
  return last;
};

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

    // Wheel-scroll state (see MOUSE_ON above): whether the child is in the alternate screen, and a
    // buffer for an SGR mouse report split across stdin reads.
    let altScreen = false;
    let mouseBuf = "";
    // Carry the tail of the previous output frame so an alt-screen escape split across ws frames
    // (e.g. `ESC[?10` then `49h`) is still detected; 16 bytes covers these private-mode sequences.
    // Acting only on state *change* below makes re-scanning the carried bytes idempotent.
    let scanTail = "";

    // Track the child's alt-screen transitions in its output so we can arm/disarm wheel translation.
    const trackAltScreen = (data: Buffer): void => {
      const s = scanTail + data.toString("latin1");
      scanTail = s.slice(-16);
      const enter = lastIndexOfRe(ALT_ENTER, s);
      const leave = lastIndexOfRe(ALT_LEAVE, s);
      if (enter === -1 && leave === -1) return;
      const nowAlt = enter > leave;
      if (nowAlt === altScreen) return;
      altScreen = nowAlt;
      if (altScreen) {
        if (process.stdout.isTTY) process.stdout.write(MOUSE_ON);
      } else {
        // Leaving alt-screen mid-session: undo the mouse modes WE enabled so the terminal stops
        // reporting the wheel/clicks and native scrollback works again — don't wait for detach.
        mouseBuf = "";
        if (process.stdout.isTTY) process.stdout.write(MOUSE_OFF);
      }
    };

    const sendResize = () =>
      ws.send(`r:${process.stdout.columns ?? 80},${process.stdout.rows ?? 24}`);
    const onInput = (d: Buffer) => {
      if (d.length === 1 && d[0] === DETACH) {
        ws.close();
        return;
      }
      // Inline child: forward keystrokes raw (its wheel scrolls the local terminal, not the app).
      if (!altScreen) {
        ws.send(d);
        return;
      }
      // Full-screen child: rewrite wheel reports to PageUp/PageDown, pass everything else through.
      mouseBuf += d.toString("latin1");
      let out = "";
      for (;;) {
        const i = mouseBuf.indexOf("\x1b[<");
        if (i === -1) {
          // A report split right before `<` (`ESC[` now, `<…M` next) would slip through untranslated:
          // hold a trailing `ESC[` for the next read. Never hold a bare trailing `ESC` — that's the
          // Escape key and must forward at once (e.g. OpenCode's interrupt); the rarer `ESC`|`[<…`
          // split stays raw by design.
          const keep = mouseBuf.endsWith("\x1b[") ? 2 : 0;
          out += mouseBuf.slice(0, mouseBuf.length - keep);
          mouseBuf = mouseBuf.slice(mouseBuf.length - keep);
          break;
        }
        out += mouseBuf.slice(0, i);
        const rest = mouseBuf.slice(i);
        const m = SGR_MOUSE.exec(rest);
        if (!m) {
          // Hold only a still-valid partial report (`ESC[<` + digits/semicolons) for the next read;
          // anything else can't become an SGR mouse report, so pass it straight through.
          if (/^\x1b\[<[\d;]*$/.test(rest)) mouseBuf = rest;
          else {
            out += rest;
            mouseBuf = "";
          }
          break;
        }
        const btn = Number(m[1]);
        if (btn & 0x40) out += btn & 1 ? PAGE_DOWN : PAGE_UP; // wheel: 64=up, 65=down
        else out += m[0]; // other mouse (click/drag): forward raw so the TUI still gets it
        mouseBuf = rest.slice(m[0].length);
      }
      if (out) ws.send(Buffer.from(out, "latin1"));
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
    ws.on("message", (data: Buffer) => {
      trackAltScreen(data);
      process.stdout.write(data);
    });
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
