/**
 * `cotal chat --plain`: the line-oriented human presentation (spec line 381). No ANSI, no cursor
 * movement; a numbered recipient choice and a separate send-confirmation step. It uses the same
 * pure model, controller and admitted session as the Ink view; it owns no authority and never
 * constructs a session.
 *
 * Interaction, one line at a time:
 *   - a line starting with `/` is a slash command (`//text` sends text that begins with `/`);
 *   - `:to` opens the numbered recipient choice;
 *   - any other line becomes the draft and is echoed back for confirmation: `y` sends, anything else
 *     (including empty) keeps it as the draft and sends nothing;
 *   - a multi-line message is entered with `:multi` and ended with a line holding only `.`;
 *   - end of input (Ctrl-D) leaves; an unconfirmed draft is reported (length only) and never sent,
 *     because no further answer can be read after end of input. `/quit` with a draft asks first.
 *
 * Paste: a pasted block arrives as several lines. Outside `:multi` each line is a separate draft that
 * needs its own `y`, so a paste can never become several sends without several confirmations.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { oneLine } from "@cotal-ai/core";
import type { AdmittedChatSession, SessionEvent } from "./session.js";
import {
  addNotice,
  applyEvent,
  applyPublishResult,
  closeSummary,
  headerRows,
  initialState,
  parseSlash,
  recipientLabel,
  setRecipient,
  transcriptRows,
  MAX_DRAFT,
  type ChatState,
  type Recipient,
} from "./view.js";
import { closeSession, publish, runSlash } from "./controller.js";
import { discloseChoice, listChoices, parseRecipient, type Choice } from "./picker.js";

type Mode =
  | { readonly kind: "compose" }
  | { readonly kind: "confirm"; readonly to: Recipient; readonly text: string }
  | { readonly kind: "multi"; readonly lines: readonly string[] }
  | { readonly kind: "pick"; readonly choices: readonly Choice[] }
  | { readonly kind: "confirm-leave" };

/**
 * Run the plain presentation until the user leaves or the session ends. Returns the final state.
 * Width is the caller's measured terminal width (Infinity when not a terminal: no wrapping).
 */
