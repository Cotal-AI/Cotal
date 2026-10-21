/**
 * The front-end host for ONE already admitted chat session: picks TUI, `--plain` or `--stdio`, owns
 * terminal entry/restore, and returns the close report. It never admits, mints or constructs a
 * session; the caller passes one in. Nothing here registers a command. Mirrors `commands/watch.ts`
 * for lazy Ink loading, alternate screen, colour and signal handling.
 */
import { writeSync } from "node:fs";
import { colorEnabled, inputDisabledByFlag, terminalWidth } from "@cotal-ai/workspace";
import { ownStdoutErrors } from "../lib/stdout-owner.js";
import type { AdmittedChatSession, CloseReport } from "./session.js";
import type { Recipient } from "./view.js";

export type FrontEnd = "tui" | "plain" | "stdio";

/**
 * Choose the front end. `--stdio` is explicit and never combines with the TUI or `--json`. The TUI
 * needs both stdin and stdout to be terminals and input not disabled; otherwise a human session
 * refuses rather than silently falling back (the caller reports `--plain` or `--stdio` as remedies).
 */
export function selectFrontEnd(values: { stdio?: boolean; plain?: boolean; json?: boolean }): { ok: true; frontEnd: FrontEnd } | { ok: false; message: string } {
  if (values.stdio && (values.plain || values.json)) return { ok: false, message: "--stdio is its own NDJSON protocol; it does not combine with --plain or --json" };
  if (values.json) return { ok: false, message: "chat has no --json document; use --stdio for the NDJSON participant protocol" };
  if (values.stdio) return { ok: true, frontEnd: "stdio" };
  if (inputDisabledByFlag()) return { ok: false, message: "chat needs input; --no-input leaves no way to send or leave. Use --stdio for programs" };
  if (values.plain) return { ok: true, frontEnd: "plain" };
  if (process.stdin.isTTY && process.stdout.isTTY) return { ok: true, frontEnd: "tui" };
  return { ok: false, message: "the chat view needs an interactive terminal; use --plain for line mode or --stdio for programs" };
}

/**
 * The kitty keyboard protocol is the only way Ink reports Shift+Enter distinctly. Ink 6.8 keeps the
 * negotiated result private (`kittyProtocolEnabled`), so this host cannot know whether it was granted
 * and keeps `shiftEnterDistinct: false`: Enter always sends; a newline enters a draft by paste. A
 * public negotiation result is a named seam (handoff). `auto` still lets Ink negotiate so the extra
 * modifiers it reports are correct.
 */
const KITTY = { mode: "auto" as const, flags: ["disambiguateEscapeCodes" as const] };

