// Direct messages rolled up per peer. Every name, role and status comes from the roster by id: a
// payload's `from.name` is sender-chosen display text and is never read here.
import type { CotalMessage, RosterEntry } from "../api/types.js";
import { displayNameOf, nameIndex } from "./names.js";

export interface DmConversation {
  key: string;
  with: string;
  messages: CotalMessage[];
  last: number;
}

export interface DmPeer {
  id: string;
  name: string;
  role?: string;
  status?: string;
  conversations: DmConversation[];
  threads: number;
  last: number;
}

const SEP = "\u0001";

/** Group raw DMs into per-peer rows; each peer lists its counterparties (conversations). Work is
 *  O(peers with DMs), never the n² pair cross-product: only pairs that actually talked. A peer
 *  absent from the roster is offline with no role. */
export function dmPeers(dms: CotalMessage[], roster: RosterEntry[]): DmPeer[] {
  const idx = nameIndex(roster);
  const byId = new Map<string, RosterEntry>();
  for (const p of roster) if (p.card?.id) byId.set(p.card.id, p);
  const statusOf = (id: string): string => byId.get(id)?.status ?? "offline";

  const pairs = new Map<string, { parts: [string, string]; messages: CotalMessage[] }>();
  for (const m of dms) {
    const from = m.from?.id;
    const to = typeof m.to === "string" ? m.to : undefined;
    if (!from || !to || from === to) continue;
    const parts = [from, to].sort() as [string, string];
    const key = parts.join(SEP);
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { parts, messages: [] }));
    pair.messages.push(m);
  }

  const peers = new Map<string, { id: string; conversations: DmConversation[]; last: number }>();
  for (const [key, pair] of pairs) {
    pair.messages.sort((a, b) => a.ts - b.ts);
    const last = pair.messages[pair.messages.length - 1]?.ts ?? 0;
    for (const id of pair.parts) {
      const other = pair.parts[0] === id ? pair.parts[1] : pair.parts[0];
      let peer = peers.get(id);
      if (!peer) peers.set(id, (peer = { id, conversations: [], last: 0 }));
      peer.conversations.push({ key, with: other, messages: pair.messages, last });
      peer.last = Math.max(peer.last, last);
    }
  }

  return [...peers.values()]
    .map((p): DmPeer => ({
      id: p.id,
      name: displayNameOf(p.id, idx),
      role: byId.get(p.id)?.card?.role,
      status: statusOf(p.id),
      conversations: p.conversations.sort((a, b) => b.last - a.last),
      threads: p.conversations.length,
      last: p.last,
    }))
    .sort((a, b) => b.last - a.last);
}
