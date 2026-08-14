// MeshView — the shared, render-agnostic model behind every "protocol view" surface
// (the terminal console, the plain stream, the web dashboard). It consumes ONE read-only
// observer endpoint and turns the raw wire into a normalized model: a status-sorted roster,
// a classified + burst-coalesced + windowed feed, channel counts, a msgs/s rate, and the
// derived operator signals (status counts, who's waiting, a per-peer DM roll-up). No ANSI,
// no React, no HTML, no color — a surface only lays this out, it never re-derives it.
// See docs/protocol-view.md.

import { EventEmitter } from "node:events";
import type { CotalEndpoint, CotalMessage, EndpointRef, Presence, PresenceStatus } from "@cotal-ai/core";
import { deliveryOf, chatWildcard, partsToText } from "@cotal-ai/core";

// ---- the model the surfaces render -----------------------------------------

export type FeedDelivery = "multicast" | "unicast" | "anycast";

/** One feed row. A same-sender/same-text unicast burst coalesces into a single entry with a
 *  deterministic id (the first message's) and ts (the earliest), so a history prefill and the
 *  live tap dedupe-by-id and order correctly. `text` is plain — the surface colors it. */
export interface FeedEntry {
  id: string;
  ts: number;
  from: EndpointRef;
  delivery: FeedDelivery;
  channel?: string; // multicast
  toService?: string; // anycast
  toNames?: string[]; // unicast targets, resolved off the roster
  count?: number; // burst multiplicity for coalesced unicast
  text: string;
}

export interface StatusCounts {
  working: number;
  waiting: number;
  idle: number;
  offline: number;
}

/** One message inside a DM thread (un-coalesced). */
export interface DmMessage {
  ts: number;
  from: string; // display name
  to: string; // display name
  text: string;
}

/** A conversation between a peer and one counterparty. */
export interface DmThread {
  with: string;
  role?: string;
  status: PresenceStatus;
  lastTs: number;
  messages: DmMessage[];
}

/** A peer's whole DM footprint — every counterparty it has talked to. */
export interface DmPeer {
  name: string;
  role?: string;
  status: PresenceStatus;
  lastTs: number;
  conversations: DmThread[];
}

/** Derived operator signals — golden-signal counts, who needs attention, the DM roll-up. */
export interface MeshSignals {
  counts: StatusCounts;
  /** Agents blocked / needing input, name-ordered. NOT age-ordered: presence carries no
   *  status-transition time, so how long a peer has been blocked is not knowable from the wire. */
  waiting: Presence[];
  /** Oldest heartbeat among LIVE agents — a liveness signal ("is anyone going quiet?"), NOT a
   *  blocked-duration. {@link Presence.ts} is republished every heartbeat, so it can never say how
   *  long an agent has been waiting. Undefined when no agent is live. */
  stalestLiveTs?: number;
  dms: DmPeer[]; // per-peer DM roll-up (only populated when DMs are visible)
}

export interface MeshSnapshot {
  agents: Presence[]; // card.kind === "agent", status-sorted then by name
  endpoints: Presence[]; // everything else
  channels: { channel: string; messages: number }[];
  feed: FeedEntry[]; // classified + coalesced + windowed
  rates: { msgsPerSec: number };
  status: { connected: boolean; space: string; dmVisible: boolean; error?: string };
  signals: MeshSignals;
  nameOf: (id: string) => string; // unicast target id → display name
}

export interface MeshViewOptions {
  /** Feed cap, in entries. Default 300. */
  window?: number;
  /** The read-only tap subject. `chatWildcard(space)` narrows to multicast (auth — DMs/anycast
   *  stay confidential); `spaceWildcard(space)` or undefined taps the whole space (god-view). */
  tapSubject?: string;
}

// ---- internals -------------------------------------------------------------

const STATUS_ORDER: Record<string, number> = { working: 0, waiting: 1, idle: 2, offline: 3 };
const BURST_MS = 400; // unicast burst-coalescing window
const TICK_MS = 75; // batch every source into one "change"
const CHANNELS_MS = 2000; // listChannels() refresh
const DEFAULT_WINDOW = 300;
const HISTORY_LIMIT = 50; // per-channel prefill depth
const DM_LOG_CAP = 1000; // raw DMs retained for the roll-up

function bodyText(msg: CotalMessage): string {
  return partsToText(msg.parts);
}

