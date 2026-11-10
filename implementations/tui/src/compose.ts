import { publishOutcome, recipientLabel, replyRecipient, settlePublish, SLASH_COMMANDS, submitDraft, type Answerable, type PublishResult, type Recipient, type SlashCommand } from "@cotal-ai/workspace/chat"
import type { FeedEntry } from "./live.js"
import { isYou, type DraftKey, type Open } from "./screen.js"
import type { AppSlash, Outcome, TalkPhase, You } from "./talk.js"

/** The message a draft answers. Its recipient came from the reply rule, not from the open
 *  conversation, and `line` shows the human what is being answered. */
export type Quote = { id: string; to: Recipient; from: string; line: string }

/** One conversation's unsent work. */
export type Draft = { text: string; reply?: Quote }

export type Tone = Outcome["tone"]

/** A send in flight: the conversation it was typed in, where it goes, and the text its draft held at
 *  Enter. */
type Sending = { key: DraftKey; to: Recipient; text: string }

/** The composer's state. Only the composer writes drafts. */
export type ComposerState = {
  drafts: Readonly<Record<DraftKey, Draft>>
  /** Each space's send in flight. A space sends one message at a time, and a send in one space
   *  never holds up another. */
  sending: Readonly<Record<string, Sending>>
  /** The latest outcome or refusal, shown under the draft it belongs to. */
  notice?: { key: DraftKey; tone: Tone; lines: readonly string[] }
}

/** What Enter asks the app to do. A publish with `open` is the first message while watching: the
 *  session opens, then the message goes, and nothing goes when the session does not open. A plain
 *  `open` reopens after a session ended or was refused and never sends. */
export type Effect =
  | { kind: "none" }
  | { kind: "open"; postTo?: string }
  | { kind: "publish"; to: Recipient; text: string; open?: { postTo?: string } }
  | { kind: "slash"; command: AppSlash }
  | { kind: "reply-latest" }
  | { kind: "end" }

/** How the Enter rule names the missing recipient: all traffic has none. */
const NO_RECIPIENT = "open a channel or an agent"
const postTo = (r: Recipient | undefined) => (r?.kind === "channel" ? { postTo: r.channel } : {})

/** Which shared commands the app runs, and why the rest do not. A record over every shared name, so
 *  a new shared command fails the build until it is classified here. */
export const APP_SLASH: Readonly<Record<SlashCommand["name"], "run" | "tree" | "cli">> = {
  who: "tree",
  whoami: "run",
  status: "run",
  attention: "cli",
  "channel-mode": "cli",
  join: "cli",
  leave: "cli",
  info: "cli",
  history: "cli",
  inbox: "cli",
  connection: "run",
  reconnect: "run",
  reply: "run",
  help: "run",
  quit: "run",
}

/** `/help` in the app: the shared commands it runs, with their arguments. */
export const appSlashHelp = () =>
  `commands: ${SLASH_COMMANDS.filter((s) => APP_SLASH[s.split(" ")[0]!.slice(1) as SlashCommand["name"]] === "run").join(", ")}. Start a message with // to send a leading /`

const withDraft = (state: ComposerState, key: DraftKey, draft: Draft): ComposerState => {
  const drafts = { ...state.drafts }
  if (draft.text === "" && !draft.reply) delete drafts[key]
  else drafts[key] = draft
  return { ...state, drafts }
}

/** The textarea changed. */
export const edited = (state: ComposerState, key: DraftKey, text: string): ComposerState => withDraft(state, key, { ...state.drafts[key], text })

/** Enter. The session's phase first, then the shared rule. While watching, only a message opens the
 *  session; a blank line or a command leaves the human unseen. */
