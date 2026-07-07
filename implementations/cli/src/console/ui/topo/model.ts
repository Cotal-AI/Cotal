// The topology model behind the `t` lens — a pure fold of the mesh snapshot
// (feed + roster) into a who-talks-to-whom graph. Shared by all three variants
// (sequence / matrix / map); render-agnostic and stateless — `now` is injectable,
// so the fold is deterministic and the recency kernel needs no stored EWMA state.

import type { MembershipSnapshot, Presence, PresenceStatus } from "@cotal-ai/core";
import { subjectMatches } from "@cotal-ai/core";
import type { FeedDelivery, FeedEntry } from "../../mesh.js";

export type TopoNodeKind = "agent" | "channel" | "service";

export interface TopoNode {
  /** Kind-prefixed name: "a:alice" | "c:general" | "s:planner". */
  key: string;
  kind: TopoNodeKind;
  /** Display name — renderers add the #/@ prefix. */
  name: string;
  status?: PresenceStatus; // agents only
  role?: string;
  /** Last involvement inside the window (0 = present but silent). */
  lastTs: number;
  /** Present in the broker-authoritative membership feed (agents only). */
  member?: boolean;
  /** Subscribes `>` or `*` — a wide "reads all" reader; badged, not spoked per hub. */
  wide?: boolean;
}

/** A broker-authoritative membership link — an agent subscribes a channel. Kept SEPARATE from
 *  traffic {@link TopoEdge}s (which carry rate/count): a membership link has no traffic, so folding
 *  it into edges would prune it (heatLevel 0) or create phantom empty matrix columns. */
export interface TopoMembership {
  agent: string; // TopoNode.key ("a:...")
  channel: string; // TopoNode.key ("c:...")
  /** Which broker arm proves it: `live` (a current CONNZ subscription) vs `durable` (registry only,
   *  i.e. a member whose connection is currently down). */
  state: "live" | "durable";
}

export interface TopoEdge {
  key: string; // src + "→" + dst
  src: string; // TopoNode.key
  dst: string;
  mode: FeedDelivery;
  count: number; // messages inside the window
  lastTs: number;
  /** Recency intensity: Σ exp(-(now-ts)/τ), τ = 20s — a stateless EWMA. */
  rate: number;
}

export interface TopoGraph {
  /** Agents (roster order) first, then channels, then services (each alphabetical). */
  nodes: TopoNode[];
  /** Ascending by rate — renderers overdraw hot edges last. */
  edges: TopoEdge[];
  /** Broker-authoritative membership links (the resting subscription skeleton). */
  memberships: TopoMembership[];
  byKey: Map<string, TopoNode>;
  windowMs: number;
  now: number;
  /** Membership feed freshness — `available` false ⇒ the lens is traffic-only. */
  membership: { asOf?: number; available: boolean };
}

const RATE_TAU_MS = 20_000;
export const DEFAULT_TOPO_WINDOW_MS = 120_000;
export const MEMBERSHIP_STALE_MS = 45_000; // mirror the web dashboard's FEED_STALE_MS

const isWild = (pat: string): boolean => pat.includes("*") || pat.includes(">");

/** The target node(s) a feed entry talks to — the single place delivery → node mapping lives. */
export function targetsOf(e: FeedEntry): { key: string; kind: TopoNodeKind; name: string }[] {
  if (e.delivery === "multicast") {
    const name = e.channel ?? "?";
    return [{ key: "c:" + name, kind: "channel", name }];
  }
  if (e.delivery === "anycast") {
    const name = e.toService ?? "?";
    return [{ key: "s:" + name, kind: "service", name }];
  }
  if (e.delivery === "unicast")
    return (e.toNames ?? []).map((name) => ({ key: "a:" + name, kind: "agent" as const, name }));
  throw new Error(`foldTopo: unknown delivery "${(e as { delivery: string }).delivery}"`);
}

