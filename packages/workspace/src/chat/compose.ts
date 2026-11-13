/**
 * The rules every human chat front end shares: where a draft goes, what Enter does with it, what a
 * send or a slash command's result says, and how people and a session's end are named. Nothing here
 * holds state. A front end keeps its own state and folds these decisions into it.
 */
import { assertValidRole, mentionsIn, oneLine } from "@cotal-ai/core";
import type { AttentionMode, ChannelMode } from "@cotal-ai/core";
import { concreteChannelProblem, offlineRecipientNotice, shownTime } from "../messaging.js";
import type { AdmittedChatSession, CloseReport, ConnectionReport, ConnectionState, PublishResult, Result, SessionIdentity } from "./session.js";
import type { ChatWords } from "./words.js";

/** Bounded draft length, in UTF-16 code units. Provisional. */
export const MAX_DRAFT = 65_536;

/** `dm` is a typed name or principal the session resolves. `peer` is an exact principal taken from a
 *  received message, sent as is with no name lookup; its `name` is display only. A `replyTo` names
 *  the message a channel post or a peer DM answers. */
export type Recipient =
  | { readonly kind: "channel"; readonly channel: string; readonly replyTo?: string }
  | { readonly kind: "dm"; readonly to: string }
  | { readonly kind: "peer"; readonly principal: string; readonly name: string; readonly replyTo?: string }
  | { readonly kind: "role"; readonly role: string };

/** The fields the reply rule reads. A `SessionMessage` has them. */
export interface Answerable {
  readonly id: string;
  readonly kind: "channel" | "dm" | "anycast";
  readonly from: { readonly id: string; readonly name: string };
  readonly channel?: string;
}

/**
 * Parse an explicitly typed recipient: `#channel`, `@name-or-id`, `role:<role>`. A bare word is not
 * guessed. Returns the refusal text instead of throwing; `pick` names the front end's other way to
 * choose one.
 */
export function parseRecipient(text: string, pick: string): { ok: true; recipient: Recipient } | { ok: false; error: string } {
  const t = text.trim();
  if (t.startsWith("#")) {
    const ch = t.slice(1);
    const problem = concreteChannelProblem(ch);
    if (problem) return { ok: false, error: oneLine(problem) };
    return { ok: true, recipient: { kind: "channel", channel: ch } };
  }
  if (t.startsWith("@")) {
    const to = t.slice(1);
    if (!to || /\s/.test(to) || to.length > 512) return { ok: false, error: "usage: @<name or owner.actor>" };
    return { ok: true, recipient: { kind: "dm", to } };
  }
  if (t.startsWith("role:")) {
    const role = t.slice(5);
    try {
      assertValidRole(role);
    } catch (e) {
      return { ok: false, error: oneLine((e as Error).message) };
    }
    return { ok: true, recipient: { kind: "role", role } };
  }
  return { ok: false, error: `type #channel, @name or role:<role>, or ${pick}` };
}

/** How a recipient reads. `choose` names how a front end picks one, for when there is none. */
export function recipientLabel(r: Recipient | undefined, choose: string): string {
  if (!r) return `no recipient (${choose})`;
  if (r.kind === "channel") return `#${oneLine(r.channel)}${r.replyTo ? " (reply)" : ""}`;
  if (r.kind === "role") return `role ${oneLine(r.role)}`;
  if (r.kind === "peer") {
    const who = r.name.trim() ? `${oneLine(r.name)} (${oneLine(r.principal)})` : oneLine(r.principal);
    return `DM ${who}${r.replyTo ? " (reply)" : ""}`;
  }
  return `DM ${oneLine(r.to)}`;
}

/** Where a reply to `m` goes, keeping its id as `replyTo`. A channel message is answered on its
 *  channel, your own included. A DM or role task is answered by a DM to its sender's principal, with
 *  no name lookup; one that `self` sent refuses, because the answer would reach no one else. */
export function replyRecipient(m: Answerable, self: string): Recipient | { readonly refused: string } {
  if (m.kind === "channel") {
    if (m.channel === undefined) throw new Error(`channel message ${m.id} names no channel`);
    return { kind: "channel", channel: m.channel, replyTo: m.id };
  }
  if (m.from.id === self) return { refused: "that is your own message" };
  return { kind: "peer", principal: m.from.id, name: m.from.name, replyTo: m.id };
}

