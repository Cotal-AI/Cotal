import type { NatsConnection } from "@nats-io/transport-node";
import { openSessionRail, encodeTerminalData, terminalFrameBytes, decodeTerminalFrame, type SessionGrant } from "@cotal-ai/core";
import { c } from "../ui.js";

/**
 * The detach key — Ctrl-] (0x1d) by default, as in telnet/ssh escape conventions. `COTAL_DETACH_KEY`
 * rebinds it to another control key when Ctrl-] clashes with a keybinding inside the agent's TUI;
 * accepts `ctrl-<char>` or `^<char>` (e.g. `ctrl-b`, `^_`). Read at point of use, per the repo's
 * `COTAL_*` convention. An unparseable value — including a set-but-empty or whitespace-only one —
 * throws (named), never silently falling back; the caller turns that into a loud exit. Only an
 * unset var = the Ctrl-] default.
 */
export function detachKey(): { byte: number; label: string; overridden: boolean } {
  const spec = process.env.COTAL_DETACH_KEY;
  if (spec === undefined) return { byte: 0x1d, label: "Ctrl-]", overridden: false };
  const m = /^(?:ctrl-|\^)([a-z@[\\\]^_])$/i.exec(spec.trim());
  if (!m) {
    throw new Error(
      `invalid COTAL_DETACH_KEY "${spec}" - expected ctrl-<char> or ^<char> for a control key ` +
        `(a-z, or one of @ [ \\ ] ^ _), e.g. ctrl-b`,
    );
  }
  const ch = m[1].toUpperCase();
  return { byte: ch.charCodeAt(0) & 0x1f, label: `Ctrl-${ch}`, overridden: true };
}

/**
 * Terminal modes a full-screen child (a fullscreen TUI: OpenCode, or Claude under `/tui fullscreen`)
 * commonly turns on but that we must undo locally on detach/exit: the agent keeps running after
 * Ctrl-], so it never restores OUR terminal. Without this, detaching from a mouse-tracking TUI leaves
 * the terminal reporting every cursor move as input (a stream of `ESC[<…M` escape codes), or its
 * focus in/out as `ESC[I`/`ESC[O`. Disables all mouse-report modes + focus reporting + bracketed
 * paste, resets the keypad/cursor-key modes, shows the cursor, and resets attributes. Leaving the
 * alternate screen is handled separately (ALT_LEAVE_SEQ), only when we actually entered it — see
 * cleanup().
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

// Leave the alternate screen on detach, but ONLY if the child put us there (altScreen). The attach
// snapshot faithfully re-enters the child's alt-screen (`?1049h`) on our terminal; without a matching
// leave we strand it in the alt buffer, which has no scrollback and — with xterm alt-scroll — turns
// the wheel into ↑/↓ that walk shell history. Leaving the alt buffer IS the whole fix: alt-scroll
// (`?1007`) only acts inside the alt buffer, so `?1049l` alone makes it inert. We deliberately don't
// send `?1007l` — nothing on this path ever enabled it (unlike console.ts, which sets `?1007h` on
// entry), so disabling it would clobber the operator's own alternate-scroll preference for later apps.
const ALT_LEAVE_SEQ = "\x1b[?1049l"; // leave alt-screen — alt-scroll is inert once back in the main buffer

// Wheel-scroll for full-screen children. A fullscreen TUI (OpenCode, or Claude under `/tui
// fullscreen`) runs in the alternate screen — where the terminal's native scrollback is dead — and
// scrolls its content itself off mouse reports. But it enables that mouse capture on ITS pty, and the
// enable doesn't reliably survive the attach hop (backlog eviction / nested pty), so our terminal
// never reports the wheel and scrolling dies. So while the child is in the alternate screen we enable
// SGR mouse reporting on OUR terminal and translate each wheel tick into PageUp/PageDown — the
// keystrokes a fullscreen TUI treats as "scroll the view" (OpenCode: `messages_page_up`/`_down`;
// Claude's fullscreen binds PageUp/PageDown too). A child in the normal screen (inline Claude) keeps
// altScreen=false, so this stays off and its native terminal-scrollback wheel is untouched.
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h"; // button+drag tracking, SGR encoding
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
/** Collapse a wheel burst to at most one page command per display frame. Each raw wheel report used
 *  to become a separate session frame and TUI redraw; rapid scrolling could fill the 64-frame rail
 *  before the caller returned credit, even though the operator only intended one continuous scroll. */
