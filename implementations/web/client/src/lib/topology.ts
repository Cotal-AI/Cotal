// The mesh graph's model: which agents and channels are nodes, which links join them and which links
// are hot. Ported from the old `graph.js` (`updateRoster`, `onMessage`, `isHidden`,
// `recomputeHubEmpty`). Pure: no window, no document, no clock. A link is hot by the `now` the caller
// passes, so a test never sleeps. Membership rules live in membership.ts and are not restated here.
import type { ChannelInfo, CotalMessage, RosterEntry } from "../api/types.js";
import type { DashboardState } from "../state/types.js";
import { feedAuthoritative, memberChannels } from "./membership.js";
import { displayNameOf, nameIndex } from "./names.js";
import type { Status } from "./roster.js";

export interface TopoNode {
  id: string;
  kind: "agent" | "channel";
  label: string;
  vendor?: string;
  status?: Status;
  /** A reader of everything (`>` or `*`). It gets this badge instead of a link to every channel. */
  wide?: boolean;
}

export interface TopoLink {
  source: string;
  target: string;
  kind: "member" | "durable" | "traffic";
  hot: boolean;
}

export interface TopoModel {
  nodes: TopoNode[];
  links: TopoLink[];
}

/** A link stays hot this long after a message flows on its channel. */
export const HOT_MS = 2000;

/** A channel node's id. Agent ids are roster ids, so the prefix keeps a channel from sharing a key with one. */
export const channelNodeId = (channel: string): string => `#${channel}`;

/** The mesh as nodes and links, under the two hide toggles.
 *
 *  Agent nodes are keyed by roster id and labelled by roster name. A chat message may add its sender
 *  and its channel. A unicast or an anycast adds nothing, and a message payload's own name is never a
 *  label. A channel node comes from the channel list, a chat message or a membership subscription,
 *  never from a unicast or an anycast. An unreadable membership feed contributes no links, no wide
 *  badges and no channels; the roster, chat and the channel list still draw. `recent` is the caller's bounded window of messages; each entry's `ts` is what `now` is measured against. */
export function topologyModel(input: {
  roster: RosterEntry[];
  channels: ChannelInfo[];
  membership: DashboardState["membership"];
  recent: { mode: string; channel?: string; senderId?: string; msg: CotalMessage; ts: number }[];
  hideOffline: boolean;
  hideEmpty: boolean;
  now: number;
}): TopoModel {
  const { roster, channels, membership, recent, hideOffline, hideEmpty, now } = input;
  const names = nameIndex(roster);

  const agents = new Map<string, TopoNode>();
  for (const p of roster) {
    if (p.card.kind === "endpoint" || !p.card.id) continue;
    const connector = p.card.meta?.["connector"];
    agents.set(p.card.id, {
      id: p.card.id,
      kind: "agent",
      label: p.card.name,
      ...(typeof connector === "string" ? { vendor: connector } : {}),
      status: p.status,
    });
  }

  const hubs = new Set<string>(channels.map((c) => c.channel));
  const chats = recent
    .filter((r) => r.mode === "chat" && r.channel)
    .map((r) => ({ channel: r.channel!, sender: r.senderId ?? r.msg.from.id, ts: r.ts }));
  for (const c of chats) hubs.add(c.channel);

  // A subscriber the roster never announced has no presence behind it, so it reads as offline.
  // An unreadable feed draws no membership overlay: its last snapshot is no longer what is.
  const members = (membership.unreadable === undefined ? membership.snapshot?.members ?? [] : []).filter((m) => m.id);
  for (const m of members) {
    for (const ch of memberChannels(m.live ?? [], m.durable ?? [], []).channels.keys()) hubs.add(ch);
  }
  const wide = new Set<string>();
  const links = new Map<string, TopoLink>();
  const keyOf = (agent: string, channel: string) => `${agent}\u0000${channel}`;
  const known = [...hubs];
  for (const m of members) {
    if (!agents.has(m.id)) agents.set(m.id, { id: m.id, kind: "agent", label: displayNameOf(m.id, names), status: "offline" });
    const mc = memberChannels(m.live ?? [], m.durable ?? [], known);
    if (mc.wide) wide.add(m.id);
    for (const [ch, how] of mc.channels) {
      links.set(keyOf(m.id, ch), { source: m.id, target: channelNodeId(ch), kind: how === "live" ? "member" : "durable", hot: false });
    }
  }
  for (const c of chats) {
    if (!c.sender) continue;
    if (!agents.has(c.sender)) agents.set(c.sender, { id: c.sender, kind: "agent", label: displayNameOf(c.sender, names), status: "idle" });
    const key = keyOf(c.sender, c.channel);
    if (!links.has(key)) links.set(key, { source: c.sender, target: channelNodeId(c.channel), kind: "traffic", hot: false });
  }
  for (const [id, node] of agents) if (wide.has(id)) node.wide = true;

  // A post heats its sender's link and, as the broadcast fans out, every other link on that channel.
  // A post with no sender id heats nothing: nothing can be said to have sent it.
  for (const c of chats) {
    if (!c.sender || now - c.ts >= HOT_MS) continue;
    for (const l of links.values()) if (l.target === channelNodeId(c.channel)) l.hot = true;
  }

  // Visibility, as `isHidden` and `recomputeHubEmpty` decided it.
  const offline = (id: string) => agents.get(id)?.status === "offline";
  const memberHidden = (l: TopoLink) => hideOffline && (l.kind === "durable" || offline(l.source));
  const hasMember = new Set<string>();
  for (const l of links.values()) if (l.kind !== "traffic" && !memberHidden(l)) hasMember.add(l.target);
  const authoritative = feedAuthoritative(membership);
  const hubHidden = (channel: string) => hideEmpty && authoritative && !hasMember.has(channelNodeId(channel));

  const nodes: TopoNode[] = [...agents.values()].filter((n) => !(hideOffline && n.status === "offline"));
  for (const ch of hubs) if (!hubHidden(ch)) nodes.push({ id: channelNodeId(ch), kind: "channel", label: ch });
  const visible = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    links: [...links.values()].filter((l) => visible.has(l.source) && visible.has(l.target) && !(l.kind !== "traffic" && memberHidden(l))),
  };
}
