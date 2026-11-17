/**
 * The pure view model of one live chat opening (spec "Live human session", "Terminal presentation").
 * It turns session events and keystrokes into state, and state into lines. Ink, `--plain` and the
 * gallery modes all render from this one model. Nothing here performs I/O, holds authority or
 * talks to the mesh. The only way out is an {@link Intent} the caller runs against its admitted
 * session, then reports back with {@link applyPublishResult}, {@link applySlashResult} or
 * {@link applyEnded}.
 */
import { displayWidth, wrapWords, shownTime } from "@cotal-ai/workspace";
import { oneLine } from "@cotal-ai/core";
import type { AttentionMode, ChannelMode } from "@cotal-ai/core";
import {
  MAX_DRAFT, closeSummary, latestDirected, personLabel, publishOutcome, recipientLabel, replyRecipient, settlePublish, sharedNames, slashOutcome, submitDraft,
  type CloseReport, type ConnectionState, type Person, type PublishResult, type Recipient, type Result, type SessionEvent, type SessionIdentity, type SessionMessage, type SlashCommand,
} from "@cotal-ai/workspace/chat";

/** Bounded transcript retention. A dropped entry leaves a visible gap marker. Provisional. */
export const MAX_TRANSCRIPT = 500;

export type TranscriptEntry =
  | { readonly kind: "message"; readonly message: SessionMessage }
  | { readonly kind: "sent"; readonly to: Recipient; readonly text: string; readonly result: PublishResult }
  | { readonly kind: "notice"; readonly tone: "ok" | "waiting" | "failed" | "hint"; readonly text: string }
  | { readonly kind: "gap"; readonly scope: string; readonly reason: string };

export interface ChatState {
  readonly identity: SessionIdentity;
  readonly connection: ConnectionState;
  readonly recipient: Recipient | undefined;
  readonly draft: string;
  /** Set while a send is in flight. A second Enter does nothing until its result arrives. `draft` is
   *  the composer text at submit, so the result clears it only if the user has not typed on. */
  readonly pending: { readonly to: Recipient; readonly text: string; readonly draft: string } | undefined;
  /** Leave was requested with an unsent draft: Keep editing / Discard and leave. */
  readonly confirmLeave: boolean;
  readonly transcript: readonly TranscriptEntry[];
  readonly dropped: number;
  readonly attention: AttentionMode;
  readonly channelModes: Readonly<Record<string, ChannelMode>>;
  readonly ended: CloseReport | undefined;
  /** The session reported `ended` before a close report arrived. Only leaving is possible. */
  readonly endedByEvent: boolean;
}

export function initialState(identity: SessionIdentity, recipient?: Recipient): ChatState {
  return {
    identity,
    connection: "connected",
    recipient,
    draft: "",
    pending: undefined,
    confirmLeave: false,
    transcript: [],
    dropped: 0,
    attention: "open",
    channelModes: {},
    ended: undefined,
    endedByEvent: false,
  };
}

function append(state: ChatState, entry: TranscriptEntry): ChatState {
  const next = [...state.transcript, entry];
  const over = next.length - MAX_TRANSCRIPT;
  return over > 0 ? { ...state, transcript: next.slice(over), dropped: state.dropped + over } : { ...state, transcript: next };
}

const notice = (state: ChatState, tone: "ok" | "waiting" | "failed" | "hint", text: string): ChatState => append(state, { kind: "notice", tone, text });

/** Record a front-end notice (picker disclosure, terminal limits). `text` is escaped when rendered. */
export function addNotice(state: ChatState, tone: "ok" | "waiting" | "failed" | "hint", text: string): ChatState {
  return notice(state, tone, text);
}

// ---- session events ---------------------------------------------------------------------------

/** Fold one session event. A message becomes visible state here; the caller acknowledges it only
 *  after the frame that shows it is written. */
