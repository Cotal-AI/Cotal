// Direct messages rolled up per peer. Every name, role and status comes from the roster by id: a
// payload's `from.name` is sender-chosen display text and is never read here.
import type { RosterEntry } from "../api/types.js";
import type { StoredMessage } from "../state/types.js";
import { displayNameOf, nameIndex } from "./names.js";

export interface DmConversation {
  key: string;
  with: string;
  messages: StoredMessage[];
  last: number;
  /** True only when every message carries the sender the server read off the subject. A history
   *  row has none, so a conversation holding one is grouped by what the payload says about itself. */
  verified: boolean;
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

/** How many direct messages the dashboard holds: the newest, space-wide. The controller asks the
 *  server for this many and drops the oldest once a live one would pass it, so a conversation whose
 *  earlier messages fall before the window shows only its part inside it. */
export const DM_WINDOW = 500;

/** The messages two parties exchanged, oldest first. `parts` holds both ids sorted, and `opener` is
 *  the sender of the first message held, which is how the sidebar names the conversation. */
export interface DmPair {
  key: string;
  parts: [string, string];
  opener: string;
  messages: StoredMessage[];
  last: number;
  verified: boolean;
}

const SEP = "\u0001";

/** The key of the conversation between `a` and `b`, in either order. */
export const pairKey = (a: string, b: string): string => [a, b].sort().join(SEP);

/** Every pair that talked, in the order each first appears in `dms`. The sender is the verified
 *  `senderId` when the row has one, and the payload's `from.id` only for a history row, which carries
 *  no verified sender. */
function group(dms: StoredMessage[]): DmPair[] {
  const pairs = new Map<string, { parts: [string, string]; messages: StoredMessage[] }>();
  for (const m of dms) {
    const from = m.senderId ?? m.msg.from?.id;
    const to = typeof m.msg.to === "string" ? m.msg.to : undefined;
    if (!from || !to || from === to) continue;
    const parts = [from, to].sort() as [string, string];
    const key = parts.join(SEP);
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { parts, messages: [] }));
    pair.messages.push(m);
  }
  const out: DmPair[] = [];
  for (const [key, { parts, messages }] of pairs) {
    messages.sort((a, b) => a.msg.ts - b.msg.ts);
    const first = messages[0];
    out.push({
      key,
      parts,
      opener: first.senderId ?? first.msg.from?.id ?? parts[0],
      messages,
      last: messages[messages.length - 1]?.msg.ts ?? 0,
      verified: messages.every((m) => m.senderId !== undefined),
    });
  }
  return out;
}

/** The conversations in `dms`, newest first. It reads no roster, so a view memoizes it on the DM list
 *  alone and a roster change, which comes with every heartbeat, does not regroup the messages. */
export function dmPairs(dms: StoredMessage[]): DmPair[] {
  return group(dms).sort((a, b) => b.last - a.last);
}

/** Group DMs into per-peer rows; each peer lists its counterparties (conversations). Work is
 *  O(peers with DMs), never the n² pair cross-product: only pairs that actually talked. A peer
 *  absent from the roster is offline with no role. */
export function dmPeers(dms: StoredMessage[], roster: RosterEntry[]): DmPeer[] {
  const idx = nameIndex(roster);
  const byId = new Map<string, RosterEntry>();
  for (const p of roster) if (p.card?.id) byId.set(p.card.id, p);
  const statusOf = (id: string): string => byId.get(id)?.status ?? "offline";

  const peers = new Map<string, { id: string; conversations: DmConversation[]; last: number }>();
  for (const { key, parts, messages, last, verified } of group(dms)) {
    for (const id of parts) {
      const other = parts[0] === id ? parts[1] : parts[0];
      let peer = peers.get(id);
      if (!peer) peers.set(id, (peer = { id, conversations: [], last: 0 }));
      peer.conversations.push({ key, with: other, messages, last, verified });
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
