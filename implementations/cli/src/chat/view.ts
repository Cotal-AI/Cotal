/**
 * The pure view model of one live chat opening (spec "Live human session", "Terminal presentation").
 * It turns session events and keystrokes into state, and state into lines. Ink, `--plain` and the
 * gallery modes all render from this one model. Nothing here performs I/O, holds authority or
 * talks to the mesh. The only way out is an {@link Intent} the caller runs against its admitted
 * session, then reports back with {@link applyPublishResult}, {@link applySlashResult} or
 * {@link applyEnded}.
 */
import { displayWidth, wrapWords } from "@cotal-ai/workspace";
import { oneLine } from "@cotal-ai/core";
import type { AttentionMode, ChannelMode } from "@cotal-ai/core";
import { shownTime } from "../lib/shown-time.js";
import type { CloseReport, ConnectionState, PublishResult, Result, SessionEvent, SessionIdentity, SessionMessage } from "./session.js";
import { offlineRecipientNotice } from "../lib/offline-recipient.js";

/** Bounded transcript retention. A dropped entry leaves a visible gap marker. Provisional. */
export const MAX_TRANSCRIPT = 500;
/** Bounded draft length, in UTF-16 code units. Provisional. */
export const MAX_DRAFT = 65_536;

/** `dm` is a typed name or principal the session resolves. `peer` is an exact principal taken from a
 *  received message, sent as is with no name lookup; its `name` is display only. */
export type Recipient =
  | { readonly kind: "channel"; readonly channel: string }
  | { readonly kind: "dm"; readonly to: string }
  | { readonly kind: "peer"; readonly principal: string; readonly name: string; readonly replyTo?: string }
  | { readonly kind: "role"; readonly role: string };

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
  const text = state.draft;
  if (text.trim() === "") return { state };
  if (text.startsWith("/") && !text.startsWith("//")) {
    const parsed = parseSlash(text);
    if (!parsed.ok) return { state: notice(state, "failed", parsed.error) };
    // /quit is leaving: the slash line itself is the only draft, so it leaves directly. Every other
    // slash command talks to the mesh, so it waits for a connection like a message does, except
    // /reconnect, /connection and /whoami, which are the ones useful while disconnected, and /reply,
    // which only picks a recipient.
    if (parsed.command.name === "quit") return { state: { ...state, draft: "" }, intent: { kind: "leave" } };
    if (state.connection !== "connected" && !runsOffline(parsed.command)) return { state: notice(state, "waiting", "not connected: only /reconnect, /connection, /whoami and /reply run now; your line is kept") };
    return { state: { ...state, draft: "" }, intent: { kind: "slash", command: parsed.command } };
  }
  if (state.connection !== "connected") return { state: notice(state, "waiting", "not connected: sending is off; your draft is kept") };
  if (state.pending) return { state: notice(state, "waiting", "the previous message is still being sent") };
  if (!state.recipient) return { state: notice(state, "hint", "choose a recipient first (Tab)"), intent: { kind: "pick-recipient" } };
  // `//text` sends a message that starts with "/".
  const body = text.startsWith("//") ? text.slice(1) : text;
  const to = state.recipient;
  return { state: { ...state, pending: { to, text: body, draft: text } }, intent: { kind: "publish", to, text: body } };
}

/** Record a publish outcome. The draft clears only when the message was stored; refused and
 *  unknown keep it and are never resent automatically. */
