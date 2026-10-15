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