export function submit(
  state: ComposerState,
  key: DraftKey,
  at: { space: string; phase: TalkPhase; name?: string; recipient: Recipient | undefined },
): { state: ComposerState; effect: Effect } {
  const draft = state.drafts[key] ?? { text: "" }
  const note = (tone: Tone, line: string, effect: Effect = { kind: "none" }) => ({ state: { ...state, notice: { key, tone, lines: [line] } }, effect })
  const consumed = (effect: Effect, notice?: ComposerState["notice"]) => ({ state: { ...withDraft(state, key, { ...draft, text: "" }), notice }, effect })
  const p = at.phase
  if (p.phase === "opening") return note("waiting", `still joining ${at.space} as ${p.name}; your draft is kept`)
  if (p.phase === "ended" || p.phase === "refused") {
    const open: Effect = { kind: "open", ...postTo(at.recipient) }
    return p.phase === "ended" && at.name ? note("hint", `new session as ${at.name}; enter sends`, open) : { state: { ...state, notice: undefined }, effect: open }
  }
  const watching = p.phase === "watching"
  const d = submitDraft(draft.text, { recipient: at.recipient, connection: watching ? "connected" : p.connection, sending: state.sending[at.space] !== undefined, pick: NO_RECIPIENT })
  switch (d.kind) {
    case "nothing":
      return { state, effect: { kind: "none" } }
    case "hold":
      return d.clear ? consumed({ kind: "none" }, { key, tone: d.tone, lines: [d.text] }) : note(d.tone, d.text)
    case "leave":
      return watching ? note("hint", "no chat session is open") : consumed({ kind: "end" })
    case "slash": {
      const c = d.command
      const head = draft.text.trim().split(/\s+/)[0]
      if (APP_SLASH[c.name] === "tree") return note("failed", `${head} is not in the app; the tree lists who is here`)
      if (APP_SLASH[c.name] === "cli") return note("failed", `${head} is not in the app; run it in \`cotal chat\``)
      if (c.name === "help") return consumed({ kind: "none" }, { key, tone: "hint", lines: [appSlashHelp()] })
      if (watching) return note("hint", `${head} needs a chat session, which your first message opens`)
      if (c.name === "reply") return consumed({ kind: "reply-latest" })
      return consumed({ kind: "slash", command: c as AppSlash })
    }
    case "publish":
      return {
        state: { ...state, sending: { ...state.sending, [at.space]: { key, to: d.to, text: draft.text } }, notice: { key, tone: "waiting", lines: [`sending to ${recipientLabel(d.to, NO_RECIPIENT)}…`] } },
        effect: { kind: "publish", to: d.to, text: d.text, ...(watching ? { open: postTo(d.to) } : {}) },
      }
  }
}

/** `space`'s send settled: its slot frees, and the notice under the draft it was typed in goes. */
function sent(state: ComposerState, space: string, s: Sending): ComposerState {
  const { [space]: _, ...sending } = state.sending
  return { ...state, sending, notice: state.notice?.key === s.key ? undefined : state.notice }
}

/** `space`'s send has its outcome. The draft clears only when it still holds the text sent, a stored
 *  reply drops its quote, and a refused or unknown send keeps the draft and is never resent. A plain
 *  stored send says nothing: the message shows in the conversation. */
export function settled(state: ComposerState, space: string, result: PublishResult): ComposerState {
  const s = state.sending[space]
  if (!s) return state
  const draft = state.drafts[s.key] ?? { text: "" }
  const now = { recipient: draft.reply?.to, draft: draft.text }
  const out = settlePublish({ to: s.to, draft: s.text }, result, now)
  const reply = out.recipient === now.recipient ? draft.reply : undefined
  const said = publishOutcome(result)
  const lines = result.outcome === "unknown" ? [out.notice!.text] : [said.text, ...(out.notice ? [out.notice.text] : [])]
  const rest = sent(withDraft(state, s.key, { text: out.draft, ...(reply ? { reply } : {}) }), space, s)
  if (result.outcome === "stored" && !out.notice) return rest
  return { ...rest, notice: { key: s.key, tone: out.notice?.tone ?? said.tone, lines } }
}

/** The session `space`'s first message needed did not open: nothing was sent, the draft stays, and
 *  the session's own line or the space's close says why. */
export function unsent(state: ComposerState, space: string): ComposerState {
  const s = state.sending[space]
  return s ? sent(state, space, s) : state
}

type Quotable = Answerable & { text: string }
type Refused = { readonly refused: string }

/** Where a reply to `m` goes. A direct message or role task from the human refuses, from any of their
 *  sessions. One under their name that the app did not open, in this run or an earlier one it
 *  remembers, may be another person's, so its refusal says only that. */
