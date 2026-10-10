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