export function applyEvent(state: ChatState, event: SessionEvent): ChatState {
  switch (event.type) {
    case "message":
      return append(state, { kind: "message", message: event.message });
    case "presence":
      return state;
    case "gap":
      return append(state, { kind: "gap", scope: event.scope, reason: event.reason });
    case "connection": {
      const s = { ...state, connection: event.state };
      if (event.state === "disconnected" || event.state === "reconnecting")
        return append(s, { kind: "gap", scope: "live", reason: event.reason ?? "disconnected: sending is off and live channel messages may be missed" });
      if (event.state === "connected" && state.connection !== "connected") return notice(s, "ok", "reconnected as the same session");
      if (event.state === "ended") {
        // The session ended under us (expiry, revocation, retirement). New sends and commands stop;
        // Ctrl-C/Ctrl-D still leave. An in-flight send keeps its pending entry so its result is still
        // recorded. The caller runs `closeSession` once to obtain the CloseReport.
        const n = notice(s, "failed", event.reason ?? "session ended; open a new session to continue");
        return { ...n, confirmLeave: false, endedByEvent: true };
      }
      return s;
    }
  }
}

// ---- input --------------------------------------------------------------------------------------

/** What the caller must do against its admitted session. Every intent acts on that session only. */
export type Intent =
  | { readonly kind: "publish"; readonly to: Recipient; readonly text: string }
  | { readonly kind: "slash"; readonly command: SlashCommand }
  | { readonly kind: "leave" }
  | { readonly kind: "pick-recipient" };

/** Normalized key input. The terminal adapter maps raw input and reports whether it can tell
 *  Shift+Enter from Enter. A bracketed paste arrives as one `paste` with all its text. */
export type Key =
  | { readonly kind: "char"; readonly text: string }
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "enter"; readonly shift: boolean }
  | { readonly kind: "backspace" }
  | { readonly kind: "tab" }
  | { readonly kind: "escape" }
  | { readonly kind: "ctrl-c" }
  | { readonly kind: "ctrl-d" };

function addToDraft(state: ChatState, text: string): ChatState {
  const room = MAX_DRAFT - state.draft.length;
  if (room <= 0) return notice(state, "waiting", `draft is at its ${MAX_DRAFT}-character limit`);
  // Never cut a surrogate pair in half at the bound.
  let piece = text.slice(0, room);
  const last = piece.charCodeAt(piece.length - 1);
  if (piece.length < text.length && last >= 0xd800 && last <= 0xdbff) piece = piece.slice(0, -1);
  const s = { ...state, draft: state.draft + piece };
  return piece.length < text.length ? notice(s, "waiting", `input truncated at the ${MAX_DRAFT}-character draft limit`) : s;
}

/**
 * Fold one key. Enter sends; Shift+Enter inserts a newline only when the terminal can tell them
 * apart (`shiftEnterDistinct`); a paste is always data and never a send. Ctrl-C / Ctrl-D leave,
 * through a confirmation when a draft exists. Nothing sends while disconnected or while a send is
 * in flight, and the draft survives both.
 */
export function applyKey(state: ChatState, key: Key, shiftEnterDistinct: boolean): { state: ChatState; intent?: Intent } {
  if (state.ended) return { state };
  if (state.endedByEvent) return key.kind === "ctrl-c" || key.kind === "ctrl-d" ? { state, intent: { kind: "leave" } } : { state };
  if (state.confirmLeave) {
    // While the leave prompt is shown only three keys act: Esc keeps editing, a second Ctrl-C or
    // Ctrl-D discards and leaves. Every other key is ignored, so Enter cannot send behind the prompt.
    if (key.kind === "ctrl-c" || key.kind === "ctrl-d") return { state: { ...state, draft: "", confirmLeave: false }, intent: { kind: "leave" } };
    if (key.kind === "escape") return { state: { ...state, confirmLeave: false } };
    return { state };
  }
  switch (key.kind) {
    case "char":
      return { state: addToDraft(state, key.text) };
    case "paste":
      return { state: addToDraft(state, key.text) };
    case "backspace": {
      const chars = [...state.draft];
      chars.pop();
      return { state: { ...state, draft: chars.join("") } };
    }
    case "tab":
      return { state, intent: { kind: "pick-recipient" } };
    case "escape":
      return { state };
    case "ctrl-c":
    case "ctrl-d":
      return state.draft.length > 0 ? { state: { ...state, confirmLeave: true } } : { state, intent: { kind: "leave" } };
    case "enter": {
      if (key.shift && shiftEnterDistinct) return { state: addToDraft(state, "\n") };
      return submit(state);
    }
  }
}