/** The Ink view's modules, loaded with the colour choice set before Ink reads it. */
async function loadTui() {
  const forced = process.env.FORCE_COLOR;
  if (!colorEnabled()) process.env.FORCE_COLOR = "0";
  const [{ render }, { createElement }, { ChatView }] = await Promise.all([import("ink"), import("react"), import("./chat-view.js")]).finally(() => {
    if (forced === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = forced;
  });
  return { render, createElement, ChatView };
}

/** Run the Ink view until the user leaves; restore the terminal on every path. Its signal handlers
 *  are installed before its first await. */
async function runTui(
  { render, createElement, ChatView }: Awaited<ReturnType<typeof loadTui>>,
  session: AdmittedChatSession, initialRecipient: Recipient | undefined, notice: string | undefined,
): Promise<CloseReport | undefined> {
  let entered = false;
  const restore = (): void => {
    if (!entered) return;
    entered = false;
    // Leave the alternate screen and show the cursor; raw mode is restored by Ink's unmount.
    try { writeSync(process.stdout.fd, "\x1b[?1049l\x1b[?25h"); } catch { /* terminal closed */ }
  };
  let close: CloseReport | undefined;
  let unmount: (() => void) | undefined;
  // SIGINT reaches us only if raw mode is off; in raw mode Ctrl-C is a key the view handles. SIGHUP
  // (terminal gone) and SIGTERM unmount; the view's leave path is then not run, so the session is
  // closed below if it was not already.
  const hangup = (): void => { process.exitCode = 129; unmount?.(); };
  const terminate = (): void => { process.exitCode = 143; unmount?.(); };
  // An external `kill -INT` (raw-mode Ctrl-C is a key, not this signal) is treated like SIGTERM.
  const interrupt = (): void => { process.exitCode = 130; unmount?.(); };
  try {
    writeSync(process.stdout.fd, "\x1b[?1049h");
    entered = true;
    process.once("exit", restore);
    process.once("SIGHUP", hangup);
    process.once("SIGTERM", terminate);
    process.once("SIGINT", interrupt);
    const instance = render(
      createElement(ChatView, {
        session,
        initialRecipient,
        notice,
        // Without a negotiated protocol Ink cannot tell the two apart; the hint and key map follow.
        shiftEnterDistinct: false,
        onDone: (s) => { close = s.ended; unmount?.(); },
      }),
      { exitOnCtrlC: false, maxFps: 30, kittyKeyboard: KITTY },
    );
    unmount = () => instance.unmount();
    await instance.waitUntilExit();
  } finally {
    process.off("exit", restore);
    process.off("SIGHUP", hangup);
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
    restore();
  }
  // Unmounted by a signal before the view closed the session: close it now, once.
  if (!close) {
    try { close = await session.close(); }
    catch (e) { close = { retirement: "unknown", connectionClosed: "not-confirmed", message: (e as Error).message }; }
  }
  return close;
}

/**
 * Line modes (`--plain`, `--stdio`) have no raw mode, so Ctrl-C arrives as SIGINT. Without a handler
 * Node's default kills the process and the session is never closed, leaving it to the expiry sweep.
 * A signal is therefore turned into end of input: stdin is destroyed, which drives each front end's
 * own EOF path (finish accepted work, close once, write the end record / summary). The exit code
 * records the signal. A second signal during the close falls back to the default and kills the
 * process; the session then retires by sweep, which is the disclosed crash path.
 */
async function withLineSignals<T>(run: () => Promise<T>): Promise<T> {
  const codes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of Object.keys(codes) as NodeJS.Signals[]) {
    const h = (): void => {
      process.exitCode = codes[sig];
      for (const [s, f] of handlers) process.off(s, f); // the next signal gets the default
      process.stdin.destroy();
    };
    handlers.set(sig, h);
    process.once(sig, h);
  }
  try {
    return await run();
  } finally {
    for (const [s, f] of handlers) process.off(s, f);
  }
}

/**
 * Line modes own stdout's errors. A reader that closes stdout, or any failed write, ends input the
 * way a signal does, so the front end still closes its session once and the caller sets the exit
 * status from that close. The binary's closed-pipe exit would otherwise end the process first.
 */
async function withOwnedStdout<T>(run: () => Promise<T>): Promise<T> {
  const release = ownStdoutErrors(() => process.stdin.destroy());
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * A loaded front end. Starting it runs one admitted session and returns its close report, with
 * diagnostics on stderr. It installs its signal handling before its first await, so a caller that
 * holds the signals until then hands them over with no gap. The caller maps the report to an exit
 * code; a missing or non-`retired` report is never presented as a confirmed retirement.
 */
export type StartChatFrontEnd = (opts: {
  session: AdmittedChatSession;
  /** The channel the command named. The TUI and `--plain` start addressed to it. */
  initialRecipient?: Recipient;
  /** What the command disclosed about that channel before admission, shown again in the TUI. */
  notice?: string;
}) => Promise<CloseReport | undefined>;

/** Load the chosen front end's modules. Nothing runs until the returned function is called. */
export async function loadChatFrontEnd(frontEnd: FrontEnd): Promise<StartChatFrontEnd> {
  if (frontEnd === "stdio") {
    const { runStdio } = await import("./stdio-io.js");
    return ({ session }) => withLineSignals(() => withOwnedStdout(() => runStdio({ session, stdin: process.stdin, stdout: process.stdout, diagnostic: (line) => process.stderr.write(`cotal chat: ${line}\n`) })));
  }
  if (frontEnd === "plain") {
    const { runPlain } = await import("./plain.js");
    return async ({ session, initialRecipient }) => (await withLineSignals(() => withOwnedStdout(() => runPlain({ session, input: process.stdin, output: process.stdout, width: terminalWidth(process.stdout), initialRecipient })))).ended;
  }
  const tui = await loadTui();
  return ({ session, initialRecipient, notice }) => runTui(tui, session, initialRecipient, notice);
}