/** The newest DM or role task among `messages`, which run oldest first. */
export function latestDirected<T extends Answerable>(messages: readonly T[]): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.kind !== "channel") return messages[i];
  return undefined;
}

/** What Enter does with a draft. `slash` and `leave` consume the line. A `hold` with `clear` is a
 *  slash command the grammar refused: the line is shown as the refusal and then cleared, so the next
 *  command is not typed onto it. Every other `hold` keeps the line, and a `hold` with `pick` asks the
 *  front end to choose a recipient. */
export type Submit =
  | { readonly kind: "nothing" }
  | { readonly kind: "leave" }
  | { readonly kind: "slash"; readonly command: SlashCommand }
  | { readonly kind: "hold"; readonly tone: "waiting" | "failed" | "hint"; readonly text: string; readonly pick?: true; readonly clear?: true }
  | { readonly kind: "publish"; readonly to: Recipient; readonly text: string };

/**
 * The Enter rule. A blank draft does nothing. A line that starts with one `/` is a slash command:
 * `/quit` leaves, and every other command waits for a connection unless it {@link runsOffline}.
 * A message waits for a connection and for the previous send, then needs a recipient; `pick` names
 * how one is chosen. `//text` sends `/text`.
 */
export function submitDraft(
  draft: string,
  at: { readonly recipient: Recipient | undefined; readonly connection: ConnectionState; readonly sending: boolean; readonly pick: string },
): Submit {
  if (draft.trim() === "") return { kind: "nothing" };
  if (draft.startsWith("/") && !draft.startsWith("//")) {
    const parsed = parseSlash(draft);
    if (!parsed.ok) return { kind: "hold", tone: "failed", text: parsed.error, clear: true };
    if (parsed.command.name === "quit") return { kind: "leave" };
    if (at.connection !== "connected" && !runsOffline(parsed.command)) return { kind: "hold", tone: "waiting", text: "not connected: only /reconnect, /connection, /whoami, /reply and /help run now; your line is kept" };
    return { kind: "slash", command: parsed.command };
  }
  if (at.connection !== "connected") return { kind: "hold", tone: "waiting", text: "not connected: sending is off; your draft is kept" };
  if (at.sending) return { kind: "hold", tone: "waiting", text: "the previous message is still being sent" };
  if (!at.recipient) return { kind: "hold", tone: "hint", text: `choose a recipient first (${at.pick})`, pick: true };
  return { kind: "publish", to: at.recipient, text: draft.startsWith("//") ? draft.slice(1) : draft };
}

/** Send `text` to `to` through the session: a channel post carrying the `@names` its text holds as
 *  mentions, a DM by name or by principal, or a role task. */
export async function publish(session: AdmittedChatSession, to: Recipient, text: string): Promise<PublishResult> {
  switch (to.kind) {
    case "channel":
      return session.send(text, to.channel, mentionsIn(text), to.replyTo);
    case "dm":
      return session.dm(to.to, text);
    case "peer":
      return session.dm({ principal: to.principal }, text, to.replyTo);
    case "role":
      return session.anycast(to.role, text);
  }
}

/**
 * What a publish outcome leaves. Stored clears the draft only when it still holds what was sent, and
 * answers a reply once: a recipient not changed during the send (the same object) drops its
 * `replyTo`. Stored to an offline agent, or an unknown outcome, adds a notice; an unknown outcome is
 * never resent. A refusal changes nothing.
 */
