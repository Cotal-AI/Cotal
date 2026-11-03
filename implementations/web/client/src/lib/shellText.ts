// What the shell's status lines and the document title say, as pure functions of the store. Each is
// a decision the old pages made inside their DOM code (`renderStale`, `orderNoticeHtml`, and the
// `document.title` assignment in the poll), pulled out so a suite can run it in Node and so the
// view that draws it only places the result.
import type { OrderNote } from "./eventOrder.js";
import { staleLabel, type StaleMark } from "./snapshot.js";

/** The stale marker: whether to show it, its label and its tooltip.
 *
 *  Recovery CLEARS the claim and does not only hide it. Hidden text comes back the moment anything
 *  unhides the element, and the reader would then be told a source is stale that recovered some time
 *  ago. So an empty set has an empty label and an empty tooltip as well as `hidden`. */
export function staleView(stale: StaleMark[]): { hidden: boolean; text: string; title: string } {
  const text = staleLabel(stale);
  return { hidden: !text, text, title: stale.map((s) => `${s.name}: ${s.reason}`).join("\n") };
}

const two = (n: number): string => String(n).padStart(2, "0");
/** `hh:mm` in the reader's own clock. */
const hhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
/** `hh:mm:ss` in the reader's own clock. */
const hhmmss = (ts: number): string => `${hhmm(ts)}:${two(new Date(ts).getSeconds())}`;

/** The plain sentences under the marker's label, in the notes' words, one per kind of mark:
 *
 *  - Refused reads: "Showing what we last read at 10:51. Retrying." The time is the OLDEST last
 *    successful read among the refused sources, so no source is claimed fresher than it is. When none
 *    of them has ever read, nothing on screen came from them, and the line is only "Retrying.".
 *  - The observer's silent presence watch (the `roster` mark): "No presence updates since 10:52:14.
 *    Showing the last roster we heard." While the watch is still loading it has no silent-since time,
 *    so there is no line and the reason stays in the tooltip.
 *  - A partial read: "1 of 2 sources answered".
 *
 *  "Retrying." is true because `startDashboard` reads again on a timer while any refused mark stands. */
export function staleLines(stale: StaleMark[]): string[] {
  const lines: string[] = [];
  const refused = stale.filter((s) => s.kind !== "partial" && s.name !== "roster");
  if (refused.length) {
    const read = refused.map((s) => s.lastRead).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
    lines.push(read.length ? `Showing what we last read at ${hhmm(Math.min(...read))}. Retrying.` : "Retrying.");
  }
  const roster = stale.find((s) => s.kind !== "partial" && s.name === "roster");
  if (roster?.since !== undefined && Number.isFinite(roster.since)) lines.push(`No presence updates since ${hhmmss(roster.since)}. Showing the last roster we heard.`);
  for (const p of stale) if (p.kind === "partial" && p.read !== undefined && p.of !== undefined) lines.push(`${p.read} of ${p.of} sources answered`);
  return lines;
}

/** What the Activity view says when its source alone answered: the half of the feed it still shows. */
const ONLY: Record<string, string> = {
  "direct messages": "Direct messages didn't load in time, so this page shows channel messages only.",
  chat: "Channel messages didn't load in time, so this page shows direct messages only.",
};

/** The banner at the top of the Activity view while the activity read is partial (mock section B,
 *  Partial), or undefined when it is whole. `count` is "1 of 2 sources answered". `body` says which
 *  half of the feed is on the page, and is drawn only when exactly one source is missing, since with
 *  both gone there is no half to name. `title` is the server's reasons, one source per line. */
export function partialBanner(stale: StaleMark[]): { label: string; count?: string; body?: string; title: string } | undefined {
  const p = stale.find((s) => s.kind === "partial" && s.name === "activity");
  if (!p) return undefined;
  const missing = p.missing ?? [];
  return {
    label: `partial: ${p.name}`,
    count: p.read !== undefined && p.of !== undefined ? `${p.read} of ${p.of} sources answered` : undefined,
    body: missing.length === 1 && Object.hasOwn(ONLY, missing[0]) ? ONLY[missing[0]] : undefined,
    title: p.reason,
  };
}

/** The order notes as the line the feed views draw above their rows, or `undefined` for an ordinary
 *  feed.
 *
 *  THIS EXISTS BECAUSE COMPUTING A GAP AND DRAWING ONE ARE DIFFERENT CLAIMS. The machine detects a
 *  missing frame; a gap that reaches only an unused variable is a gap nobody sees. A reader has to
 *  be able to act differently on a lost frame, an evicted prefix and an ordinary feed, so the kinds
 *  are three different statements: collapsing them would put the one that always happens on a late
 *  join next to the one that must never be ignored. `fault` is true when a frame is missing, so the
 *  view can mark it without relying on colour. */
export function orderNotice(notes: OrderNote[]): { text: string; fault: boolean } | undefined {
  const gaps = notes.filter((n) => n.type === "gap");
  const races = notes.filter((n) => n.type === "boundary-hole");
  const prefixes = notes.filter((n) => n.type === "prefix-incomplete");
  const failures = notes.filter((n) => n.type === "backfill-failed");
  const parts: string[] = [];
  if (gaps.length) {
    const missing = gaps.reduce((sum, g) => sum + (g.missing || 0), 0);
    parts.push(`${missing} event frame${missing === 1 ? "" : "s"} missing (${gaps.length} break${gaps.length === 1 ? "" : "s"} in the stream)`);
  }
  if (races.length) parts.push(`${races.length} possible ordering race${races.length === 1 ? "" : "s"} at start-up, unconfirmed`);
  if (prefixes.length) parts.push(`${prefixes.length} stream${prefixes.length === 1 ? "" : "s"} joined after the start, earlier frames not retained`);
  if (failures.length) parts.push("history unavailable, so ordering is based on live frames only");
  if (!parts.length) return undefined;
  return { text: parts.join(" · "), fault: gaps.length > 0 };
}

/** The tab title. The space is what the server named, so before the first read lands it is just the
 *  product name, and a refused read leaves the last good title as it was. */
export function documentTitle(space: string | null): string {
  return space === null ? "Cotal" : `Cotal · ${space}`;
}

/** The Activity row's rate: the messages per second rounded to one decimal, with no trailing `.0`, so
 *  `0.8 msg/s`, `4 msg/s` and, with nothing arriving, `0 msg/s`. */
export function rateText(perSecond: number): string {
  return `${Math.round(perSecond * 10) / 10} msg/s`;
}