function submit(state: ChatState): { state: ChatState; intent?: Intent } {
  if (/^:to(?:\s|$)/.test(state.draft)) {
    // A line-mode command must never become a channel post, nor leave the next private line
    // addressed to the previous channel. Choosing a recipient remains the terminal picker's job.
    const next = { ...state, draft: "", recipient: undefined };
    return { state: notice(next, "failed", ":to is only available in --plain; use Tab to choose a recipient. Nothing was sent"), intent: { kind: "pick-recipient" } };
  }
  const d = submitDraft(state.draft, { recipient: state.recipient, connection: state.connection, sending: state.pending !== undefined, pick: "Tab" });
  switch (d.kind) {
    case "nothing":
      return { state };
    case "leave":
      return { state: { ...state, draft: "" }, intent: { kind: "leave" } };
    case "slash":
      return { state: { ...state, draft: "" }, intent: { kind: "slash", command: d.command } };
    case "hold":
      return d.pick
        ? { state: notice(state, d.tone, d.text), intent: { kind: "pick-recipient" } }
        : { state: notice(d.clear ? { ...state, draft: "" } : state, d.tone, d.text) };
    case "publish":
      return { state: { ...state, pending: { to: d.to, text: d.text, draft: state.draft } }, intent: { kind: "publish", to: d.to, text: d.text } };
  }
}

/** Record a publish outcome. The draft clears only when the message was stored; refused and
 *  unknown keep it and are never resent automatically. */
export function applyPublishResult(state: ChatState, result: PublishResult): ChatState {
  if (!state.pending) return state;
  const { to, text, draft: submitted } = state.pending;
  const s = append({ ...state, pending: undefined }, { kind: "sent", to, text, result });
  const settled = settlePublish({ to, draft: submitted }, result, { recipient: state.recipient, draft: state.draft });
  const next = { ...s, recipient: settled.recipient, draft: settled.draft };
  return settled.notice ? notice(next, settled.notice.tone, settled.notice.text) : next;
}

export function setRecipient(state: ChatState, recipient: Recipient): ChatState {
  return { ...state, recipient };
}

/** `/reply`: answer the latest received DM or role task still in the transcript. */
export function replyToLatest(state: ChatState): ChatState {
  const m = latestDirected(state.transcript.flatMap((e) => (e.kind === "message" ? [e.message] : [])));
  if (!m) return notice(state, "hint", "nothing to reply to: no direct message or role task is in this session's transcript");
  const to = replyRecipient(m, state.identity.principal);
  return "refused" in to ? notice(state, "hint", to.refused) : { ...state, recipient: to };
}

export function applyEnded(state: ChatState, close: CloseReport): ChatState {
  return { ...notice(state, close.retirement === "retired" ? "ok" : "waiting", closeSummary(state.identity, close)), ended: close, connection: "ended" };
}

/**
 * Fold a slash command's result. A refusal is shown as a denial with its native reason and is never
 * rendered as an empty list. `describe` turns a successful value into the lines to show; it must
 * escape untrusted text with `oneLine`. Local state that a command changes (attention, channel
 * modes) is updated only after the session confirmed it.
 */
export function applySlashResult<T>(state: ChatState, command: SlashCommand, result: Result<T>, describe: (value: T) => readonly string[]): ChatState {
  let s = state;
  if (result.outcome === "ok" && command.name === "attention") s = { ...s, attention: command.mode };
  if (result.outcome === "ok" && command.name === "channel-mode") {
    const { [command.channel]: _old, ...others } = s.channelModes;
    s = { ...s, channelModes: command.mode === "normal" ? others : { ...others, [command.channel]: command.mode } };
  }
  const outcome = slashOutcome(command, result, describe);
  return outcome.lines.reduce((acc, line) => notice(acc, outcome.tone, line), s);
}

// ---- rendering ----------------------------------------------------------------------------------

export type Tone = "ok" | "waiting" | "failed" | "hint" | "label" | "selected" | "body";

/** One rendered row: plain words that stay meaningful without color, and a tone the renderer may color. */
export interface Row {
  readonly text: string;
  readonly tone: Tone;
}

const shortUid = (uid: string): string => uid.slice(-6);

/** The senders of the received messages still in the transcript. */
export function heardFrom(state: ChatState): Person[] {
  return state.transcript.flatMap((e) => (e.kind === "message" ? [e.message.from] : []));
}

/** The header: the mesh first, as every command's report opens, then who this session is and under
 *  which mode's guarantees. Never a credential. `choose` names how a recipient is chosen. */