export function applyPublishResult(state: ChatState, result: PublishResult): ChatState {
  if (!state.pending) return state;
  const { to, text, draft: submitted } = state.pending;
  const s = append({ ...state, pending: undefined }, { kind: "sent", to, text, result });
  if (result.outcome === "stored") {
    // A reply is answered once: if the user has not picked another recipient meanwhile, the
    // recipient falls back to a plain DM to the same principal. A recipient chosen during the send is kept.
    const unchanged = state.recipient === to;
    const recipient: Recipient | undefined = unchanged && to.kind === "peer" && to.replyTo ? { kind: "peer", principal: to.principal, name: to.name } : state.recipient;
    // Only clear the draft if it is still exactly what was submitted; a user may have typed on.
    const draft = state.draft === submitted ? "" : state.draft;
    const next = { ...s, draft, recipient };
    return result.recipientStatusAtSend === "offline" && result.recipient
      ? notice(next, "waiting", offlineRecipientNotice(result.recipient.name))
      : next;
  }
  if (result.outcome === "unknown") return notice(s, "waiting", "outcome unknown: not resent; check before sending again");
  return s;
}

export function setRecipient(state: ChatState, recipient: Recipient): ChatState {
  return { ...state, recipient };
}

/** Start a reply to a received DM or role task: to its sender's principal, with no name lookup,
 *  keeping the message id as `replyTo`. A channel message is answered on its channel. */
export function replyTo(state: ChatState, m: SessionMessage): ChatState {
  if (m.kind === "channel") return state;
  return setRecipient(state, { kind: "peer", principal: m.from.id, name: m.from.name, replyTo: m.id });
}

/** The latest received DM or role task still in the transcript. */
export function latestDirected(state: ChatState): SessionMessage | undefined {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i]!;
    if (e.kind === "message" && e.message.kind !== "channel") return e.message;
  }
  return undefined;
}

/** `/reply`: answer the latest received DM or role task. */
export function replyToLatest(state: ChatState): ChatState {
  const m = latestDirected(state);
  return m ? replyTo(state, m) : notice(state, "hint", "nothing to reply to: no direct message or role task is in this session's transcript");
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
  switch (result.outcome) {
    case "refused":
      return notice(state, "failed", `/${command.name} denied (${result.code}): ${oneLine(result.message)}`);
    case "unknown":
      return notice(state, "waiting", `/${command.name} outcome unknown: ${oneLine(result.message)}`);
    case "failed":
      return notice(state, "failed", `/${command.name} failed: ${oneLine(result.message)}`);
    case "ok": {
      let s = state;
      if (command.name === "attention") s = { ...s, attention: command.mode };
      if (command.name === "channel-mode") {
        const { [command.channel]: _old, ...others } = s.channelModes;
        s = { ...s, channelModes: command.mode === "normal" ? others : { ...others, [command.channel]: command.mode } };
      }
      const lines = describe(result.value);
      if (lines.length === 0) return notice(s, "ok", `/${command.name} done`);
      return lines.reduce((acc, line) => notice(acc, "hint", line), s);
    }
  }
}

// ---- slash commands -----------------------------------------------------------------------------

export type SlashCommand =
  | { readonly name: "who" }
  | { readonly name: "whoami" }
  | { readonly name: "status"; readonly status: "idle" | "working" | "waiting"; readonly activity?: string }
  | { readonly name: "attention"; readonly mode: AttentionMode }
  | { readonly name: "channel-mode"; readonly channel: string; readonly mode: ChannelMode | "normal" }
  | { readonly name: "join"; readonly channel: string }
  | { readonly name: "leave"; readonly channel: string }
  | { readonly name: "info"; readonly channel: string }
  | { readonly name: "history"; readonly limit: number }
  | { readonly name: "inbox"; readonly peek: boolean }
  | { readonly name: "connection" }
  | { readonly name: "reconnect" }
  | { readonly name: "reply" }
  | { readonly name: "quit" };

/** Whether a slash command runs while disconnected: the reads of this session's own state, and
 *  `/reply`, which only picks a recipient. */
export function runsOffline(command: SlashCommand): boolean {
  return command.name === "reconnect" || command.name === "connection" || command.name === "whoami" || command.name === "reply";
}

