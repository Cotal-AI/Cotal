// id to display name resolution, shared by the DM lens and the all-activity feed.
import type { RosterEntry } from "../api/types.js";

export type NameIndex = Map<string, string>;

/** Source: live roster cards ONLY. A message payload's `from.name` is sender-chosen display text,
 *  not identity (#1399): writing it here would let one peer relabel another. */
export function nameIndex(roster: RosterEntry[]): NameIndex {
  const idName: NameIndex = new Map();
  for (const p of roster) if (p.card?.id) idName.set(p.card.id, p.card.name);
  return idName;
}

/** What the operator's own id reads as while the roster does not hold it. */
export const OPERATOR_YOU = "operator (you)";

/** Resolve an EndpointRef object or a bare id to a display name. An object resolves through its
 *  AUTHENTICATED id; its `.name` is payload text and is never read. An unknown id shrinks to a short
 *  prefix, and a string that is not an identity (already a name) passes through unchanged. `selfId`
 *  is the id the dashboard posts as, which reads "operator (you)" until the roster names it. */
export function displayNameOf(x: string | { id?: string } | undefined, idx: NameIndex, selfId?: string | null): string {
  if (!x) return "?";
  if (selfId && (typeof x === "object" ? x.id : x) === selfId && !idx.has(selfId)) return OPERATOR_YOU;
  if (typeof x === "object") return displayNameOf(x.id, idx);
  const known = idx.get(x);
  if (known !== undefined) return known;
  // Principal ids are exactly two NATS-safe tokens, owner.actor. Keep the opaque owner for
  // namespace disambiguation, but require a long actor so ordinary dotted display names survive.
  const principal = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(x);
  if (principal && principal[2]!.length >= 32) return `${principal[1]}.${principal[2]!.slice(0, 6)}…`;
  return /^[A-Z2-7]{32,}$/.test(x) ? x.slice(0, 6) + "…" : x; // legacy bare identity
}