export function headerRows(state: ChatState, choose = "Tab"): Row[] {
  const id = state.identity;
  const until = id.expiresAt === undefined ? undefined : shownTime(id.expiresAt);
  const mode =
    id.mode === "user" ? `signed-in session${until ? ` (ends at ${until})` : ""}`
    : id.mode === "static" ? `static session (${until ? `ends at ${until}; credential valid until then` : "credential valid until expiry"})`
    : "open mesh: routing only, no identity guarantee";
  const conn: Row =
    state.connection === "connected" ? { text: "connected", tone: "ok" }
    : state.connection === "ended" ? { text: "ended", tone: "failed" }
    : { text: `${state.connection}: sending off`, tone: "waiting" };
  return [
    { text: `Mesh: ${oneLine(id.space)}`, tone: "label" },
    { text: `${oneLine(id.label)} · ${oneLine(id.principal)} · session …${shortUid(id.lifecycleUid)} · ${mode}`, tone: "label" },
    conn,
    { text: `to ${recipientLabel(state.recipient, choose)} · attention ${state.attention}`, tone: "selected" },
  ];
}

function senderOf(m: SessionMessage, shared: ReadonlyMap<string, readonly string[]>): string {
  const where = m.kind === "channel" ? `#${m.channel}` : m.kind === "anycast" ? `role ${m.service}` : "DM";
  return `${where} ${personLabel(m.from, shared)}`;
}

/** Transcript lines fitted to `width` columns. Untrusted text is escaped; a body's own newlines
 *  become separate indented lines, never a forged new entry. `shared` defaults to the names shared
 *  within `state`; a caller rendering part of a transcript passes the whole one's. */
export function transcriptRows(state: ChatState, width: number, shared = sharedNames(heardFrom(state))): Row[] {
  const rows: Row[] = [];
  if (state.dropped > 0) rows.push({ text: `… ${state.dropped} earlier entries are no longer shown`, tone: "hint" });
  const body = (prefix: string, text: string, tone: Tone): void => {
    const lines = text.split(/\r\n|\n|\r/);
    lines.forEach((line, i) => {
      const lead = i === 0 ? prefix : " ".repeat(Math.min(displayWidth(prefix), 8));
      for (const w of wrapWords(`${lead}${oneLine(line)}`, width)) rows.push({ text: w, tone });
    });
  };
  for (const e of state.transcript) {
    switch (e.kind) {
      case "message": {
        const m = e.message;
        const flags = [m.mentionsMe ? "@you" : "", m.historical ? "earlier" : "", (m.deliveryCount ?? 1) > 1 ? "redelivered" : ""].filter(Boolean).join(", ");
        body(`${shownTime(m.ts)} ${oneLine(senderOf(m, shared))}${flags ? ` (${flags})` : ""}: `, m.text, m.mentionsMe ? "selected" : "body");
        break;
      }
      case "sent": {
        const outcome = publishOutcome(e.result);
        body(`you → ${recipientLabel(e.to, "Tab")} [${outcome.text}]: `, e.text, outcome.tone === "ok" ? "body" : outcome.tone);
        break;
      }
      case "notice":
        body("", e.text, e.tone);
        break;
      case "gap":
        body("gap: ", `${e.scope}: ${e.reason}`, "waiting");
        break;
    }
  }
  return rows;
}

/** The composer and key hints. */
export function composerRows(state: ChatState, width: number, shiftEnterDistinct: boolean): Row[] {
  if (state.ended || state.endedByEvent) return [{ text: state.ended ? "session closed" : "session ended; Ctrl-D to leave, then open a new session", tone: "label" }];
  if (state.confirmLeave)
    return [{ text: "You have an unsent draft. Esc: keep editing · Ctrl-C again: discard and leave", tone: "waiting" }];
  const lines = state.draft.split("\n");
  const shown = lines.map((l, i) => ({ text: `${i === 0 ? "> " : "  "}${oneLine(l)}`, tone: "body" as Tone }));
  const keys = `Enter send${shiftEnterDistinct ? " · Shift+Enter newline" : ""} · Tab recipient · /reply /who /inbox /status · Ctrl-D leave`;
  return [...shown.flatMap((r) => wrapWords(r.text, width).map((text) => ({ text, tone: r.tone }))), ...wrapWords(keys, width).map((text) => ({ text, tone: "hint" as Tone }))];
}