function answer(m: Answerable, you: You): Recipient | Refused {
  if (m.kind !== "channel" && !you.principals.has(m.from.id) && isYou(you, m.from)) return { refused: "that is from another session under your name" }
  return replyRecipient(m, you.principals.has(m.from.id) ? m.from.id : "")
}

/** Where a reply to a row of the `open` conversation goes, or why the row cannot be quoted. A direct
 *  conversation quotes only direct messages. A direct message is answered only by a recipient, which
 *  is a session the app opened, in this run or an earlier one it remembers: a name match could be
 *  another person's session. A burst
 *  coalesced into one row keeps its first copy's id, so the row answers only when that copy came to
 *  the human. */
function rowAnswer(e: FeedEntry, you: You, open: Open): Recipient | Refused {
  if (e.delivery === "multicast" && open.kind === "peer") return { refused: `that is a #${e.channel} post; reply to it in #${e.channel}` }
  if (e.delivery === "unicast" && !isYou(you, e.from)) {
    const yours = (e.toIds ?? []).map((id) => you.principals.has(id))
    if (!yours.includes(true)) return { refused: "that direct message was not sent to you" }
    if (!yours[0]) return { refused: `that message went to several recipients; ${open.kind === "peer" && open.id === e.from.id ? "answer its sender here without a quote" : "open its sender in the tree to answer"}` }
  }
  return answer(answerable(e), you)
}

/** A conversation row as the reply rule reads it. */
const answerable = (e: FeedEntry): Quotable => ({
  id: e.id,
  kind: e.delivery === "multicast" ? "channel" : e.delivery === "unicast" ? "dm" : "anycast",
  from: e.from,
  ...(e.channel === undefined ? {} : { channel: e.channel }),
  text: e.text,
})

/** Quotes `m` in the draft for `key`, keeping its text. `to` is where the reply rule sends it. */
function quote(state: ComposerState, key: DraftKey, m: Quotable, to: Recipient | Refused): ComposerState {
  if ("refused" in to) return { ...state, notice: { key, tone: "failed", lines: [to.refused] } }
  const line = m.text.split("\n")[0]!
  return { ...withDraft(state, key, { text: state.drafts[key]?.text ?? "", reply: { id: m.id, to, from: m.from.name, line } }), notice: undefined }
}

/** `/reply`: quote the newest direct message the session received in the draft for `key`. */
export function replyFrom(state: ComposerState, key: DraftKey, m: Quotable | undefined, you: You): ComposerState {
  if (!m) return { ...state, notice: { key, tone: "failed", lines: ["no direct message to this session to reply to yet"] } }
  return quote(state, key, m, answer(m, you))
}

/** Quotes a row of the `open` conversation, as a click or `↑` `↓` picks it. */
export const quoteRow = (state: ComposerState, key: DraftKey, e: FeedEntry, you: You, open: Open) => quote(state, key, answerable(e), rowAnswer(e, you, open))

/** `esc`: the draft drops its quote and keeps its text. */
export function unquote(state: ComposerState, key: DraftKey): ComposerState {
  const d = state.drafts[key]
  return d?.reply ? withDraft(state, key, { text: d.text }) : state
}

/** The rows of the `open` conversation a quote moves through, oldest first: event traffic and the rows
 *  the reply rule refuses, such as the human's own direct messages, are passed over. */
export const quotable = (feed: readonly FeedEntry[], you: You, open: Open) => feed.filter((e) => !e.events && !("refused" in rowAnswer(e, you, open)))

/** `↑` (-1) or `↓` (1) on an empty box moves the quote through `rows`. With no quote, or one not
 *  among them, it starts below the newest. `↑` stops at the oldest; `↓` past the newest drops it. */
export function walk(state: ComposerState, key: DraftKey, rows: readonly FeedEntry[], you: You, open: Open, by: -1 | 1): ComposerState {
  const at = rows.findIndex((e) => e.id === state.drafts[key]?.reply?.id)
  const next = (at < 0 ? rows.length : at) + by
  if (next >= rows.length) return unquote(state, key)
  const e = rows[Math.max(0, next)]
  return e ? quoteRow(state, key, e, you, open) : state
}