const WHEEL_COALESCE_MS = 16;
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
 * A transport-agnostic terminal session. {@link attachClient} drives the terminal through this
 * interface, so the SAME raw-mode / alt-screen / detach handling serves the mesh §13.6 session
 * ({@link meshSessionTransport}). (The legacy loopback `ws://.../attach/` transport was removed with
 * the P2 item 6 no-127.0.0.1 sweep.)
 */
export interface TerminalTransport {
  /** Fires once the transport is connected and ready to carry the terminal. */
  onReady(cb: () => void): void;
  /** Remote → local: terminal output bytes. The transport awaits an async consumer before returning
   *  credit, so a slow local stdout applies real backpressure instead of acknowledging unread bytes. */
  onData(cb: (bytes: Buffer) => void | Promise<void>): void;
  /** The session ended: `err` on a transport error (rejects), else a clean detach/close (resolves),
   *  with the peer's distinct end `reason` when it sent one. */
  onEnd(cb: (err?: Error, reason?: string) => void): void;
  /** Local → remote: keystroke bytes. */
  send(bytes: Buffer): void;
  /** Local → remote: terminal resize. */
  resize(cols: number, rows: number): void;
  /** Detach: signal the remote and stop locally. */
  close(): void;
}

/**
 * The operator's terminal, held ACROSS attach attempts. A reconnect re-establishes the SESSION,
 * not the terminal: restoring raw mode and leaving the child's alternate screen between attempts
 * would flash the shell's screen back and then repaint over it, which is exactly the garble the
 * reconnect is supposed to spare the operator. So the two facts that outlive one session — the
 * mode the terminal was in before we touched it, and whether the child has us in its alternate
 * screen — live here, and the undo runs exactly once, when the attach really ends.
 *
 * `attachClient` creates its own when no hold is passed, which is the one-shot behaviour: enter on
 * ready, undo on end.
 */
export interface TerminalHold {
  /** Raw mode on, remembering what we found. Idempotent across reconnects. */
  enterRaw(): void;
  /** Is the child in its alternate screen right now? Carried across reconnects so the final undo
   *  leaves that buffer exactly when the child put us there. */
  altScreen: boolean;
  /** Undo every mode we changed, leave the alternate screen if the child put us there, and give
   *  the terminal back the raw mode it had. Idempotent. */
  restore(): void;
}

export function holdTerminal(): TerminalHold {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  let entered = false;
  let restored = false;
  return {
    altScreen: false,
    enterRaw(): void {
      if (entered) return;
      entered = true;
      if (stdin.isTTY) stdin.setRawMode(true);
    },
    restore(): void {
      if (restored) return;
      restored = true;
      if (process.stdout.isTTY) process.stdout.write(RESTORE + (this.altScreen ? ALT_LEAVE_SEQ : ""));
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    },
  };
}

/** Register the stdout EPIPE/EIO no-op ONCE for the process. Idempotent by construction: a
 *  reconnecting attach calls {@link attachClient} once per attempt and each call would otherwise
 *  add another listener that nothing ever removes. */
let stdoutErrorSwallowed = false;
function swallowStdoutPipeErrors(): void {
  if (stdoutErrorSwallowed) return;
  stdoutErrorSwallowed = true;
  process.stdout.on("error", () => {});
}

/** Resolve when stdout accepted a write. A destroyed pipe is a terminal that no longer consumes, not
 *  a reason to wedge the mesh rail forever; `error`/`close` therefore release the wait like `drain`. */
