import type { Recipient } from "@cotal-ai/workspace/chat"
import type { Entry } from "./catalog.js"
import type { Conn, FeedEntry, Managed, Mesh, Presence } from "./live.js"
import type { OwnTraffic, You } from "./talk.js"

/** One selectable tree row. The key is stable across snapshots, so the cursor stays on the same row
 *  while the roster re-sorts under it. */
export type Row =
  | { key: string; kind: "entry"; entry: Entry; open: boolean }
  | { key: string; kind: "channel"; channel?: string; unread: number }
  | { key: string; kind: "peer"; presence: Presence }

export type Item = { kind: "header"; title: string; right?: string } | Row

/** What the middle column shows: a channel feed (all traffic without a channel), one agent or
 *  endpoint, the tasks sent to one role, or a catalog row that cannot be opened as a space. */
export type Open = { kind: "channel"; channel?: string } | { kind: "peer"; id: string } | { kind: "role"; role: string } | { kind: "entry"; key: string }

export const meshOf = (c: Conn): Mesh | undefined => (c.phase === "live" || c.phase === "reconnecting" ? c.mesh : undefined)

export const entryKey = (e: Entry) => (e.kind === "unusable" ? `unusable:${e.source}` : `${e.kind}:${e.space}`)
export const peerKey = (id: string) => `peer:${id}`
/** The tree row of an open conversation. A role conversation has none. */
export const openRowKey = (o: Open) => (o.kind === "channel" ? `channel:${o.channel ?? "*"}` : o.kind === "peer" ? peerKey(o.id) : o.kind === "entry" ? o.key : undefined)

/** The tree's rows. `self` is the principal of the human's open chat session, if one is open. */
export function treeItems(entries: Entry[], conn: Conn, seen: Record<string, number>, self?: string): Item[] {
  const items: Item[] = [{ kind: "header", title: "SPACES", right: String(entries.filter((e) => e.kind !== "unusable").length) }]
  for (const e of entries) items.push({ key: entryKey(e), kind: "entry", entry: e, open: e.kind === "space" && e.space === conn.space && conn.phase !== "closed" && conn.phase !== "failed" })
  const mesh = meshOf(conn)
  if (!mesh) return items
  items.push({ kind: "header", title: "CHANNELS", right: String(mesh.channels.length) }, { key: "channel:*", kind: "channel", unread: 0 })
  for (const c of mesh.channels) items.push({ key: `channel:${c.channel}`, kind: "channel", channel: c.channel, unread: Math.max(0, c.arrivals - (seen[c.channel] ?? 0)) })
  const live = mesh.agents.filter((a) => a.status !== "offline").length
  items.push({ kind: "header", title: "AGENTS", right: `${live}/${mesh.agents.length}` })
  for (const p of mesh.agents) items.push({ key: peerKey(p.card.id), kind: "peer", presence: p })
  // Each chat session has its own principal, so one that ended is never reached again, and the
  // human's own is the name at the bottom of the tree.
  const endpoints = mesh.endpoints.filter((p) => p.card.meta?.sessionKind !== "chat" || (p.status !== "offline" && p.card.id !== self))
  if (endpoints.length) items.push({ kind: "header", title: "ENDPOINTS", right: String(endpoints.length) })
  for (const p of endpoints) items.push({ key: peerKey(p.card.id), kind: "peer", presence: p })
  return items
}

const inConversation = (e: FeedEntry, open: Open) => {
  if (open.kind === "channel") return open.channel === undefined || e.channel === open.channel
  if (open.kind === "peer") return e.from.id === open.id || !!e.toIds?.includes(open.id)
  if (open.kind === "role") return e.delivery === "anycast" && e.toService === open.role
  return false
}

/** The open conversation's newest `limit` rows. The human's direct messages from earlier sessions join
 *  the observer's feed, and where the observer cannot see direct messages, as on an auth space, so does
 *  the session's own directed traffic, deduplicated by id and ordered by time. */
