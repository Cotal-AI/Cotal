// Who is in a channel. The broker's membership feed answers when it is authoritative; otherwise the
// only honest answer is who has posted there, and each member says which of the two it is. Pure: no
// window, no document, no I/O. Wildcard rules live in membership.ts and are not restated here.
import type { CotalMessage } from "../api/types.js";
import type { DashboardState } from "../state/types.js";
import { feedAuthoritative, memberChannels } from "./membership.js";

export interface ChannelMember {
  id: string;
  source: "membership" | "traffic";
}

/** Who is in a channel: from the broker membership feed when it is authoritative, else from who has
 *  posted there. The pill tells the viewer which one it is.
 *
 *  An authoritative feed with nobody in the channel answers nobody. It is never topped up from
 *  traffic, because a list that mixes the two sources would claim a membership the broker did not
 *  state. The channel asked about counts as known, so a bounded wildcard reaches it. */
export function channelMembers(
  channel: string,
  membership: DashboardState["membership"],
  knownChannels: string[],
  posts: { senderId?: string; msg: CotalMessage }[],
): ChannelMember[] {
  const seen = new Set<string>();
  const out: ChannelMember[] = [];
  const add = (id: string | undefined, source: ChannelMember["source"]) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, source });
  };
  if (feedAuthoritative(membership)) {
    const known = [...knownChannels, channel];
    for (const m of membership.snapshot!.members) {
      const { channels, wide } = memberChannels(m.live ?? [], m.durable ?? [], known);
      if (wide || channels.has(channel)) add(m.id, "membership");
    }
    return out;
  }
  for (const p of posts) if (p.msg.channel === channel) add(p.senderId ?? p.msg.from.id, "traffic");
  return out;
}

/** The channels one agent is in, decided the way `channelMembers` decides a channel's members: from
 *  the broker's membership when its feed is authoritative, else the channels it has posted in.
 *  `wide` is a reader of every channel (`>` or `*`), which lists no channel one by one. `modes` are
 *  the agent's own per-channel modes from its presence; a channel it has a mode on is listed even
 *  when nothing else names it. Only `quiet` and `muted` are modes; anything else the wire carries is
 *  dropped rather than shown. Channels come sorted by name. */
export function agentChannels(
  id: string,
  membership: DashboardState["membership"],
  knownChannels: string[],
  posts: { senderId?: string; msg: CotalMessage }[],
  modes: Record<string, string> | undefined,
): { channels: { channel: string; mode?: "quiet" | "muted" }[]; wide: boolean } {
  const names = new Set<string>();
  let wide = false;
  const authoritative = feedAuthoritative(membership);
  if (authoritative) {
    const me = membership.snapshot!.members.find((m) => m.id === id);
    if (me) {
      const mine = memberChannels(me.live ?? [], me.durable ?? [], knownChannels);
      wide = mine.wide;
      for (const ch of mine.channels.keys()) names.add(ch);
    }
  } else {
    for (const p of posts) if ((p.senderId ?? p.msg.from?.id) === id && typeof p.msg.channel === "string") names.add(p.msg.channel);
  }
  const moded = new Map<string, "quiet" | "muted">();
  for (const [ch, mode] of Object.entries(modes ?? {})) if (mode === "quiet" || mode === "muted") moded.set(ch, mode);
  for (const ch of moded.keys()) names.add(ch);
  const channels = [...names].sort().map((channel) => (moded.has(channel) ? { channel, mode: moded.get(channel)! } : { channel }));
  return { channels, wide };
}