export function settlePublish(
  sent: { readonly to: Recipient; readonly draft: string },
  result: PublishResult,
  now: { readonly recipient: Recipient | undefined; readonly draft: string },
): { readonly recipient: Recipient | undefined; readonly draft: string; readonly notice?: { readonly tone: "waiting"; readonly text: string } } {
  if (result.outcome === "unknown") return { ...now, notice: { tone: "waiting", text: "outcome unknown: not resent; check before sending again" } };
  if (result.outcome !== "stored") return now;
  const to = sent.to;
  const recipient: Recipient | undefined = now.recipient === to && (to.kind === "channel" || to.kind === "peer") && to.replyTo ? withoutReply(to) : now.recipient;
  const draft = now.draft === sent.draft ? "" : now.draft;
  return result.recipientStatusAtSend === "offline" && result.recipient
    ? { recipient, draft, notice: { tone: "waiting", text: offlineRecipientNotice(result.recipient.name) } }
    : { recipient, draft };
}

function withoutReply(to: Extract<Recipient, { replyTo?: string }>): Recipient {
  return to.kind === "channel" ? { kind: "channel", channel: to.channel } : { kind: "peer", principal: to.principal, name: to.name };
}

/** The status words of a sent message. */
export function publishOutcome(result: PublishResult): { readonly tone: "ok" | "failed" | "waiting"; readonly text: string } {
  if (result.outcome === "stored") return { tone: "ok", text: "stored" };
  if (result.outcome === "refused") return { tone: "failed", text: `denied: ${oneLine(result.message)}` };
  return { tone: "waiting", text: "outcome unknown, not resent" };
}

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
  | { readonly name: "help" }
  | { readonly name: "quit" };

/** Whether a slash command runs while disconnected: the reads of this session's own state, `/reply`,
 *  which only picks a recipient, and `/help`. */
export function runsOffline(command: SlashCommand): boolean {
  return command.name === "reconnect" || command.name === "connection" || command.name === "whoami" || command.name === "reply" || command.name === "help";
}

/** The spec's slash set, plus `/whoami` (spec "History and presence reads"), `/reply`, `/help` and `/quit`. */
export const SLASH_COMMANDS = [
  "/who", "/whoami", "/status <idle|working|waiting> [activity]", "/attention <open|dnd|focus>",
  "/quiet <channel>", "/mute <channel>", "/normal <channel>", "/join <channel>", "/leave <channel>",
  "/info <channel>", "/history [n]", "/inbox [--peek]", "/connection", "/reconnect", "/reply", "/help", "/quit",
] as const;

/** The `/help` answer: every slash command with its arguments. */
export const slashHelp = `commands: ${SLASH_COMMANDS.join(", ")}. Start a message with // to send a leading /`;

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 1000;

/** Parse one slash line. A channel may be written with its `#`, as the view prints it. Channel names
 *  are checked by the session against native policy, not here. */
