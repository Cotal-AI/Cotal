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
