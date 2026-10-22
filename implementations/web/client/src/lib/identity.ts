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

/** Two letters for a name that clashes: its first character uppercased, the next letter as written,
 *  skipping `_`, digits and punctuation, and the digits of a trailing `_<n>` (`lead` gives "Le",
 *  `reviewer_2` gives "Re2", and `l_2`, with no letter after the first, gives "L2"). */
function twoLetters(name: string): string {
  const [first, ...rest] = [...name];
  if (first === undefined) return "";
  const second = rest.find((ch) => /\p{L}/u.test(ch)) ?? "";
  const n = /_(\d+)$/.exec(name);
  return first.toUpperCase() + second + (n ? n[1] : "");
}

/** The badge text for every row, by id. Live rows (status not offline) whose `initials` match
 *  clash, and each of them takes two letters (`twoLetters`), so `lead` and `logic` read "Le" and
 *  "Lo". A clash two letters do not break keeps the two letters; the colour slots still differ.
 *  Offline rows, and live rows with no clash, keep `initials`. */
export function badgeLetters(rows: readonly { id: string; name: string; status: Status }[]): Map<string, string> {
  const live = new Map<string, number>();
  for (const r of rows) if (r.status !== "offline") live.set(initials(r.name), (live.get(initials(r.name)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const r of rows) {
    const one = initials(r.name);
    out.set(r.id, r.status !== "offline" && (live.get(one) ?? 0) > 1 ? twoLetters(r.name) : one);
  }
  return out;
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
