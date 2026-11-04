import { CommandFailure, isCommandFailure, isConnectRefusal, oneLine, readPreferences, writePreference, type MeshTarget } from "@cotal-ai/workspace"
import {
  closeSummary,
  describeConnection,
  discloseChoice,
  latestDirected,
  mentionsName,
  nameInUse,
  nameInUseText,
  openChatSession,
  publish as publishTo,
  resolveChatName,
  slashOutcome,
  USER_CHAT_TTL_SEC,
  type AdmittedChatSession,
  type ChatAdmission,
  type ChatName,
  type ChatWords,
  type ConnectionState,
  type PublishResult,
  type Recipient,
  type SessionIdentity,
  type SessionMessage,
  type SlashCommand,
} from "@cotal-ai/workspace/chat"
import type { ControlClient } from "@cotal-ai/workspace/control"
import type { FeedEntry } from "@cotal-ai/workspace/view"
import { createSignal, type Accessor } from "solid-js"
import { safe } from "./safe.js"

/** The human's chat session in the open space. `watching` has none: the human is invisible to peers. */
export type TalkPhase =
  | { phase: "watching" }
  | { phase: "opening"; name: string }
  | { phase: "open"; identity: SessionIdentity; connection: ConnectionState; shared?: string }
  | { phase: "ended"; name: string; at: number; why: string }
  | { phase: "refused"; message: string; remedy?: string }

/** The name the next session appears as, resolved when the space opens and again at each open. */
export type NameState = { state: "resolving" } | { state: "ok"; name: ChatName } | { state: "refused"; message: string; remedy?: string }

/** The directed messages the session received and sent, as feed rows. */
export type OwnTraffic = { received: readonly FeedEntry[]; sent: readonly FeedEntry[] }

/** The slash commands the app runs against its session. */
export type AppSlash = Extract<SlashCommand, { name: "whoami" | "connection" | "reconnect" | "status" }>

export type Outcome = { tone: "ok" | "waiting" | "failed" | "hint"; lines: readonly string[] }

/** How a chat session's close went, for the app to show. `clean` when the connection closed and
 *  the session was retired, or had nothing to retire. */
export type Closed = { clean: boolean; summary: string }

export interface Talk {
  readonly phase: Accessor<TalkPhase>
  readonly name: Accessor<NameState>
  readonly own: Accessor<OwnTraffic>
  /** Opens a session when none is open. Never sends. A static or user session may post to
   *  `postTo` only. */
  open(postTo?: string): Promise<void>
  publish(to: Recipient, text: string): Promise<PublishResult>
  slash(command: AppSlash): Promise<Outcome>
  /** The newest direct message or role task the session received. */
  latest(): SessionMessage | undefined
  /** The picker's warning for a channel it offers, such as an unregistered one. */
  disclose(r: Recipient): Promise<string | undefined>
  /** Whether a row's mentions name the human, under the open session's name or the next one's. */
  mentionsYou(e: FeedEntry): boolean
  /** `/quit` and End your chat session. */
  end(): Promise<Closed | undefined>
  /** Saves the `name` preference, or unsets it, and resolves the name again. An open session keeps
   *  its name. Returns the refusal, if the write refused. */
  rename(name: string | undefined): Promise<string | undefined>
  /** The space is closing: waits up to `graceMs` for a send in flight, then closes the session. */
  close(graceMs?: number): Promise<Closed | undefined>
}

/** The app's steps that end a session's own refusals. */
export const APP_WORDS: ChatWords = {
  reopen: (channel) => `/quit ends this session, then c on #${channel} opens one on it`,
  answerOne: "open the sender in the tree and press c, or answer the newest with /reply",
}

const NAME_REMEDY = "change it with ctrl+p, Change your name, to be reached by name"
const OWN_ROWS = 200
const QUIT_MS = 5000

/** What the app's session asks for. It reads nothing itself, because the observer reads every
 *  channel. A static or user session may post to the channel it opened on, as `cotal chat <channel>`
 *  may. */
