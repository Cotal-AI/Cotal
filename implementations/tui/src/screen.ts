import type { Entry } from "./catalog.js"
import type { Conn, FeedEntry, Mesh, Presence } from "./live.js"

/** One selectable tree row. The key is stable across snapshots, so the cursor stays on the same row
 *  while the roster re-sorts under it. */
export type Row =
  | { key: string; kind: "entry"; entry: Entry; open: boolean }
  | { key: string; kind: "channel"; channel?: string; unread: number }
  | { key: string; kind: "peer"; presence: Presence }

export type Item = { kind: "header"; title: string; right?: string } | Row

/** What the middle column shows: a channel feed (all traffic without a channel), one agent or
 *  endpoint, or a catalog row that cannot be opened as a space. */
export type Open = { kind: "channel"; channel?: string } | { kind: "peer"; id: string } | { kind: "entry"; key: string }

export const meshOf = (c: Conn): Mesh | undefined => (c.phase === "live" || c.phase === "reconnecting" ? c.mesh : undefined)

export const entryKey = (e: Entry) => (e.kind === "unusable" ? `unusable:${e.source}` : `${e.kind}:${e.space}`)
export const peerKey = (id: string) => `peer:${id}`

export function treeItems(entries: Entry[], conn: Conn, seen: Record<string, number>): Item[] {
  const items: Item[] = [{ kind: "header", title: "SPACES", right: String(entries.filter((e) => e.kind !== "unusable").length) }]
  for (const e of entries) items.push({ key: entryKey(e), kind: "entry", entry: e, open: e.kind === "space" && e.space === conn.space && conn.phase !== "closed" && conn.phase !== "failed" })
  const mesh = meshOf(conn)
  if (!mesh) return items
  items.push({ kind: "header", title: "CHANNELS", right: String(mesh.channels.length) }, { key: "channel:*", kind: "channel", unread: 0 })
  for (const c of mesh.channels) items.push({ key: `channel:${c.channel}`, kind: "channel", channel: c.channel, unread: Math.max(0, c.arrivals - (seen[c.channel] ?? 0)) })
  const live = mesh.agents.filter((a) => a.status !== "offline").length
  items.push({ kind: "header", title: "AGENTS", right: `${live}/${mesh.agents.length}` })
  for (const p of mesh.agents) items.push({ key: peerKey(p.card.id), kind: "peer", presence: p })
  if (mesh.endpoints.length) items.push({ kind: "header", title: "ENDPOINTS", right: String(mesh.endpoints.length) })
  for (const p of mesh.endpoints) items.push({ key: peerKey(p.card.id), kind: "peer", presence: p })
  return items
}

export function feedFor(mesh: Mesh, open: Open): FeedEntry[] {
  if (open.kind === "channel") return open.channel === undefined ? mesh.feed : mesh.feed.filter((e) => e.channel === open.channel)
  if (open.kind === "peer") return mesh.feed.filter((e) => e.from.id === open.id || e.toIds?.includes(open.id))
  return []
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
 *  "not reported"; uptime dates the publishing process and exists only while it is live. */
export function overview(p: Presence, now: number): { label: string; value: string }[] {
  return [
    { label: "status", value: `${STATUS[p.status].mark} ${STATUS[p.status].word}` },
    ...(p.card.role ? [{ label: "role", value: p.card.role }] : []),
    { label: "model", value: metaText(p, "model") ?? "not reported" },
    { label: "harness", value: metaText(p, "connector") ?? "not reported" },
    { label: "uptime", value: p.status !== "offline" && p.runtime ? duration(now - p.runtime.startedAt) : "not reported" },
  ]
}

/** Who a feed row is from and where it went, for the line above its text. */
export function route(e: FeedEntry, withChannel: boolean): string {
  if (e.delivery === "unicast") return `→ ${(e.toNames ?? []).join(", ")}${e.count && e.count > 1 ? ` ×${e.count}` : ""}`
  if (e.delivery === "anycast") return `→ @${e.toService ?? "?"}`
  return withChannel && e.channel ? `#${e.channel}` : ""
}

export const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8)