export function conversationFeed(mesh: Mesh, open: Open, own: OwnTraffic, limit: number): FeedEntry[] {
  const seen = mesh.feed.filter((e) => inConversation(e, open))
  const ids = new Set(seen.map((e) => e.id))
  const mine = [...own.earlier, ...(mesh.status.dmVisible ? [] : [...own.received, ...own.sent])].filter((e) => !ids.has(e.id) && inConversation(e, open))
  if (mesh.status.dmVisible && !mine.length) return seen.slice(-limit)
  return [...seen, ...mine].sort((a, b) => a.ts - b.ts).slice(-limit)
}

/** A key per conversation: `#general`, `#*` for all traffic, `@<principal>`, `role:<role>`, `entry:<key>`. */
export function conversationKey(open: Open): string {
  if (open.kind === "channel") return `#${open.channel ?? "*"}`
  if (open.kind === "peer") return `@${open.id}`
  if (open.kind === "role") return `role:${open.role}`
  return `entry:${open.key}`
}

/** One conversation in one space: drafts survive conversation and space switches. */
export type DraftKey = string & { readonly __draftKey: unique symbol }
export const draftKey = (space: string, open: Open) => `${space}\0${conversationKey(open)}` as DraftKey

/** Where writing in a conversation goes: its channel, the peer's exact principal or its role. All
 *  traffic and catalog rows have none. Derived on every read, so a draft never follows the human to
 *  another conversation. */
export function conversationRecipient(open: Open, mesh: Mesh): Recipient | undefined {
  if (open.kind === "channel") return open.channel === undefined ? undefined : { kind: "channel", channel: open.channel }
  if (open.kind === "peer") return { kind: "peer", principal: open.id, name: peerOf(mesh, open.id)?.card.name ?? open.id }
  if (open.kind === "role") return { kind: "role", role: open.role }
  return undefined
}

/** Whether a sender is the human: a session the app opened, in this run or in an earlier one it
 *  remembers, or one under their chat name in any letter case. */
export const isYou = (you: You, who: FeedEntry["from"]) => you.principals.has(who.id) || who.name.toLowerCase() === you.name

/** Whether a row is a direct message to a session the app opened. */
const toYou = (you: You, e: FeedEntry) => e.delivery === "unicast" && !!e.toIds?.some((id) => you.principals.has(id))

/** What the human did with a card in this app run: opened it, or dismissed it without replying. */
export type Mark = "seen" | "dismissed"

/** A message the inspector lists: a reply to one the human sent or one that mentions them, which
 *  needs their answer, or another direct message to them, which needs reading. `open` is the
 *  conversation it opens: its channel, its sender's conversation or its role's. */
export type Card = { kind: "reply" | "mention" | "dm"; entry: FeedEntry; open: Open }

/** The conversation a card opens. A channel post with no channel or a role task with no role has
 *  none, since it would open all traffic or an empty role. */
const cardOpen = (e: FeedEntry): Open | undefined => {
  if (e.delivery === "unicast") return { kind: "peer", id: e.from.id }
  if (e.delivery === "multicast") return e.channel === undefined ? undefined : { kind: "channel", channel: e.channel }
  return e.toService === undefined ? undefined : { kind: "role", role: e.toService }
}

/** The cards in `feed`, oldest first, the ids of the messages the human's own messages in it reply
 *  to, and the ids of those own messages. A reply card answers one of the human's messages in `feed`
 *  or in `sentBefore`, the ids an earlier call returned as `sent`. A message that both replies and
 *  mentions is one reply card, and a direct message that does either is no `dm` card. The human's
 *  own messages and a message with no conversation to open make none. */