export async function runPlain(opts: {
  session: AdmittedChatSession;
  input: Readable;
  output: Writable;
  width: number;
  initialRecipient?: Recipient;
}): Promise<ChatState> {
  const { session, input, output } = opts;
  const width = Number.isFinite(opts.width) ? Math.max(20, opts.width) : Number.POSITIVE_INFINITY;
  let state = initialState(session.identity(), opts.initialRecipient);
  let mode: Mode = { kind: "compose" };
  // Total transcript entries ever appended = entries still held + entries dropped by the bound.
  // Printing tracks that monotonic count, so a dropped entry is never re-printed or skipped.
  let printedEntries = 0;
  const unacked: string[] = [];

  const print = (line: string): void => { output.write(`${line}\n`); };
  /** Print transcript entries that appeared since the last flush, then acknowledge shown messages. */
  const flush = (): void => {
    const total = state.dropped + state.transcript.length;
    const fresh = Math.min(total - printedEntries, state.transcript.length);
    if (total - printedEntries > fresh) print(`... ${total - printedEntries - fresh} entries were dropped before they could be shown`);
    if (fresh > 0) {
      const tail = { ...state, dropped: 0, transcript: state.transcript.slice(state.transcript.length - fresh) };
      for (const r of transcriptRows(tail, width)) print(r.text);
    }
    printedEntries = total;
    if (unacked.length) session.surfaced(unacked.splice(0));
  };
  const prompt = (): void => {
    switch (mode.kind) {
      case "compose": print(`[to ${recipientLabel(state.recipient)}] type a message, /command, :to, :multi`); break;
      case "confirm": print(`send to ${recipientLabel(mode.to)}? y = send, anything else = keep as draft`); break;
      case "multi": print("(multi-line: end with a line containing only .)"); break;
      case "pick": mode.choices.forEach((c, i) => print(`  ${i + 1}. ${c.label}${c.detail ? ` - ${c.detail}` : ""}`)); print("choose a number, or type #channel / @name / role:<role>; empty line cancels"); break;
      case "confirm-leave": print("you have an unsent draft. y = discard and leave, anything else = keep editing"); break;
    }
  };

  for (const r of headerRows(state)) print(r.text);

  const unsubscribe = session.subscribe((event: SessionEvent) => {
    if (event.type === "message") unacked.push(event.message.deliveryKey);
    state = applyEvent(state, event);
    flush();
  });

  const rl = createInterface({ input, terminal: false, crlfDelay: Number.POSITIVE_INFINITY });
  let leaving = false;
  const leave = async (): Promise<void> => {
    if (leaving) return;
    leaving = true;
    rl.close();
  };

  const startPick = async (): Promise<void> => {
    const [conn, roster] = await Promise.all([session.connection(), session.roster()]).catch(() => [undefined, undefined] as const);
    if (roster && roster.outcome !== "ok") state = addNotice(state, roster.outcome === "refused" ? "failed" : "waiting", `roster ${roster.outcome}: ${roster.message}`);
    mode = { kind: "pick", choices: listChoices(conn?.outcome === "ok" ? conn.value : undefined, roster?.outcome === "ok" ? roster.value : undefined, state.identity.principal) };
  };

  const choose = async (r: Recipient): Promise<void> => {
    const warning = await discloseChoice(session, r);
    state = setRecipient(state, r);
    if (warning) state = addNotice(state, "waiting", warning);
    mode = { kind: "compose" };
  };

  const stage = (text: string): void => {
    const recipient = state.recipient;
    if (!recipient) {
      state = { ...state, draft: text.slice(0, MAX_DRAFT) };
      state = addNotice(state, "hint", "choose a recipient first (:to); your text is kept as the draft");
      return;
    }
    state = { ...state, draft: text.slice(0, MAX_DRAFT) };
    mode = { kind: "confirm", to: recipient, text: state.draft };
  };

  const send = async (to: Recipient, text: string): Promise<void> => {
    if (state.endedByEvent || state.connection !== "connected") {
      state = addNotice(state, "waiting", "not connected: nothing was sent; your draft is kept");
      return;
    }
    state = { ...state, pending: { to, text, draft: state.draft } };
    let result;
    try {
      result = await publish(session, to, text);
    } catch (e) {
      result = { outcome: "unknown" as const, message: (e as Error).message };
    }
    state = applyPublishResult(state, result);
  };

  const handle = async (raw: string): Promise<void> => {
    const line = raw.replace(/\r$/, "");
    if (state.endedByEvent && mode.kind !== "confirm-leave") {
      state = addNotice(state, "failed", "session ended; end input (Ctrl-D) to leave, then open a new session");
      return;
    }
    switch (mode.kind) {
      case "confirm":
        if (line.trim().toLowerCase() === "y") await send(mode.to, mode.text);
        else state = addNotice(state, "hint", "not sent; kept as the draft (type it again or edit, then confirm)");
        mode = { kind: "compose" };
        return;
      case "multi":
        if (line === ".") {
          const text = mode.lines.join("\n");
          mode = { kind: "compose" };
          if (text.trim()) stage(text);
          return;
        }
        if (mode.lines.join("\n").length + line.length + 1 > MAX_DRAFT) {
          state = addNotice(state, "waiting", `draft is at its ${MAX_DRAFT}-character limit; end with .`);
          return;
        }
        mode = { kind: "multi", lines: [...mode.lines, line] };
        return;
      case "pick": {
        const t = line.trim();
        if (!t) { mode = { kind: "compose" }; return; }
        const n = Number(t);
        if (Number.isInteger(n) && n >= 1 && n <= mode.choices.length) return choose(mode.choices[n - 1]!.recipient);
        const parsed = parseRecipient(t);
        if (!parsed.ok) { state = addNotice(state, "failed", parsed.error); return; }
        return choose(parsed.recipient);
      }
      case "confirm-leave":
        if (line.trim().toLowerCase() === "y") { state = { ...state, draft: "" }; return leave(); }
        mode = { kind: "compose" };
        return;
      case "compose": {
        if (line === ":to") return startPick();
        if (line === ":multi") { mode = { kind: "multi", lines: [] }; return; }
        if (line.startsWith("/") && !line.startsWith("//")) {
          const parsed = parseSlash(line);
          if (!parsed.ok) { state = addNotice(state, "failed", parsed.error); return; }
          if (parsed.command.name === "quit") return state.draft ? void (mode = { kind: "confirm-leave" }) : leave();
          const offlineOk = parsed.command.name === "reconnect" || parsed.command.name === "connection" || parsed.command.name === "whoami";
          if (state.connection !== "connected" && !offlineOk) {
            state = addNotice(state, "waiting", "not connected: only /reconnect, /connection and /whoami run now");
            return;
          }
          const { state: next, ack } = await runSlash(session, state, parsed.command);
          state = next;
          unacked.push(...ack);
          return;
        }
        if (!line.trim()) return;
        return stage(line.startsWith("//") ? line.slice(1) : line);
      }
    }
  };

  prompt();
  try {
    for await (const line of rl) {
      if (leaving) break;
      await handle(line);
      flush();
      if (leaving) break;
      prompt();
    }
    // End of input with an unconfirmed draft: one explicit question would need more input, which
    // has ended; the draft is reported, not sent.
    if (!leaving && state.draft) print(`unsent draft discarded at end of input (${[...state.draft].length} characters; content not repeated)`);
  } finally {
    unsubscribe();
    rl.close();
  }
  state = await closeSession(session, state);
  flush();
  if (state.ended) print(oneLine(closeSummary(state.identity, state.ended)));
  return state;
}