/** The spec's slash set, plus `/whoami` (spec "History and presence reads"), `/reply` and `/quit`. */
export const SLASH_COMMANDS = [
  "/who", "/whoami", "/status <idle|working|waiting> [activity]", "/attention <open|dnd|focus>",
  "/quiet <channel>", "/mute <channel>", "/normal <channel>", "/join <channel>", "/leave <channel>",
  "/info <channel>", "/history [n]", "/inbox [--peek]", "/connection", "/reconnect", "/reply", "/quit",
] as const;

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 1000;

/** Parse one slash line. Channel names are checked by the session against native policy, not here. */
export function parseSlash(line: string): { ok: true; command: SlashCommand } | { ok: false; error: string } {
  const [head, ...rest] = line.trim().split(/\s+/);
  const arg = rest[0];
  const one = (name: "join" | "leave" | "info"): { ok: true; command: SlashCommand } | { ok: false; error: string } =>
    arg && rest.length === 1 ? { ok: true, command: { name, channel: arg } } : { ok: false, error: `usage: /${name} <channel>` };
  const mode = (cmd: "quiet" | "mute" | "normal", m: ChannelMode | "normal"): { ok: true; command: SlashCommand } | { ok: false; error: string } =>
    arg && rest.length === 1 ? { ok: true, command: { name: "channel-mode", channel: arg, mode: m } } : { ok: false, error: `usage: /${cmd} <channel>` };
  switch (head) {
    case "/who":
    case "/whoami":
    case "/connection":
    case "/reconnect":
    case "/reply":
    case "/quit":
    case "/exit":
      if (rest.length) return { ok: false, error: `${head} takes no arguments` };
      return { ok: true, command: { name: head === "/exit" ? "quit" : (head.slice(1) as "who" | "whoami" | "connection" | "reconnect" | "reply" | "quit") } };
    case "/status": {
      if (arg !== "idle" && arg !== "working" && arg !== "waiting") return { ok: false, error: "usage: /status <idle|working|waiting> [activity]" };
      const activity = rest.slice(1).join(" ");
      return { ok: true, command: { name: "status", status: arg, ...(activity ? { activity } : {}) } };
    }
    case "/attention":
      if ((arg !== "open" && arg !== "dnd" && arg !== "focus") || rest.length !== 1) return { ok: false, error: "usage: /attention <open|dnd|focus>" };
      return { ok: true, command: { name: "attention", mode: arg } };
    case "/quiet":
      return mode("quiet", "quiet");
    case "/mute":
      return mode("mute", "muted");
    case "/normal":
      return mode("normal", "normal");
    case "/join":
      return one("join");
    case "/leave":
      return one("leave");
    case "/info":
      return one("info");
    case "/history": {
      if (rest.length > 1) return { ok: false, error: "usage: /history [n]" };
      const n = arg === undefined ? HISTORY_DEFAULT : Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > HISTORY_MAX) return { ok: false, error: `usage: /history [n], n from 1 to ${HISTORY_MAX}` };
      return { ok: true, command: { name: "history", limit: n } };
    }
    case "/inbox":
      if (rest.length > 1 || (arg !== undefined && arg !== "--peek")) return { ok: false, error: "usage: /inbox [--peek]" };
      return { ok: true, command: { name: "inbox", peek: arg === "--peek" } };
    default:
      return { ok: false, error: `unknown command ${oneLine(head ?? "")}; try ${SLASH_COMMANDS.map((s) => s.split(" ")[0]).join(" ")}. Start a message with // to send a leading /` };
  }
}

// ---- rendering ----------------------------------------------------------------------------------

export type Tone = "ok" | "waiting" | "failed" | "hint" | "label" | "selected" | "body";

/** One rendered row: plain words that stay meaningful without color, and a tone the renderer may color. */
export interface Row {
  readonly text: string;
  readonly tone: Tone;
}

const shortUid = (uid: string): string => uid.slice(-6);

