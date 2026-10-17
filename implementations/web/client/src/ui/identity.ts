import { createContext, useContext } from "react";
import { assignSlots, initials, type Badge } from "../lib/identity.js";
import type { RosterRow } from "../lib/roster.js";

/** The badge for a roster id, or undefined for an id the roster does not hold. The shell provides
 *  it; outside the shell nothing has a badge. */
export const BadgeOf = createContext<(id: string) => Badge | undefined>(() => undefined);

/** The shell's badge lookup, for a component that draws a roster row's avatar. */
export function useBadgeOf(): (id: string) => Badge | undefined {
  return useContext(BadgeOf);
}

/** The lookup the shell provides: every row, offline included, by id, with its letter from its name
 *  and its slot from `assignSlots`. */
export function badgeLookup(rows: readonly RosterRow[]): (id: string) => Badge | undefined {
  const slots = assignSlots(rows);
  const badges = new Map<string, Badge>();
  for (const r of rows) {
    const slot = slots.get(r.id);
    if (slot !== undefined) badges.set(r.id, { letter: initials(r.name), slot });
  }
  return (id) => badges.get(id);
}