export function parseSlash(line: string): { ok: true; command: SlashCommand } | { ok: false; error: string } {
  const [head, ...rest] = line.trim().split(/\s+/);
  const arg = rest[0];
  const channel = arg?.replace(/^#/, "");
  const one = (name: "join" | "leave" | "info"): { ok: true; command: SlashCommand } | { ok: false; error: string } =>
    channel && rest.length === 1 ? { ok: true, command: { name, channel } } : { ok: false, error: `usage: /${name} <channel>` };
  const mode = (cmd: "quiet" | "mute" | "normal", m: ChannelMode | "normal"): { ok: true; command: SlashCommand } | { ok: false; error: string } =>
    channel && rest.length === 1 ? { ok: true, command: { name: "channel-mode", channel, mode: m } } : { ok: false, error: `usage: /${cmd} <channel>` };
  switch (head) {
    case "/who":
    case "/whoami":
    case "/connection":
    case "/reconnect":
    case "/reply":
    case "/help":
    case "/quit":
    case "/exit":
      if (rest.length) return { ok: false, error: head === "/reply"
        ? "/reply takes no arguments; it answers the latest direct message or role task, and the message is typed after it"
        : `${head} takes no arguments` };
      return { ok: true, command: { name: head === "/exit" ? "quit" : (head.slice(1) as "who" | "whoami" | "connection" | "reconnect" | "reply" | "help" | "quit") } };
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

/**
 * The words of a slash command's result. A refusal is shown as a denial with its native reason and
 * is never rendered as an empty list. `describe` turns a successful value into the lines to show; it
 * must escape untrusted text with `oneLine`.
 */
export function slashOutcome<T>(
  command: SlashCommand,
  result: Result<T>,
  describe: (value: T) => readonly string[],
): { readonly tone: "ok" | "waiting" | "failed" | "hint"; readonly lines: readonly string[] } {
  switch (result.outcome) {
    case "refused":
      return { tone: "failed", lines: [`/${command.name} denied (${result.code}): ${oneLine(result.message)}`] };
    case "unknown":
      return { tone: "waiting", lines: [`/${command.name} outcome unknown: ${oneLine(result.message)}`] };
    case "failed":
      return { tone: "failed", lines: [`/${command.name} failed: ${oneLine(result.message)}`] };
    case "ok": {
      const lines = describe(result.value);
      return lines.length === 0 ? { tone: "ok", lines: [`/${command.name} done`] } : { tone: "hint", lines };
    }
  }
}

/** The `/whoami` and `/connection` answer: who this session is, where it is joined, and its grant. */
export function describeConnection(c: ConnectionReport): string[] {
  return [
    `${c.state} as ${oneLine(c.identity.principal)} (session …${c.identity.lifecycleUid.slice(-6)}, ${c.identity.mode})`,
    `joined: ${c.joinedChannels.map((ch) => `#${oneLine(ch)}`).join(" ") || "none"} · attention ${c.attention} · buffered ${c.bufferedInbox}`,
    `may read: ${c.identity.allowSubscribe.map(oneLine).join(" ") || "none"} · may post: ${c.identity.allowPublish.map(oneLine).join(" ") || "none"}`,
  ];
}

/**
 * Disclose what a chosen channel is before it is used: unregistered channels get a visible warning
 * (the native policy, not this UI, decides whether a send is allowed). A refused or failed read is
 * reported as such, never as "registered". One outside the post grant ends with the front end's way
 * to open a session on it, as a send's refusal does. Non-channel recipients need no read.
 */
export async function discloseChoice(session: AdmittedChatSession, r: Recipient, words: ChatWords): Promise<string | undefined> {
  if (r.kind !== "channel") return undefined;
  let info;
  try {
    info = await session.channelInfo(r.channel);
  } catch (e) {
    return `could not read #${oneLine(r.channel)} registry metadata: ${oneLine((e as Error).message)}`;
  }
  if (info.outcome !== "ok") return `could not read #${oneLine(r.channel)} registry metadata (${info.outcome}): ${oneLine(info.message)}`;
  const parts: string[] = [];
  if (!info.value.registered) parts.push(`Unregistered channel #${oneLine(r.channel)}: sends follow the space's native policy`);
  if (!info.value.postable) parts.push(`your grant does not allow posting to #${oneLine(r.channel)}. ${words.reopen(r.channel)}`);
  return parts.length ? parts.join("; ") : undefined;
}

/** Whether a message's `mentions` name `name`: the whole name, ignoring case. Advisory only: the
 *  payload's list is forgeable, so it changes visibility, never authority. */
export function mentionsName(mentions: readonly string[] | undefined, name: string): boolean {
  const want = name.toLowerCase();
  return (mentions ?? []).some((x) => x.toLowerCase() === want);
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
 *  A blank name is not one, so the label is the principal. Unescaped: the caller escapes it like
 *  any other untrusted text. */
export function personLabel(p: Person, shared: ReadonlyMap<string, readonly string[]>): string {
  if (!p.name.trim()) return p.id;
  return shared.has(nameKey(p.name)) ? `${p.name} (${p.id})` : p.name;
}

/** How long before a session's set end a front end says it is ending. */
export const ENDING_NOTICE_MS = 60_000;

/** The notice a session with a set end gets {@link ENDING_NOTICE_MS} before it, and when it is due.
 *  Undefined for a session without a set end. */
export function endingNotice(identity: SessionIdentity): { readonly at: number; readonly text: string } | undefined {
  if (identity.expiresAt === undefined) return undefined;
  return { at: identity.expiresAt - ENDING_NOTICE_MS, text: `this session ends at ${shownTime(identity.expiresAt)}; open a new session to keep chatting after that` };
}

/** The summary a session's close leaves. It reports only what the session observed, and never says
 *  messages were erased: retention follows the space policy. */
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
