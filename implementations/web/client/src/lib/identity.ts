// Which agent is which when several draw the same character: the initial badge's letter and its
// colour slot, worked out from roster names alone so every browser agrees.
import type { Status } from "./roster.js";

/** How many badge fills there are (`--id-1` to `--id-8` in tokens.css). */
const SLOTS = 8;

/** What a badge draws: its letter and its colour slot, 1 to 8. */
export interface Badge {
  letter: string;
  slot: number;
}

/** The badge text: the name's first character, uppercased, plus the digits of a trailing `_<n>`
 *  (`reviewer_2` gives "R2"). An empty name gives "". */
export function initials(name: string): string {
  const first = [...name][0];
  if (first === undefined) return "";
  const n = /_(\d+)$/.exec(name);
  return first.toUpperCase() + (n ? n[1] : "");
}

/** The colour slot, 1 to 8, from the name alone, so an agent keeps its colour across restarts and
 *  reloads: the mock's hash, h = 7, then for each character h = h * 31 + its code, kept to 32 bits. */
export function slotOf(name: string): number {
  let h = 7;
  for (const ch of name) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return (h % SLOTS) + 1;
}

/** Name order, then id, by code unit rather than by locale, so every browser probes in one order. */
const byName = (a: { id: string; name: string }, b: { id: string; name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Slots for every row. Live rows (status not offline) are taken in name order, then id; each starts
 *  at `slotOf(name)` and moves to the next free slot while one is taken. Presence carries no join
 *  time, so name order stands in for "the later joiner moves". Once all eight are taken, a further
 *  live row keeps `slotOf(name)` and colours repeat. Offline rows keep `slotOf(name)`; their fill is
 *  grey anyway. */
export function assignSlots(rows: readonly { id: string; name: string; status: Status }[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const live = rows.filter((r) => r.status !== "offline").sort(byName);
  for (const r of live) {
    let slot = slotOf(r.name);
    if (taken.size < SLOTS) while (taken.has(slot)) slot = (slot % SLOTS) + 1;
    taken.add(slot);
    out.set(r.id, slot);
  }
  for (const r of rows) if (r.status === "offline") out.set(r.id, slotOf(r.name));
  return out;
}
