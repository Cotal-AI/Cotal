import { publishOutcome, recipientLabel, replyRecipient, settlePublish, SLASH_COMMANDS, submitDraft, type Answerable, type PublishResult, type Recipient, type SlashCommand } from "@cotal-ai/workspace/chat"
import { conversationKey, type Open } from "./screen.js"
import type { AppSlash, Outcome, TalkPhase } from "./talk.js"

/** One conversation in one space: drafts survive conversation and space switches. */
export type DraftKey = string & { readonly __draftKey: unique symbol }
export const draftKey = (space: string, open: Open) => `${space}\0${conversationKey(open)}` as DraftKey

/** The message a draft answers. Its recipient came from the reply rule, not from the open
 *  conversation, and `line` shows the human what is being answered. */
export type Quote = { id: string; to: Recipient; from: string; line: string }

/** One conversation's unsent work. */
export type Draft = { text: string; reply?: Quote }

export type Tone = Outcome["tone"]

/** The composer's state. Only the composer writes drafts. One send is in flight at a time, with the
 *  text the draft held at Enter. */
export type ComposerState = {
  drafts: Readonly<Record<DraftKey, Draft>>
  sending?: { key: DraftKey; to: Recipient; text: string }
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
  const d = submitDraft(draft.text, { recipient: at.recipient, connection: watching ? "connected" : p.connection, sending: state.sending !== undefined, pick: NO_RECIPIENT })
  switch (d.kind) {
    case "nothing":
      return { state, effect: { kind: "none" } }
    case "hold":
      return note(d.tone, d.text)
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
        state: { ...state, sending: { key, to: d.to, text: draft.text }, notice: { key, tone: "waiting", lines: [`sending to ${recipientLabel(d.to, NO_RECIPIENT)}…`] } },
        effect: { kind: "publish", to: d.to, text: d.text, ...(watching ? { open: postTo(d.to) } : {}) },
      }
  }
}

/** A send's outcome. The draft clears only when it still holds the text sent, a stored reply drops
 *  its quote, and a refused or unknown send keeps the draft and is never resent. */
export function settled(state: ComposerState, result: PublishResult): ComposerState {
  const s = state.sending
  if (!s) return state
  const draft = state.drafts[s.key] ?? { text: "" }
  const now = { recipient: draft.reply?.to, draft: draft.text }
  const out = settlePublish({ to: s.to, draft: s.text }, result, now)
  const reply = out.recipient === now.recipient ? draft.reply : undefined
  const said = publishOutcome(result)
  const lines = result.outcome === "unknown" ? [out.notice!.text] : [said.text, ...(out.notice ? [out.notice.text] : [])]
  const { sending: _, ...rest } = withDraft(state, s.key, { text: out.draft, ...(reply ? { reply } : {}) })
  return { ...rest, notice: { key: s.key, tone: out.notice?.tone ?? said.tone, lines } }
}

/** The session a first message needed did not open: nothing was sent, the draft stays, and the
 *  session's own line says why. */
export function unsent(state: ComposerState): ComposerState {
  const { sending: _, ...rest } = state
  return { ...rest, notice: undefined }
}

/** `/reply`: quote the newest direct message the session received in the draft for `key`. */
export function replyFrom(state: ComposerState, key: DraftKey, m: (Answerable & { text: string }) | undefined, self: string): ComposerState {
  const note = (line: string): ComposerState => ({ ...state, notice: { key, tone: "failed", lines: [line] } })
  if (!m) return note("no direct message to this session to reply to yet")
  const to = replyRecipient(m, self)
  if ("refused" in to) return note(to.refused)
  const line = m.text.split("\n")[0]!
  return { ...withDraft(state, key, { text: state.drafts[key]?.text ?? "", reply: { id: m.id, to, from: m.from.name, line } }), notice: undefined }
}