function writeStdout(bytes: Buffer): void | Promise<void> {
  if (process.stdout.write(bytes) || process.stdout.destroyed) return;
  return new Promise<void>((resolve) => {
    const done = (): void => {
      process.stdout.off("drain", done);
      process.stdout.off("error", done);
      process.stdout.off("close", done);
      resolve();
    };
    process.stdout.once("drain", done);
    process.stdout.once("error", done);
    process.stdout.once("close", done);
  });
}

/**
 * Why a session ended, as {@link attachClient} resolves it. The reason is the peer's distinct `end`
 * reason, the transport's own (`detached`, `peer-closed`, `connection-closed`), or the broken
 * rail's protocol-fault name. `error` is set when the end was a fault rather than a clean close;
 * it is DATA here rather than a rejection, because a caller that reconnects has to read the reason
 * to decide, and an exception carries it only as prose.
 */
export interface AttachOutcome {
  readonly reason: string;
  readonly error?: Error;
  /** Did any seat output actually reach the terminal? The manager replays its backlog snapshot on
   *  every open, so a session that carried nothing never got that far — which is how a caller that
   *  reconnects tells a session that worked from one that died on the way up. */
  readonly carried: boolean;
}

/**
 * The TRANSPORT-class end reasons: the link broke, the session did not finish. Every one of these
 * means the seat is still there and a fresh session would reach it.
 *
 * The nine fault names are core's own, not a list invented here: `openSessionRail`'s
 * `onProtocolError` documents its whole vocabulary as "the session is broken — close and
 * re-establish" (SPEC 13.6). Added to them are the three ends that are not rail faults but are
 * still the link dying: the peer closing its rail, and this side's NATS connection going away.
 *
 * Deliberately NOT here, so a reconnect never papers over a finished session: `detached` (the
 * operator pressed the key), and the manager's terminal reasons — `process-exit` (the agent
 * exited), `target-despawn`, `manager-restart`, `expired` (the grant's TTL elapsed). Those end the
 * attach, and the CLI says which.
 */
const TRANSPORT_END_REASONS: ReadonlySet<string> = new Set([
  "garbled-frame", "gap", "credit-overrun", "flood", "subscription", "stall", "handler", "publish", "seq-exhausted",
  "peer-closed", "closed", "connection-closed",
]);

/** Did the session end because the LINK broke (so re-establishing is the honest response)? */
export function isTransportEnd(reason: string): boolean {
  return TRANSPORT_END_REASONS.has(reason);
}

/**
 * Drive a manager's attach session from the terminal: raw-mode stdin streams to the remote PTY,
 * PTY output streams to stdout, and SIGWINCH-style resizes are forwarded. The detach key (Ctrl-]
 * by default, {@link detachKey}) detaches without killing the agent. Transport-agnostic over the
 * mesh §13.6 session.
 */
