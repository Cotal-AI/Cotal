/**
 * Runs view intents against one admitted session and folds the results back into the view model.
 * Shared by the Ink front end and `--plain`. It holds no authority, opens nothing and never
 * creates a session; every call goes through the {@link AdmittedChatSession} it was given.
 */
import { oneLine } from "@cotal-ai/core";
import type { AdmittedChatSession, ChannelInfo, ConnectionReport, HistoryPage, PublishResult, Result, RosterView, SessionMessage } from "./session.js";
import { applyEnded, applyPublishResult, applySlashResult, type ChatState, type Recipient, type SlashCommand } from "./view.js";

export async function publish(session: AdmittedChatSession, to: Recipient, text: string): Promise<PublishResult> {
  switch (to.kind) {
    case "channel":
      return session.send(text, to.channel, []);
    case "dm":
      return session.dm(to.to, text, to.replyTo);
    case "role":
      return session.anycast(to.role, text);
  }
}

const rosterLines = (v: RosterView): string[] => [
  ...(v.view === "current" ? [] : [`roster ${v.view}: this list may be incomplete`]),
  ...v.rows.map((r) => `${oneLine(r.name)} · ${r.sessionKind === "chat" ? "human session" : oneLine(r.kind)}${r.role ? ` · ${oneLine(r.role)}` : ""} · ${r.status}${r.activity ? ` · ${oneLine(r.activity)}` : ""}`),
  ...(v.rows.length === 0 && v.view === "current" ? ["no one else is present"] : []),
];

const connectionLines = (c: ConnectionReport): string[] => [
  `${c.state} as ${oneLine(c.identity.principal)} (session …${c.identity.lifecycleUid.slice(-6)}, ${c.identity.mode})`,
  `joined: ${c.joinedChannels.map((ch) => `#${oneLine(ch)}`).join(" ") || "none"} · attention ${c.attention} · buffered ${c.bufferedInbox}`,
  `may read: ${c.identity.allowSubscribe.map(oneLine).join(" ") || "none"} · may post: ${c.identity.allowPublish.map(oneLine).join(" ") || "none"}`,
];

const infoLines = (i: ChannelInfo): string[] => [
  `#${oneLine(i.channel)}${i.registered ? "" : " (unregistered)"} · ${i.readable ? "readable" : "not readable"} · ${i.postable ? "postable" : "not postable"} · ${i.replay ? "replays history" : "live only"}`,
  ...(i.description ? [oneLine(i.description)] : []),
  ...(i.instructions ? [`notes: ${oneLine(i.instructions)}`] : []),
];

const messageLine = (m: SessionMessage): string =>
  `${new Date(m.ts).toISOString().slice(11, 19)} ${m.kind === "channel" ? `#${oneLine(m.channel ?? "")}` : m.kind === "dm" ? "DM" : `role ${oneLine(m.service ?? "")}`} ${oneLine(m.from.name)}: ${oneLine(m.text)}`;

const historyLines = (h: HistoryPage): string[] => [
  ...h.messages.map(messageLine),
  ...(h.messages.length === 0 ? [`no retained messages on #${oneLine(h.channel)} in this window`] : []),
  ...(h.partial ? [`partial: ${oneLine(h.note ?? "retention or bounds mean this is not the full conversation")}`] : []),
];

/**
 * Run one slash command and fold its result. `/quit` closes the session. `/history` reads the
 * current channel recipient; with no channel recipient it refuses locally with a usage hint.
 * `ack` lists delivery keys the caller acknowledges with `session.surfaced` after it has painted
 * the returned state; drained inbox items stay unacknowledged until then.
 */
export async function runSlash(session: AdmittedChatSession, state: ChatState, command: SlashCommand): Promise<{ state: ChatState; ack: readonly string[] }> {
  try {
    return await runSlashUnguarded(session, state, command);
  } catch (e) {
    // An adapter must classify; a throw means the command may or may not have taken effect.
    return { state: applySlashResult(state, command, { outcome: "unknown", message: (e as Error).message }, () => []), ack: [] };
  }
}

async function runSlashUnguarded(session: AdmittedChatSession, state: ChatState, command: SlashCommand): Promise<{ state: ChatState; ack: readonly string[] }> {
  const done = (s: ChatState): { state: ChatState; ack: readonly string[] } => ({ state: s, ack: [] });
  const fold = <T>(r: Result<T>, describe: (v: T) => readonly string[]) => done(applySlashResult(state, command, r, describe));
  const none = (): readonly string[] => [];
  switch (command.name) {
    case "who":
      return fold(await session.roster(), rosterLines);
    case "whoami":
    case "connection":
      return fold(await session.connection(), connectionLines);
    case "status":
      return fold(await session.setStatus(command.status, command.activity), none);
    case "attention":
      return fold(await session.setAttention(command.mode), none);
    case "channel-mode":
      return fold(await session.setChannelMode(command.channel, command.mode), none);
    case "join":
      return fold(await session.join(command.channel), (v) => [v.joined ? `joined #${oneLine(command.channel)}${v.backfilled ? ` (${v.backfilled} earlier messages)` : ""}${v.durable ? "" : " (live only)"}` : `not joined: ${oneLine(v.reason ?? "no reason given")}`]);
    case "leave":
      return fold(await session.leave(command.channel), (v) => [v.left ? `left #${oneLine(command.channel)}` : `still on #${oneLine(command.channel)}`]);
    case "info":
      return fold(await session.channelInfo(command.channel), infoLines);
    case "history": {
      const r = state.recipient;
      if (r?.kind !== "channel") return done(applySlashResult(state, command, { outcome: "refused", code: "USAGE_INVALID", message: "choose a channel recipient first (Tab), then /history" }, none));
      return fold(await session.history(r.channel, command.limit), historyLines);
    }
    case "inbox": {
      const res = await session.inbox(command.peek);
      const next = fold(res, (items) => [...items.map(messageLine), ...(items.length === 0 ? ["inbox empty"] : [])]);
      return res.outcome === "ok" && !command.peek ? { state: next.state, ack: res.value.map((m) => m.deliveryKey) } : next;
    }
    case "reconnect":
      return fold(await session.reconnect(), (v) => [oneLine(v.message)]);
    case "quit":
      // The view turns /quit into a `leave` intent; this branch serves a caller that routes the
      // parsed command directly. Either way the session is closed once and the summary shown.
      return done(await closeSession(session, state));
  }
}

/** Close the session for a `leave` intent or `/quit`, and fold the report. A throw from close is an
 *  unknown retirement outcome, never a success. */
export async function closeSession(session: AdmittedChatSession, state: ChatState): Promise<ChatState> {
  try {
    return applyEnded(state, await session.close());
  } catch (e) {
    return applyEnded(state, { retirement: "unknown", connectionClosed: "not-confirmed", message: (e as Error).message });
  }
}

/** Run a publish intent and fold its result. Never retried here. */
export async function runPublish(session: AdmittedChatSession, state: ChatState, to: Recipient, text: string): Promise<ChatState> {
  let result: PublishResult;
  try {
    result = await publish(session, to, text);
  } catch (e) {
    result = { outcome: "unknown", message: (e as Error).message };
  }
  return applyPublishResult(state, result);
}