export function appAdmission(mode: MeshTarget["mode"], label: string, postTo?: string): ChatAdmission {
  const post = postTo === undefined ? [] : [postTo]
  if (mode === "open") return { mode, label, channels: [] }
  if (mode === "auth") return { mode, label, subscribe: [], allowPublish: post }
  if (mode === "user") return { mode, label, channels: [], read: [], post, ttlSec: USER_CHAT_TTL_SEC }
  throw new CommandFailure("refused", "UNSUPPORTED", `the app has no chat admission for a space recorded in "${String(mode)}" mode`)
}

function refusal(e: unknown): { message: string; remedy?: string } {
  const f = isConnectRefusal(e) ? e.failure() : isCommandFailure(e) ? e : undefined
  return { message: oneLine(f?.message ?? (e as Error).message), ...(f?.remedy ? { remedy: oneLine(f.remedy) } : {}) }
}

function closed(identity: SessionIdentity, report: Parameters<typeof closeSummary>[1]): Closed {
  const clean = report.connectionClosed === "confirmed" && (report.retirement === "retired" || report.retirement === "not-applicable")
  return { clean, summary: closeSummary(identity, report) }
}

const received = (m: SessionMessage, self: SessionIdentity): FeedEntry =>
  safe({
    id: m.id,
    ts: m.ts,
    from: { id: m.from.id, name: m.from.name },
    ...(m.kind === "anycast" ? { delivery: "anycast" as const, toService: m.service } : { delivery: "unicast" as const, toIds: [self.principal], toNames: [self.label] }),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    text: m.text,
  })

/** The owner of the human's one chat session in a space. The space's session creates it and closes
 *  it; nothing else holds the chat session. */