export function foldTopo(
  feed: FeedEntry[],
  agents: Presence[],
  opts?: {
    windowMs?: number;
    now?: number;
    /** Broker-authoritative membership feed (from MeshView). Absent ⇒ traffic-only. */
    membership?: MembershipSnapshot;
    /** Channel registry names, for expanding bounded wildcard subscriptions. */
    knownChannels?: string[];
    /** id → display name (defaults to the roster, then an 8-char id prefix). */
    nameOf?: (id: string) => string;
  },
): TopoGraph {
  const now = opts?.now ?? Date.now();
  const windowMs = opts?.windowMs ?? DEFAULT_TOPO_WINDOW_MS;

  const byKey = new Map<string, TopoNode>();
  // Roster agents stay visible even when silent — silence is itself a signal.
  for (const p of agents) {
    const key = "a:" + p.card.name;
    if (!byKey.has(key))
      byKey.set(key, {
        key,
        kind: "agent",
        name: p.card.name,
        status: p.status,
        role: p.card.role,
        lastTs: 0,
      });
  }
  // A node first seen in traffic (sender gone from the roster, channel, service).
  const touch = (key: string, kind: TopoNodeKind, name: string, ts: number): TopoNode => {
    let n = byKey.get(key);
    if (!n) {
      n = { key, kind, name, lastTs: 0, ...(kind === "agent" ? { status: "offline" as const } : {}) };
      byKey.set(key, n);
    }
    if (ts > n.lastTs) n.lastTs = ts;
    return n;
  };

  const edges = new Map<string, TopoEdge>();
  for (const e of feed) {
    if (e.ts < now - windowMs) continue;
    const src = touch("a:" + e.from.name, "agent", e.from.name, e.ts);
    if (e.from.role && !src.role) src.role = e.from.role;
    const mult = e.count ?? 1; // coalesced unicast burst multiplicity
    const w = Math.exp(-(now - e.ts) / RATE_TAU_MS) * mult;
    for (const t of targetsOf(e)) {
      const dst = touch(t.key, t.kind, t.name, e.ts);
      const key = src.key + "→" + dst.key;
      let edge = edges.get(key);
      if (!edge) {
        edge = { key, src: src.key, dst: dst.key, mode: e.delivery, count: 0, lastTs: 0, rate: 0 };
        edges.set(key, edge);
      }
      edge.count += mult;
      edge.lastTs = Math.max(edge.lastTs, e.ts);
      edge.rate += w;
    }
  }

  // Overlay broker-authoritative membership: silent subscribers become nodes, subscriptions become
  // resting spokes. Resolve id→name against the roster so a member that ALSO has traffic merges onto
  // the same node (no double-count), keeping the fold otherwise unchanged when membership is absent.
  const memberships: TopoMembership[] = [];
  const rosterById = new Map(agents.map((p) => [p.card.id, p.card.name]));
  const nameFor = opts?.nameOf ?? ((id: string) => rosterById.get(id) ?? id.slice(0, 8));
  const membership = opts?.membership;
  if (membership) {
    const known = new Set<string>([
      ...[...byKey.values()].filter((n) => n.kind === "channel").map((n) => n.name),
      ...(opts?.knownChannels ?? []),
    ]);
    for (const m of membership.members) {
      const node = touch("a:" + nameFor(m.id), "agent", nameFor(m.id), 0);
      node.member = true;
      // Which channels this agent subscribes, and whether it's a wide reader.
      const chans = new Map<string, "live" | "durable">();
      let wide = false;
      for (const pat of m.live ?? []) {
        if (pat === ">" || pat === "*") wide = true;
        else if (isWild(pat)) for (const ch of known) { if (subjectMatches(pat, ch)) chans.set(ch, "live"); }
        else chans.set(pat, "live");
      }
      for (const ch of m.durable ?? []) if (!chans.has(ch)) chans.set(ch, "durable");
      if (wide) node.wide = true;
      for (const [ch, state] of chans) {
        touch("c:" + ch, "channel", ch, 0); // materialize a hub even if silent
        memberships.push({ agent: node.key, channel: "c:" + ch, state });
      }
    }
  }

  // Agents keep roster order (traffic-only senders appended by name); hubs alphabetical.
  const rosterOrder = new Map(agents.map((p, i) => ["a:" + p.card.name, i]));
  const all = [...byKey.values()];
  const agentNodes = all
    .filter((n) => n.kind === "agent")
    .sort((a, b) => {
      const ai = rosterOrder.get(a.key) ?? Infinity;
      const bi = rosterOrder.get(b.key) ?? Infinity;
      return ai - bi || a.name.localeCompare(b.name);
    });
  const hub = (kind: TopoNodeKind) =>
    all.filter((n) => n.kind === kind).sort((a, b) => a.name.localeCompare(b.name));

  return {
    nodes: [...agentNodes, ...hub("channel"), ...hub("service")],
    edges: [...edges.values()].sort((a, b) => a.rate - b.rate),
    memberships,
    byKey,
    windowMs,
    now,
    membership: {
      asOf: membership?.asOf,
      // Available once we've read a feed with either a heartbeat (asOf) or at least one member.
      available: membership !== undefined && (membership.asOf !== undefined || membership.members.length > 0),
    },
  };
}

/** Membership feed freshness for the lens header pill — mirrors the web dashboard's pill. */
export function membershipFreshness(
  now: number,
  m: TopoGraph["membership"],
): { label: string; color?: string } {
  if (!m.available) return { label: "traffic-only" };
  const age = m.asOf ? now - m.asOf : Infinity;
  return age < MEMBERSHIP_STALE_MS ? { label: "live", color: "green" } : { label: "stale", color: "yellow" };
}

// Heat shading shared by the matrix and map: rate → 5 intensity steps.
export const HEAT = [" ", "░", "▒", "▓", "█"] as const;

export function heatLevel(rate: number): 0 | 1 | 2 | 3 | 4 {
  if (rate < 0.05) return 0;
  if (rate < 0.5) return 1;
  if (rate < 2) return 2;
  if (rate < 5) return 3;
  return 4;
}

/** Display label for a node — the renderers' single prefix rule. */
export function nodeLabel(n: TopoNode): string {
  return n.kind === "channel" ? "#" + n.name : n.kind === "service" ? "@" + n.name : n.name;
}

/** The feed entries that flow over one edge, oldest-first (for inspectors/detail). */
export function edgeEntries(feed: FeedEntry[], edge: TopoEdge, graph: TopoGraph): FeedEntry[] {
  return feed.filter(
    (e) =>
      e.ts >= graph.now - graph.windowMs &&
      "a:" + e.from.name === edge.src &&
      targetsOf(e).some((t) => t.key === edge.dst),
  );
}