export function attachClient(transport: TerminalTransport, hold?: TerminalHold, takeStdin?: () => boolean): Promise<AttachOutcome> {
  // Resolve the detach key before connecting so a bad COTAL_DETACH_KEY fails loudly up front
  // (matching the manager's other fail-fast exits) instead of after an attach we'd only tear down.
  let detach: ReturnType<typeof detachKey>;
  try {
    detach = detachKey();
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // A caller that reconnects owns the terminal across attempts and undoes it once at the end;
  // without a hold this session owns it, which is the one-shot behaviour.
  const ownsTerminal = hold === undefined;
  const term = hold ?? holdTerminal();
  return new Promise<AttachOutcome>((resolve) => {
    const stdin = process.stdin;

    // A broken local pipe (terminal closed / SIGHUP) makes stdout writes async-error on a later
    // tick; with no listener that EPIPE/EIO becomes an uncaughtException — crashing on the per-frame
    // PTY write or the on-detach restore write. It must outlive the async error tick, so it is NOT
    // removed in cleanup — which is exactly why it is registered once per PROCESS rather than once
    // per attempt: a reconnect loop calls this function again on every re-establishment, and one
    // listener per attempt walks into MaxListenersExceededWarning during a long outage.
    swallowStdoutPipeErrors();

    // Wheel-scroll state (see MOUSE_ON above): whether the child is in the alternate screen (on the
    // hold, since it outlives one session) and a buffer for an SGR mouse report split across stdin
    // reads (per-session: bytes still in flight when a link dies are gone with it).
    // Did this session ever put bytes on the terminal (see AttachOutcome.carried)?
    let carried = false;
    // Did THIS session ever take the stream? A reconnecting caller holds a reader between sessions,
    // and a session that ends before its `ready` fires never ran the handoff below, so it never
    // took anything: pausing on the way out would pause a stream it does not own, under a reader
    // that is still installed and now reads nothing. Measured before this line existed: a link
    // killed while a session's opening flush was in flight left the loop's watcher listening over a
    // paused stream for the whole backoff, and everything typed at that frozen terminal was flushed
    // into the agent by the NEXT session's resume. Cell O of `smoke:attach-stdin` is that window.
    let tookStdin = false;
    let mouseBuf = "";
    let wheelDelta = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    const flushWheel = (): void => {
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = undefined;
      const delta = wheelDelta;
      wheelDelta = 0;
      if (delta === 0) return;
      transport.send(Buffer.from(delta > 0 ? PAGE_DOWN : PAGE_UP, "latin1"));
    };
    const clearWheel = (): void => {
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = undefined;
      wheelDelta = 0;
    };
    const queueWheel = (delta: number): void => {
      wheelDelta = Math.max(-8, Math.min(8, wheelDelta + delta));
      if (wheelTimer) return;
      wheelTimer = setTimeout(flushWheel, WHEEL_COALESCE_MS);
      wheelTimer.unref?.();
    };
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
      if (nowAlt === term.altScreen) return;
      term.altScreen = nowAlt;
      if (term.altScreen) {
        if (process.stdout.isTTY) process.stdout.write(MOUSE_ON);
      } else {
        // Leaving alt-screen mid-session: undo the mouse modes WE enabled so the terminal stops
        // reporting the wheel/clicks and native scrollback works again — don't wait for detach.
        mouseBuf = "";
        clearWheel();
        if (process.stdout.isTTY) process.stdout.write(MOUSE_OFF);
      }
    };

    const sendResize = () =>
      transport.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    const onInput = (d: Buffer) => {
      if (d.length === 1 && d[0] === detach.byte) {
        clearWheel();
        transport.close();
        return;
      }
      // Inline child: forward keystrokes raw (its wheel scrolls the local terminal, not the app).
      if (!term.altScreen) {
        transport.send(d);
        return;
      }
      // Full-screen child: rewrite wheel reports to PageUp/PageDown, pass everything else through.
      // Wheel reports are coalesced ACROSS stdin reads; raw input flushes the pending wheel first so
      // keyboard/mouse ordering remains exact.
      mouseBuf += d.toString("latin1");
      let out = "";
      const flushOut = (): void => {
        if (!out) return;
        transport.send(Buffer.from(out, "latin1"));
        out = "";
      };
      const appendRaw = (raw: string): void => {
        if (!raw) return;
        flushWheel();
        out += raw;
      };
      for (;;) {
        const i = mouseBuf.indexOf("\x1b[<");
        if (i === -1) {
          // A report split right before `<` (`ESC[` now, `<…M` next) would slip through untranslated:
          // hold a trailing `ESC[` for the next read. Never hold a bare trailing `ESC` — that's the
          // Escape key and must forward at once (e.g. OpenCode's interrupt); the rarer `ESC`|`[<…`
          // split stays raw by design.
          const keep = mouseBuf.endsWith("\x1b[") ? 2 : 0;
          appendRaw(mouseBuf.slice(0, mouseBuf.length - keep));
          mouseBuf = mouseBuf.slice(mouseBuf.length - keep);
          break;
        }
        appendRaw(mouseBuf.slice(0, i));
        const rest = mouseBuf.slice(i);
        const m = SGR_MOUSE.exec(rest);
        if (!m) {
          // Hold only a still-valid partial report (`ESC[<` + digits/semicolons) for the next read;
          // anything else can't become an SGR mouse report, so pass it straight through.
          if (/^\x1b\[<[\d;]*$/.test(rest)) mouseBuf = rest;
          else {
            appendRaw(rest);
            mouseBuf = "";
          }
          break;
        }
        const btn = Number(m[1]);
        if (btn & 0x40) {
          flushOut();
          queueWheel(btn & 1 ? 1 : -1); // wheel: 64=up, 65=down
        } else appendRaw(m[0]); // other mouse (click/drag): forward raw so the TUI still gets it
        mouseBuf = rest.slice(m[0].length);
      }
      flushOut();
    };
    const cleanup = () => {
      clearWheel();
      stdin.off("data", onInput);
      process.stdout.off("resize", sendResize);
      // Undo terminal modes the (still-running) agent's TUI enabled — it won't restore us on detach.
      // If the child put us in its alternate screen, leave it too so the terminal isn't stranded in
      // the alt buffer; an inline child keeps its scrollback. Only when this session OWNS the
      // terminal: a reconnecting caller undoes it once, after the last attempt, so the screen does
      // not flash back to the shell and get repainted over between sessions.
      if (ownsTerminal) term.restore();
      else if (tookStdin) stdin.pause();
    };

    transport.onReady(() => {
      // Take stdin from whoever was holding it BETWEEN sessions, synchronously and before anything
      // below touches the stream. A reconnecting caller keeps a reader installed for the whole
      // non-session period so bytes typed at a terminal with no session are read and dropped rather
      // than buffered; without this handoff both readers would be live at once and a detach byte
      // would be seen twice. Synchronous by construction: `data` is emitted on a later tick, so the
      // gap between the caller's `off` and the `on` below cannot lose a byte.
      //
      // It ANSWERS, because the byte it may have just eaten is a detach. The caller's reader owns
      // stdin until this line, and this line runs when the session is READY, which is a round trip
      // after the caller announced the reconnect. A key pressed in between is seen by that reader
      // and by nobody else: without this branch the operator's detach vanishes and the session they
      // meant to leave comes up and keeps their keystrokes. So a press that already landed detaches
      // the session that is opening, before it takes the terminal or reads a byte.
      if (takeStdin?.()) {
        transport.close();
        return;
      }
      // Make an override visible (the CLI's "attached to X — Ctrl-] to detach" hint still prints the
      // default label). Only on override, so the default case stays free of duplicate noise.
      if (detach.overridden) console.error(c.dim(`detach key: ${detach.label} (via COTAL_DETACH_KEY)`));
      term.enterRaw();
      stdin.resume();
      tookStdin = true;
      sendResize();
      process.stdout.on("resize", sendResize);
      stdin.on("data", onInput);
    });
    transport.onData(async (data) => {
      carried = true;
      trackAltScreen(data);
      await writeStdout(data);
    });
    transport.onEnd((err, reason) => {
      cleanup();
      // The reason is DATA, not an exception: a reconnecting caller reads it to decide whether the
      // link broke or the session finished. A transport with nothing to say about a faulted end
      // reports `error`, which is never in the transport-class set; the loop exits non-zero on it
      // rather than calling it a detach, so an unnamed fault is still loud.
      resolve({ reason: reason ?? (err ? "error" : "detached"), carried, ...(err ? { error: err } : {}) });
    });
  });
}


/**
 * The mesh §13.6 SESSION transport: the item-6 replacement for the loopback WebSocket. Given a
 * connection scoped to the session's eps rails and the redeemed grant, it opens the caller rail,
 * asks the serving side to replay the reconstructed backlog (the `ready` handshake — PR #158 over
 * the mesh), and speaks the core terminal-session frame codec. A `drop` frame is surfaced INLINE
 * (never a silent loss); a peer `end`/close or a protocol fault ends the session with the distinct
 * reason. No `127.0.0.1`, no bearer URL — the grant is holder-bound.
 */
export function meshSessionTransport(nc: NatsConnection, grant: SessionGrant): TerminalTransport {
  let onDataCb: ((bytes: Buffer) => void | Promise<void>) | undefined;
  let onEndCb: ((err?: Error, reason?: string) => void) | undefined;
  let onReadyCb: (() => void) | undefined;
  let ended = false;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let rail!: ReturnType<typeof openSessionRail>;
  const fireEnd = (err?: Error, reason?: string): void => {
    if (ended) return;
    ended = true;
    if (repaintTimer) clearTimeout(repaintTimer);
    repaintTimer = undefined;
    onEndCb?.(err, reason);
  };
  // Schedule after the rail's async handler returns so the reverse data frame piggybacks the NEW
  // receive watermark, including the drop notice itself. That ack reopens the serving window before
  // the repeat `ready` asks for a fresh canonical screen snapshot.
  const requestRepaint = (): void => {
    if (ended || repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = undefined;
      if (ended) return;
      try { rail.send({ k: "ready" }); } catch { /* broken/full: the rail fault path ends the session */ }
    }, 0);
    repaintTimer.unref?.();
  };

  rail = openSessionRail({
    nc,
    grant,
    role: "caller",
    onData: async (data) => {
      let frame;
      try { frame = decodeTerminalFrame(data); } catch { return; } // garbled: the rail already surfaced it
      if (frame.k === "data") await onDataCb?.(Buffer.from(terminalFrameBytes(frame)));
      else if (frame.k === "end") fireEnd(undefined, frame.reason);
      else if (frame.k === "drop") {
        await onDataCb?.(Buffer.from(`\r\n[cotal: ${frame.bytes} bytes dropped - backpressure]\r\n`));
        requestRepaint();
      }
    },
    onClose: () => fireEnd(undefined, "peer-closed"),
    // The fault NAME rides alongside the error. It used to live only inside the message, where the
    // only way to tell a broken link from a finished session was to parse English.
    onProtocolError: (reason) => fireEnd(new Error(`mesh session transport error: ${reason}`), reason),
  });

  // The connection going away ends the session, and says so. Without this a link that dies past the
  // serving side's stall watchdog leaves the caller subscribed to a session nobody is serving: the
  // manager's `end` and `close` frames were published while this side was disconnected and EPS has
  // no retention, so they are simply gone, and the attach hangs on a dead session with no output,
  // no error and no end. `nc.closed()` is the one signal that still arrives.
  void nc.closed().then((err) => fireEnd((err as Error | undefined) ?? undefined, "connection-closed"));

  // The caller's `out` subscription must be live before the serving side is asked to replay (EPS is
  // at-most-once, no retention). flush() forces the SUB, then we send `ready` and go.
  void nc.flush().then(() => {
    if (ended) return;
    try { rail.send({ k: "ready" }); } catch { /* broken/full: the onProtocolError path ends the session */ }
    onReadyCb?.();
    // A flush that FAILS means the connection went away before the session ever opened, which is the
    // link and not the session. Without a reason here the end reads as a plain `error`, which is in
    // no classification, so a reconnect would treat a link that died between connect() and the first
    // flush as a finished session and stop: the exact failure this path exists to remove, in the
    // window where a flapping link is most likely to land.
  }).catch((e) => fireEnd(e as Error, "connection-closed"));

  return {
    onReady: (cb) => { onReadyCb = cb; },
    onData: (cb) => { onDataCb = cb; },
    onEnd: (cb) => { onEndCb = cb; },
    send: (bytes) => { try { rail.send(encodeTerminalData(bytes)); } catch { /* interactive keystrokes are low-volume; a stuck window ends via the stall watchdog */ } },
    // Guard degenerate geometry: the §13.6 codec rejects a non-positive dimension (a terminal
    // reporting 0 during a transient) — never emit it (the serving side tolerates it regardless).
    resize: (cols, rows) => { if (cols > 0 && rows > 0) { try { rail.send({ k: "resize", cols, rows }); } catch { /* advisory */ } } },
    close: () => { rail.close(); fireEnd(undefined, "detached"); },
  };
}