export function recipientLabel(r: Recipient | undefined): string {
  if (!r) return "no recipient (Tab)";
  if (r.kind === "channel") return `#${oneLine(r.channel)}`;
  if (r.kind === "role") return `role ${oneLine(r.role)}`;
  if (r.kind === "peer") return `DM ${oneLine(r.name)} (${oneLine(r.principal)})${r.replyTo ? " (reply)" : ""}`;
  return `DM ${oneLine(r.to)}`;
}

/** A principal and the display name it carries. */
export interface Person {
  readonly id: string;
  readonly name: string;
}

const nameKey = (name: string): string => name.trim().toLowerCase();

/** Each display name more than one principal carries among `people`, with those principals. Names
 *  compare trimmed and case-insensitively. */
export function sharedNames(people: Iterable<Person>): ReadonlyMap<string, readonly string[]> {
  const ids = new Map<string, Set<string>>();
  for (const p of people) {
    const key = nameKey(p.name);
    const seen = ids.get(key) ?? new Set<string>();
    seen.add(p.id);
    ids.set(key, seen);
  }
  return new Map([...ids].filter(([, seen]) => seen.size > 1).map(([key, seen]) => [key, [...seen]]));
}

/** A person's display name, followed by their principal when another principal shares the name.
 *  Unescaped: the caller escapes it like any other untrusted text. */
export function personLabel(p: Person, shared: ReadonlyMap<string, readonly string[]>): string {
  return shared.has(nameKey(p.name)) ? `${p.name} (${p.id})` : p.name;
}

/** The senders of the received messages still in the transcript. */
export function heardFrom(state: ChatState): Person[] {
  return state.transcript.flatMap((e) => (e.kind === "message" ? [e.message.from] : []));
}

/** The header: the mesh first, as every command's report opens, then who this session is and under
 *  which mode's guarantees. Never a credential. */
export function headerRows(state: ChatState): Row[] {
  const id = state.identity;
  const mode =
    id.mode === "user" ? "signed-in session"
    : id.mode === "static" ? "static session (credential valid until expiry)"
    : "open mesh: routing only, no identity guarantee";
  const conn: Row =
    state.connection === "connected" ? { text: "connected", tone: "ok" }
    : state.connection === "ended" ? { text: "ended", tone: "failed" }
    : { text: `${state.connection}: sending off`, tone: "waiting" };
  return [
    { text: `Mesh: ${oneLine(id.space)}`, tone: "label" },
    { text: `${oneLine(id.label)} · ${oneLine(id.principal)} · session …${shortUid(id.lifecycleUid)} · ${mode}`, tone: "label" },
    conn,
    { text: `to ${recipientLabel(state.recipient)} · attention ${state.attention}`, tone: "selected" },
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
        const r = e.result;
        const status = r.outcome === "stored" ? "stored" : r.outcome === "refused" ? `denied: ${oneLine(r.message)}` : "outcome unknown, not resent";
        body(`you → ${recipientLabel(e.to)} [${status}]: `, e.text, r.outcome === "stored" ? "body" : r.outcome === "refused" ? "failed" : "waiting");
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

/** The exit summary. It reports only what the session observed, and never says messages were
 *  erased: retention follows the space policy. */
export function closeSummary(identity: SessionIdentity, close: CloseReport): string {
  const parts: string[] = [];
  switch (close.retirement) {
    case "retired":
      parts.push("session retired");
      break;
    case "requested":
      parts.push("retirement requested; not yet confirmed");
      break;
    case "unknown":
      parts.push("retirement outcome unknown");
      break;
    case "not-applicable":
      parts.push("open mesh session ended (no lifecycle to retire)");
      break;
  }
  if (close.connectionClosed === "not-confirmed") parts.push("connection closure not confirmed");
  if (identity.mode === "static" && close.credentialValidUntil !== undefined && close.connectionClosed !== "confirmed")
    parts.push(`its credential stays valid until ${new Date(close.credentialValidUntil).toISOString()}`);
  parts.push("messages already sent remain under the space's retention policy");
  return parts.join("; ");
}