function sortRoster(r: Presence[]): Presence[] {
  // getRoster()/the "roster" event sort by name only — re-apply the status order here.
  return [...r].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      a.card.name.localeCompare(b.card.name),
  );
}

interface Burst {
  from: EndpointRef;
  body: string;
  id: string;
  ts: number;
  ids: string[];
  timer: ReturnType<typeof setTimeout>;
}

interface RawDm {
  ts: number;
  from: EndpointRef;
  toId: string;
  text: string;
}

/**
 * Events:
 * - `"entry"`  `(e: FeedEntry)` — one live feed row, as it lands (for the stream renderer).
 * - `"presence"` `(ev: PresenceEvent)` — forwarded presence change (join/update/offline).
 * - `"change"` `(s: MeshSnapshot)` — a batched snapshot every ~75ms (for dashboards).
 */
export class MeshView extends EventEmitter {
  private roster: Presence[] = [];
  private byId = new Map<string, string>();
  private channelCounts = new Map<string, number>();
  private feed: FeedEntry[] = [];
  private seen = new Set<string>(); // feed ids, for prefill ∪ live dedupe-by-id
  private pending = new Map<string, Burst>();
  private dmLog: RawDm[] = []; // raw unicast for the DM roll-up
  private recentTs: number[] = []; // tap arrivals in the last 1s → msgs/s
  private msgsPerSec = 0;
  private connected = false;
  private error?: string;
  private dirty = true;

  private readonly window: number;
  private readonly tapSubject?: string;
  private readonly chatOnly: boolean;
  private timers: ReturnType<typeof setInterval>[] = [];

  private readonly onRoster = (r: Presence[]) => this.setRoster(r);
  private readonly onPresence = (ev: unknown) => this.emit("presence", ev);
  private readonly onError = (e: Error) => {
    this.error = e.message;
    this.dirty = true;
  };

  constructor(
    private readonly ep: CotalEndpoint,
    opts: MeshViewOptions = {},
  ) {
    super();
    this.window = opts.window ?? DEFAULT_WINDOW;
    this.tapSubject = opts.tapSubject;
    // DMs are hidden only when the tap is narrowed to the chat subtree.
    this.chatOnly = opts.tapSubject === chatWildcard(ep.space);
  }