export function cardsFor(feed: readonly FeedEntry[], you: You, mentionsYou: (e: FeedEntry) => boolean, sentBefore: ReadonlySet<string>): { cards: Card[]; answered: string[]; sent: string[] } {
  const own = feed.filter((e) => isYou(you, e.from))
  const sent = own.map((e) => e.id)
  const yours = new Set([...sentBefore, ...sent])
  const cards: Card[] = []
  for (const e of feed) {
    if (e.events || isYou(you, e.from)) continue
    const kind = e.replyTo !== undefined && yours.has(e.replyTo) ? "reply" : mentionsYou(e) ? "mention" : toYou(you, e) ? "dm" : undefined
    const open = kind ? cardOpen(e) : undefined
    if (kind && open) cards.push({ kind, entry: e, open })
  }
  return { cards, answered: own.flatMap((e) => (e.replyTo === undefined ? [] : [e.replyTo])), sent }
}

/** One sender's direct messages to the human that the human has not read, newest first. */
export type Unread = { open: Open; messages: FeedEntry[] }

/** The unread direct messages among `cards`, which are newest first, by sender, the sender with the
 *  newest first. */
export function unreadBySender(cards: readonly Card[], read: ReadonlySet<string>): Unread[] {
  const by = new Map<string, Unread>()
  for (const c of cards) {
    if (c.kind !== "dm" || read.has(c.entry.id)) continue
    const key = conversationKey(c.open)
    const u = by.get(key)
    if (u) u.messages.push(c.entry)
    else by.set(key, { open: c.open, messages: [c.entry] })
  }
  return [...by.values()]
}

export const peerOf = (mesh: Mesh, id: string) => [...mesh.agents, ...mesh.endpoints].find((p) => p.card.id === id)

export const STATUS = {
  working: { mark: "●", word: "working" },
  waiting: { mark: "◐", word: "waiting" },
  idle: { mark: "○", word: "idle" },
  offline: { mark: "⨯", word: "offline" },
} as const

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const metaText = (p: Presence, key: string) => {
  const v = p.card.meta?.[key]
  return typeof v === "string" && v ? v : undefined
}

/** The overview the inspector shows for the selected agent. A field the wire does not carry reads
 *  "not reported". Uptime dates the process: the manager's count for a seat it runs, carried forward
 *  from when it was read, otherwise the publishing process while it is live. */
export function overview(p: Presence, now: number, managed: Managed): { label: string; value: string }[] {
  const row = p.card.kind === "agent" && managed.phase === "rows" ? managed.byId.get(p.card.id) : undefined
  const uptime = row
    ? duration(row.uptimeMs + (row.status === "running" && managed.phase === "rows" ? now - managed.readAt : 0))
    : p.status !== "offline" && p.runtime
      ? duration(now - p.runtime.startedAt)
      : "not reported"
  return [
    { label: "status", value: `${STATUS[p.status].mark} ${STATUS[p.status].word}${p.status === "working" ? " · progress unknown" : ""}` },
    ...(p.card.role ? [{ label: "role", value: p.card.role }] : []),
    { label: "model", value: metaText(p, "model") ?? row?.model ?? "not reported" },
    { label: "harness", value: metaText(p, "connector") ?? row?.agent ?? "not reported" },
    ...(row ? [{ label: "runtime", value: row.mode }, { label: "process", value: row.status }] : []),
    { label: "uptime", value: uptime },
    ...(p.card.kind === "agent" && !row ? [{ label: "managed", value: managedNote(managed) }] : []),
  ]
}

const managedNote = (m: Managed) => {
  if (m.phase === "loading") return "asking the manager…"
  if (m.phase === "unavailable") return `cannot ask the manager: ${m.reason}`
  return m.partial ? `not by a manager that answered (${m.partial})` : "not by a manager on this space"
}

/** Who a feed row is from and where it went, for the line above its text. */
export function route(e: FeedEntry, withChannel: boolean): string {
  if (e.delivery === "unicast") return `→ ${(e.toNames ?? []).join(", ")}${e.count && e.count > 1 ? ` ×${e.count}` : ""}`
  if (e.delivery === "anycast") return `→ @${e.toService ?? "?"}`
  return withChannel && e.channel ? `#${e.channel}` : ""
}

export const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8)
