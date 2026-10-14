// The membership model: what the header pill says about the mesh's membership feed, and how an
// agent's subscriptions expand into channel spokes. Ported from the old plain-JS graph page
// (`setFeed`, `feedAuthoritative`, `memberChannels`, `patternMatches`). Pure: no window, no document, no I/O.
import type { DashboardState } from "../state/types.js";

/** A snapshot older than this is stale. The daemon polls well inside it, so an older `asOf` means
 *  the feed stopped being written. */
export const FEED_STALE_MS = 45_000;

/** What the pill claims. `traffic-only` is a claim about the MESH (no membership feed is being
 *  published); `unreadable` is a claim about US (the last attempt to read it failed). They are
 *  different facts and the pill keeps them apart. */
export type Pill = "live" | "stale" | "traffic-only" | "unreadable";

type Membership = DashboardState["membership"];

/** "There is a feed and it said something": a snapshot that carries a heartbeat or any member. A
 *  snapshot with neither is what a space with no membership feed answers. */
function available(m: Membership): boolean {
  const snap = m.snapshot;
  return snap !== undefined && (snap.asOf !== undefined || (Array.isArray(snap.members) && snap.members.length > 0));
}

/** UNREADABLE IS CHECKED FIRST. It arrives with no members, so testing `available` first would call
 *  a failed read "traffic-only", which says no feed exists when the truth is that we could not
 *  find out. */
export function pillState(m: Membership, now: number): Pill {
  if (m.unreadable !== undefined) return "unreadable";
  if (!available(m)) return "traffic-only";
  const asOf = m.snapshot!.asOf;
  const age = asOf ? now - asOf : Infinity;
  return age < FEED_STALE_MS ? "live" : "stale";
}

/** Whether the snapshot may be treated as what IS. The last snapshot of an unreadable feed is still
 *  the last thing we KNEW, but it is no longer what is, and `hide empty` asserts that a hub has no
 *  member now. */
export function feedAuthoritative(m: Membership): boolean {
  return available(m) && m.unreadable === undefined;
}

const isWild = (channel: string) => channel.split(".").some((s) => s === "*" || s === ">");

/** Port of core's `subjectMatches`: `*` matches one token, a trailing `>` one or more. */
export function patternMatches(pattern: string, channel: string): boolean {
  const p = pattern.split(".");
  const s = channel.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return i < s.length;
    if (i >= s.length) return false;
    if (p[i] === "*") continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

/** Expand an agent's live patterns and durable channels into channel to kind, plus `wide`.
 *
 *  A bounded wildcard (`team.>`) expands against the KNOWN channels. A concrete pattern stands
 *  alone. `live` wins over `durable`. A whole-breadth pattern (`>` or `*`, the default persona's
 *  read-everything grant) is NOT expanded to a spoke per channel, which would be a dandelion: it
 *  sets `wide`, and the agent shows as a reads-all badge instead, true without per-channel noise. */
export function memberChannels(
  live: string[],
  durable: string[],
  known: string[],
): { channels: Map<string, "live" | "durable">; wide: boolean } {
  const channels = new Map<string, "live" | "durable">();
  let wide = false;
  for (const pat of live) {
    if (pat === ">" || pat === "*") {
      wide = true;
      continue;
    }
    if (isWild(pat)) {
      for (const ch of known) if (patternMatches(pat, ch)) channels.set(ch, "live");
    } else channels.set(pat, "live");
  }
  for (const ch of durable) if (!channels.has(ch)) channels.set(ch, "durable");
  return { channels, wide };
}