  async start(): Promise<void> {
    // The error listener MUST be attached before start() — async faults surface as events.
    this.ep.on("error", this.onError);
    this.ep.on("roster", this.onRoster);
    this.ep.on("presence", this.onPresence);
    await this.ep.start();
    this.connected = true;
    this.setRoster(this.ep.getRoster());
    this.ep.tap(
      (subject, msg) => {
        if (msg) this.ingest(subject, msg);
      },
      this.tapSubject ? { subject: this.tapSubject } : undefined,
    );
    void this.prefill();
    void this.refreshChannels();
    this.timers.push(setInterval(() => this.flush(), TICK_MS));
    this.timers.push(setInterval(() => void this.refreshChannels(), CHANNELS_MS));
    this.timers.push(setInterval(() => (this.dirty = true), 1000)); // refresh ages + decay rate
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const b of this.pending.values()) clearTimeout(b.timer); // bursts hold live timers
    this.pending.clear();
    this.ep.off("error", this.onError);
    this.ep.off("roster", this.onRoster);
    this.ep.off("presence", this.onPresence);
    await this.ep.stop();
  }

  snapshot(): MeshSnapshot {
    const channels = [...this.channelCounts]
      .map(([channel, messages]) => ({ channel, messages }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
    return {
      agents: this.roster.filter((p) => p.card.kind === "agent"),
      endpoints: this.roster.filter((p) => p.card.kind !== "agent"),
      channels,
      feed: this.feed.slice(),
      rates: { msgsPerSec: this.msgsPerSec },
      status: {
        connected: this.connected,
        space: this.ep.space,
        dmVisible: !this.chatOnly,
        error: this.error,
      },
      signals: this.signals(),
      nameOf: this.nameOf,
    };
  }

  // Stable identity across snapshots; reads the live byId map.
  nameOf = (id: string): string => this.byId.get(id) ?? id.slice(0, 8);

  // ---- sources -------------------------------------------------------------

  private setRoster(r: Presence[]): void {
    this.roster = sortRoster(r);
    for (const p of r) this.byId.set(p.card.id, p.card.name);
    this.dirty = true;
  }

  /** Live read-only tap. Drops control/presence/trace frames (deliveryOf → null). */
  private ingest(subject: string, msg: CotalMessage): void {
    const kind = deliveryOf(subject);
    if (!kind) return;
    this.recentTs.push(Date.now());
    if (msg.from?.id && msg.from.name) this.byId.set(msg.from.id, msg.from.name); // sharpen id→name
    if (kind === "unicast") return this.coalesce(msg);
    this.push({
      id: msg.id,
      ts: msg.ts,
      from: msg.from,
      delivery: kind === "anycast" ? "anycast" : "multicast", // "chat" → multicast
      channel: kind === "anycast" ? undefined : msg.channel,
      toService: kind === "anycast" ? msg.toService : undefined,
      text: bodyText(msg),
    });
  }

  /** Group a same-sender/same-text unicast burst into one feed entry over BURST_MS, and retain
   *  each raw message for the DM roll-up. */
  private coalesce(msg: CotalMessage): void {
    const body = bodyText(msg);
    if (msg.to) this.recordDm({ ts: msg.ts, from: msg.from, toId: msg.to, text: body });
    const key = msg.from.id + " " + body;
    let b = this.pending.get(key);
    if (!b) {
      b = {
        from: msg.from,
        body,
        id: msg.id,
        ts: msg.ts,
        ids: [],
        timer: setTimeout(() => this.flushBurst(key), BURST_MS),
      };
      this.pending.set(key, b);
    }
    b.ts = Math.min(b.ts, msg.ts); // earliest in the burst → deterministic order
    if (msg.to) b.ids.push(msg.to);
  }

  private flushBurst(key: string): void {
    const b = this.pending.get(key);
    if (!b) return;
    this.pending.delete(key);
    this.push({
      id: b.id,
      ts: b.ts,
      from: b.from,
      delivery: "unicast",
      toNames: b.ids.map((id) => this.nameOf(id)),
      count: b.ids.length,
      text: b.body,
    });
  }

  /** Append to the feed, dedupe by id, keep it windowed, and notify stream consumers. */
  private push(e: FeedEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.feed.push(e);
    this.trim();
    // Surface a brand-new channel as a tab now, not at the next poll.
    if (e.delivery === "multicast" && e.channel && !this.channelCounts.has(e.channel))
      this.channelCounts.set(e.channel, 1);
    this.dirty = true;
    this.emit("entry", e);
  }

  private trim(): void {
    if (this.feed.length <= this.window) return;
    for (const d of this.feed.splice(0, this.feed.length - this.window)) this.seen.delete(d.id);
  }

  private recordDm(d: RawDm): void {
    this.dmLog.push(d);
    if (this.dmLog.length > DM_LOG_CAP) this.dmLog.splice(0, this.dmLog.length - DM_LOG_CAP);
  }

  /** One-shot backlog: prefill each channel's history (multicast), plus the DM backlog when DMs
   *  are visible (god-view — `dmHistory` needs an admin cred), deduped by id, oldest-first. */
  private async prefill(): Promise<void> {
    let chans: { channel: string; messages: number }[];
    try {
      chans = await this.ep.listChannels();
    } catch {
      return;
    }
    const batches = await Promise.all(
      chans.map((c) =>
        this.ep.channelHistory(c.channel, { limit: HISTORY_LIMIT }).catch(() => [] as CotalMessage[]),
      ),
    );
    const history: FeedEntry[] = [];
    for (const msgs of batches)
      for (const msg of msgs) {
        if (!msg.channel || this.seen.has(msg.id)) continue;
        this.seen.add(msg.id);
        history.push({
          id: msg.id,
          ts: msg.ts,
          from: msg.from,
          delivery: "multicast",
          channel: msg.channel,
          text: bodyText(msg),
        });
      }
    if (history.length) {
      this.feed = [...history, ...this.feed].sort((a, b) => a.ts - b.ts);
      this.trim();
      this.dirty = true;
    }
    if (!this.chatOnly) await this.prefillDms();
  }

  /** Best-effort DM backlog for the roll-up — only meaningful for a god-view cred; a non-admin
   *  observer's `dmHistory` throws (ACL), which just leaves the DM lens live-only. */
  private async prefillDms(): Promise<void> {
    let msgs: CotalMessage[];
    try {
      msgs = await this.ep.dmHistory({ limit: DM_LOG_CAP });
    } catch {
      return;
    }
    // Merge backlog into the live dmLog, deduped by sender+recipient+ts (a live tap may already
    // have collected backlog-adjacent messages), then keep it ordered and capped.
    const key = (d: RawDm) => d.from.id + ">" + d.toId + "@" + d.ts;
    const have = new Set(this.dmLog.map(key));
    for (const m of msgs) {
      if (!m.to) continue;
      if (m.from?.id && m.from.name) this.byId.set(m.from.id, m.from.name);
      const d: RawDm = { ts: m.ts, from: m.from, toId: m.to, text: bodyText(m) };
      if (have.has(key(d))) continue;
      have.add(key(d));
      this.dmLog.push(d);
    }
    this.dmLog.sort((a, b) => a.ts - b.ts);
    if (this.dmLog.length > DM_LOG_CAP) this.dmLog.splice(0, this.dmLog.length - DM_LOG_CAP);
    this.dirty = true;
  }

  private async refreshChannels(): Promise<void> {
    let chans: { channel: string; messages: number }[];
    try {
      chans = await this.ep.listChannels();
    } catch {
      return;
    }
    for (const { channel, messages } of chans) this.channelCounts.set(channel, messages);
    this.dirty = true;
  }

  // ---- derived signals -----------------------------------------------------

  private signals(): MeshSignals {
    const agents = this.roster.filter((p) => p.card.kind === "agent");
    const counts: StatusCounts = { working: 0, waiting: 0, idle: 0, offline: 0 };
    for (const p of agents) if (p.status in counts) counts[p.status as keyof StatusCounts]++;
    // Name-ordered, deliberately not by `ts`: that is the last heartbeat, so sorting by it and
    // presenting the result as a priority queue would imply an age we cannot compute.
    const waiting = agents
      .filter((p) => p.status === "waiting")
      .sort((a, b) => a.card.name.localeCompare(b.card.name) || a.card.id.localeCompare(b.card.id));
    const live = agents.filter((p) => p.status !== "offline");
    return {
      counts,
      waiting,
      stalestLiveTs: live.length ? Math.min(...live.map((p) => p.ts)) : undefined,
      dms: this.rollupDms(),
    };
  }

  /** Group raw DMs into per-peer rows; each peer lists its counterparties (conversations).
   *  Only pairs that actually talked — never the n² cross-product. */
  private rollupDms(): DmPeer[] {
    const statusOf = (name: string): PresenceStatus =>
      this.roster.find((p) => p.card.name === name)?.status ?? "offline";
    const roleOf = (name: string): string | undefined =>
      this.roster.find((p) => p.card.name === name)?.card.role;

    const conv = new Map<string, { parts: [string, string]; msgs: DmMessage[]; last: number }>();
    for (const d of this.dmLog) {
      const a = d.from.name;
      const b = this.nameOf(d.toId);
      if (!a || !b || a === b) continue;
      const parts = [a, b].sort() as [string, string];
      const k = parts.join("\u0000");
      let c = conv.get(k);
      if (!c) conv.set(k, (c = { parts, msgs: [], last: 0 }));
      c.msgs.push({ ts: d.ts, from: a, to: b, text: d.text });
      c.last = Math.max(c.last, d.ts);
    }

    const peers = new Map<string, DmPeer>();
    for (const c of conv.values()) {
      c.msgs.sort((x, y) => x.ts - y.ts);
      for (const name of c.parts) {
        const other = c.parts[0] === name ? c.parts[1] : c.parts[0];
        let pe = peers.get(name);
        if (!pe)
          peers.set(name, (pe = { name, role: roleOf(name), status: statusOf(name), lastTs: 0, conversations: [] }));
        pe.conversations.push({ with: other, role: roleOf(other), status: statusOf(other), lastTs: c.last, messages: c.msgs });
        pe.lastTs = Math.max(pe.lastTs, c.last);
      }
    }
    for (const pe of peers.values()) pe.conversations.sort((a, b) => b.lastTs - a.lastTs);
    return [...peers.values()].sort((a, b) => b.lastTs - a.lastTs);
  }

  /** The single batch point: recompute the rolling rate, then emit one snapshot if dirty. */
  private flush(): void {
    const cutoff = Date.now() - 1000;
    while (this.recentTs.length && this.recentTs[0] < cutoff) this.recentTs.shift();
    if (this.recentTs.length !== this.msgsPerSec) {
      this.msgsPerSec = this.recentTs.length;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.emit("change", this.snapshot());
  }
}