export function openTalk(deps: { target: MeshTarget; control: ControlClient; afterPaint: () => Promise<void> }): Talk {
  const { target, control, afterPaint } = deps
  const [phase, setPhase] = createSignal<TalkPhase>({ phase: "watching" })
  const [name, setName] = createSignal<NameState>({ state: "resolving" })
  const [own, setOwn] = createSignal<OwnTraffic>({ received: [], sent: [] })
  let session: AdmittedChatSession | undefined
  let unsubscribe: (() => void) | undefined
  let messages: SessionMessage[] = []
  let sending: Promise<unknown> | undefined
  let ending = false
  let shut = false

  const resolveName = async (): Promise<ChatName | undefined> => {
    try {
      const found = await resolveChatName(target)
      setName({ state: "ok", name: found })
      return found
    } catch (e) {
      setName({ state: "refused", ...refusal(e) })
      return undefined
    }
  }
  void resolveName()

  const ended = (s: AdmittedChatSession, reason: string | undefined) => {
    if (session !== s) return
    unsubscribe?.()
    session = undefined
    const id = s.identity()
    const expired = id.expiresAt !== undefined && Date.now() >= id.expiresAt
    const why = ending ? "you ended it" : reason ? oneLine(reason) : expired ? (id.mode === "static" ? "static sessions last 15 minutes" : "user sessions last 8 hours") : "the session ended"
    setPhase({ phase: "ended", name: id.label, at: Date.now(), why })
  }

  // The open session's name, else the name the next one would take.
  const current = () => {
    const p = phase()
    if (p.phase === "open") return p.identity.label
    const n = name()
    return n.state === "ok" ? n.name.name : undefined
  }

  return {
    phase,
    name,
    own,
    open: async (postTo) => {
      const p = phase().phase
      if (shut || p === "opening" || p === "open") return
      setPhase({ phase: "opening", name: current() ?? "" })
      const found = await resolveName()
      if (shut) return
      const n = name()
      if (!found) return void setPhase({ phase: "refused", message: `no name to join with: ${n.state === "refused" ? n.message : "unresolved"}`, ...(n.state === "refused" && n.remedy ? { remedy: n.remedy } : {}) })
      setPhase({ phase: "opening", name: found.name })
      let s: AdmittedChatSession
      try {
        s = await openChatSession(target, appAdmission(target.mode, found.name, postTo), { words: APP_WORDS, control })
      } catch (e) {
        const r = refusal(e)
        if (!shut) setPhase({ phase: "refused", message: `cannot join as ${found.name}: ${r.message}`, ...(r.remedy ? { remedy: r.remedy } : {}) })
        return
      }
      if (shut) return void (await s.close())
      session = s
      ending = false
      unsubscribe = s.subscribe((ev) => {
        if (ev.type === "message") {
          messages = [...messages, ev.message].slice(-OWN_ROWS)
          setOwn((o) => ({ ...o, received: [...o.received, received(ev.message, s.identity())].slice(-OWN_ROWS) }))
          void afterPaint().then(() => s.surfaced([ev.message.deliveryKey]))
        } else if (ev.type === "connection") {
          if (ev.state === "ended") ended(s, ev.reason)
          else setPhase((cur) => (cur.phase === "open" && session === s ? { ...cur, connection: ev.state } : cur))
        }
      })
      if (session !== s) return
      setPhase({ phase: "open", identity: s.identity(), connection: "connected" })
      const inUse = await nameInUse(s)
      if (inUse && session === s) setPhase((cur) => (cur.phase === "open" ? { ...cur, shared: nameInUseText(inUse, NAME_REMEDY) } : cur))
    },
    publish: async (to, text) => {
      const s = session
      if (!s) return { outcome: "refused", code: "USAGE_INVALID", message: "no chat session is open" }
      const p = publishTo(s, to, text)
      sending = p
      const r = await p.finally(() => (sending = undefined))
      if (r.outcome === "stored" && to.kind !== "channel") {
        const id = s.identity()
        const row: FeedEntry = {
          id: r.messageId,
          ts: Date.now(),
          from: { id: id.principal, name: id.label },
          ...(to.kind === "role" ? { delivery: "anycast" as const, toService: to.role } : { delivery: "unicast" as const, toIds: r.recipient ? [r.recipient.id] : [], toNames: r.recipient ? [r.recipient.name] : [] }),
          ...(to.kind === "peer" && to.replyTo ? { replyTo: to.replyTo } : {}),
          text,
        }
        setOwn((o) => ({ ...o, sent: [...o.sent, safe(row)].slice(-OWN_ROWS) }))
      }
      return r
    },
    slash: async (command) => {
      const s = session
      if (!s) return { tone: "failed", lines: ["no chat session is open"] }
      if (command.name === "reconnect") return slashOutcome(command, await s.reconnect(), (v) => [v.message])
      if (command.name === "status") return slashOutcome(command, await s.setStatus(command.status, command.activity), () => [])
      return slashOutcome(command, await s.connection(), describeConnection)
    },
    latest: () => latestDirected(messages),
    disclose: async (r) => (session ? discloseChoice(session, r) : undefined),
    mentionsYou: (e) => {
      const n = current()
      return n !== undefined && mentionsName(e.mentions, n)
    },
    end: async () => {
      const s = session
      if (!s) return undefined
      ending = true
      return closed(s.identity(), await s.close())
    },
    rename: async (value) => {
      try {
        writePreference({}, "name", value, readPreferences().revision)
      } catch (e) {
        return refusal(e).message
      }
      await resolveName()
      return undefined
    },
    close: async (graceMs = QUIT_MS) => {
      shut = true
      if (sending) await Promise.race([sending, new Promise((r) => setTimeout(r, graceMs))])
      unsubscribe?.()
      const s = session
      session = undefined
      if (!s) return undefined
      const report = await Promise.race([s.close(), new Promise<undefined>((r) => setTimeout(r, graceMs))])
      return report ? closed(s.identity(), report) : { clean: false, summary: `the session did not finish closing within ${graceMs / 1000} seconds; messages already sent remain under the space's retention policy` }
    },
  }
}
