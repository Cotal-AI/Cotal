import { formatAge, type PresenceStatus } from "@cotal-ai/core";

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

// Greedy word-wrap to a column width; hard-splits a single word longer than width.
// Honors embedded newlines and always returns at least one line.
export function wrapText(s: string, width: number): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  for (const rawLine of s.split(/\r?\n/)) {
    let cur = "";
    for (const word of rawLine.split(" ")) {
      let token = word;
      while (token.length > w) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        out.push(token.slice(0, w));
        token = token.slice(w);
      }
      if (cur === "") cur = token;
      else if (cur.length + 1 + token.length <= w) cur += " " + token;
      else {
        out.push(cur);
        cur = token;
      }
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}

/** A row of {@link wrapFacts}: its pieces, each marked when it is a dated fact. */
export type FactRow = { text: string; dated: boolean }[];

// Wraps a status line to a column width at its fact boundaries, the " (" before a condition and the
// " · " before each dated fact: facts share a row while they fit, a fact that starts a row drops its
// separator (a condition its parentheses, which only tie it to the status word on a shared row), and
// only a fact wider than the column word-wraps, so no fact is ever cut.
export function wrapFacts(s: string, width: number): FactRow[] {
  const rows: FactRow[] = [];
  let used = 0;
  for (const piece of s.split(/(?= · | \()/)) {
    const dated = piece.startsWith(" · ");
    if (rows.length && used + piece.length <= width) {
      rows[rows.length - 1].push({ text: piece, dated });
      used += piece.length;
    } else
      for (const text of wrapText(piece.replace(/^ · |^ \((.*)\)$/, "$1"), width)) {
        rows.push([{ text, dated }]);
        used = text.length;
      }
  }
  return rows;
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
