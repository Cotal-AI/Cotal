import { formatAge, type PresenceStatus } from "@cotal-ai/core";
import { displayWidth } from "@cotal-ai/workspace";

// Per-agent color: a stable name→hex hash. These are render.ts's 256-color palette
// indices converted to hex, so names read the same as the classic dashboard — and they
// avoid the status hues (green/yellow/gray) so a name never looks like a status.
const PALETTE = [
  "#00afff", "#ff8700", "#d75fd7", "#5fd787", "#ffaf00", "#87afff", "#ff5f5f",
  "#afd787", "#af87ff", "#d7af87", "#87d7ff", "#ffd787", "#5fafff", "#ff875f",
];
const colorCache = new Map<string, string>();

export function agentColor(name: string): string {
  let hex = colorCache.get(name);
  if (hex === undefined) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    hex = PALETTE[h % PALETTE.length];
    colorCache.set(name, hex);
  }
  return hex;
}

export const STATUS: Record<PresenceStatus, { dot: string; color: string; word: string }> = {
  working: { dot: "●", color: "green", word: "working" },
  waiting: { dot: "◐", color: "yellow", word: "waiting" },
  idle: { dot: "○", color: "gray", word: "idle" },
  offline: { dot: "⨯", color: "gray", word: "offline" },
};

/** A peer stamps on its own clock, so a stamp ahead of this one is skew, not a negative age. */
export function ago(epochMs: number): string {
  return formatAge(Math.max(0, Date.now() - epochMs));
}

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Greedy word-wrap to a width in terminal columns, where a wide character such as a CJK ideograph or
// an emoji takes two; hard-splits a single word wider than width between its grapheme clusters.
// Honors embedded newlines and always returns at least one line.
export function wrapText(s: string, width: number): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  for (const rawLine of s.split(/\r?\n/)) {
    let cur = "";
    let used = 0;
    for (const word of rawLine.split(" ")) {
      let token = word;
      let size = displayWidth(token);
      while (size > w) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        let head = "";
        let headSize = 0;
        for (const { segment } of graphemes.segment(token)) {
          const n = displayWidth(segment);
          if (head && headSize + n > w) break;
          head += segment;
          headSize += n;
        }
        out.push(head);
        token = token.slice(head.length);
        size -= headSize;
      }
      if (cur === "") {
        cur = token;
        used = size;
      } else if (used + 1 + size <= w) {
        cur += " " + token;
        used += 1 + size;
      } else {
        out.push(cur);
        cur = token;
        used = size;
      }
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}

// The longest run of whole grapheme clusters from the start of s that fits width terminal columns.
export function clipText(s: string, width: number): string {
  let head = "";
  let used = 0;
  for (const { segment } of graphemes.segment(s)) {
    used += displayWidth(segment);
    if (used > width) break;
    head += segment;
  }
  return head;
}

/** A row of {@link wrapPieces}: its pieces, each marked when it is a dated fact. */
export type FactRow = { text: string; dated: boolean }[];

/** A piece for {@link wrapPieces}: its text with its separator, for a row it shares, and without,
 *  for a row it starts. */
export type Piece = { shared: string; alone: string; dated: boolean };

// Wraps pieces to a column width at their boundaries: pieces share a row while they fit, a piece
// that starts a row drops its separator, and only a piece wider than the column word-wraps, so no
// piece is ever cut.
export function wrapPieces(pieces: Piece[], width: number): FactRow[] {
  const rows: FactRow[] = [];
  let used = 0;
  for (const { shared, alone, dated } of pieces) {
    const size = displayWidth(shared);
    if (rows.length && used + size <= width) {
      rows[rows.length - 1].push({ text: shared, dated });
      used += size;
    } else
      for (const text of wrapText(alone, width)) {
        rows.push([{ text, dated }]);
        used = displayWidth(text);
      }
  }
  return rows;
}

// Wraps a status line with wrapPieces at its fact boundaries, the " (" before a condition and the
// " · " before each dated fact. A condition that starts a row also drops its parentheses, which only
// tie it to the status word on a shared row.
export function wrapFacts(s: string, width: number): FactRow[] {
  return wrapPieces(
    s.split(/(?= · | \()/).map((shared) => ({ shared, alone: shared.replace(/^ · |^ \((.*)\)$/, "$1"), dated: shared.startsWith(" · ") })),
    width,
  );
}

// The run of whole items, `heights` rows each, that fits `room` rows around `sel`: the items above
// it take up to half the rows it leaves, the items below the rest, and rows left free at the end
// of the list go back to the items above.
export function windowAround(heights: number[], sel: number, room: number): [start: number, end: number] {
  let start = sel;
  let end = sel + 1;
  let used = heights[sel] ?? 0;
  const above = used + Math.floor((room - used) / 2);
  while (start > 0 && used + heights[start - 1] <= above) used += heights[--start];
  while (end < heights.length && used + heights[end] <= room) used += heights[end++];
  while (start > 0 && used + heights[start - 1] <= room) used += heights[--start];
  return [start, end];
}

/** Shared roster/DM peer pane size within the available body. */
export function sidePaneSize(width: number, height: number, narrow: boolean): { w: number; h: number } {
  return narrow
    ? { w: width, h: Math.min(8, Math.max(3, Math.floor(height * 0.35))) }
    : { w: Math.min(36, Math.max(24, Math.floor(width * 0.3))), h: height };
}
