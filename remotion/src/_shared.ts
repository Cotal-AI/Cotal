// Shared helpers + constants for the Cotal header variants.
// One baseline (palette, wordmark, grid/animation helpers, subjects); each
// variant under variants/ overrides only its own layout + motion.

import { loadFont } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily } = loadFont();

// --- color palette ----------------------------------------------------------
// Ported from the real CLI: implementations/cli/src/ui.ts (cyan/yellow/green/
// magenta/gray) and render.ts status hues + per-agent 256-color names.

export const C = {
  bg: "#0b0f14",
  text: "#94a3b8",
  dim: "#475569",
  cyan: "#22d3ee",
  yellow: "#fbbf24",
  green: "#4ade80",
  magenta: "#ec4899",
  gray: "#64748b",
  blue: "#60a5fa",
  orange: "#fb923c",
  white: "#f8fafc",
};

// Presence status → glyph + tint (render.ts:194 STATUS table).
export const STATUS = {
  working: { dot: "●", color: C.green, word: "working" },
  waiting: { dot: "◐", color: C.yellow, word: "waiting" },
  idle: { dot: "○", color: C.gray, word: "idle" },
  offline: { dot: "⨯", color: C.dim, word: "offline" },
} as const;

// Stable per-agent name colors (away from the status hues), mirroring
// render.ts agentColor(). Hand-picked hex so each peer reads consistently.
export const AGENT = {
  alice: C.blue,
  bob: C.orange,
  carol: C.magenta,
} as const;

// --- grid helpers -----------------------------------------------------------

export type Seg = [start: number, content: string];

export function gridLine(...segs: Seg[]): string {
  const max = Math.max(0, ...segs.map(([s, c]) => s + c.length));
  const arr = new Array(max).fill(" ");
  for (const [start, content] of segs) {
    for (let i = 0; i < content.length; i++) arr[start + i] = content[i] ?? " ";
  }
  return arr.join("");
}

// --- ANSI Shadow "cotal" wordmark (6 rows × 42 cols) ------------------------

export const WORDMARK: string[] = [
  "███████╗██╗    ██╗ █████╗ ██████╗ ██╗     ",
  "██╔════╝██║    ██║██╔══██╗██╔══██╗██║     ",
  "███████╗██║ █╗ ██║███████║██████╔╝██║     ",
  "╚════██║██║███╗██║██╔══██║██╔══██╗██║     ",
  "███████║╚███╔███╔╝██║  ██║██║  ██║███████╗",
  "╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝",
];
export const WM_WIDTH = 42;

// Splice the wordmark into a grid at (startRow, col).
export function spliceWordmark(
  grid: string[],
  rowWidth: number,
  startRow: number,
  col: number,
): string[] {
  return grid.map((row, y) => {
    const wmIdx = y - startRow;
    if (wmIdx < 0 || wmIdx >= WORDMARK.length) return row.padEnd(rowWidth);
    const arr = [...row.padEnd(rowWidth)];
    const wm = WORDMARK[wmIdx]!;
    for (let i = 0; i < wm.length; i++) arr[col + i] = wm[i]!;
    return arr.join("");
  });
}

// --- subjects (packages/core/src/subjects.ts) -------------------------------

export const SPACE = "demo";
export const SUBJECT = {
  multicast: `cotal.${SPACE}.chat.general`,
  unicast: `cotal.${SPACE}.inst.bob`,
  anycast: `cotal.${SPACE}.svc.reviewer`,
  control: `cotal.${SPACE}.ctl.manager`,
};

// The three delivery modes drive the animation phases (30 frames each + a
// closing broadcast beat), the way haa cycled request/reply/event.
export const PHASES = [
  { start: 0, end: 30, label: SUBJECT.multicast, mode: "multicast", color: C.cyan },
  { start: 30, end: 60, label: SUBJECT.unicast, mode: "unicast", color: C.magenta },
  { start: 60, end: 90, label: SUBJECT.anycast, mode: "anycast", color: C.yellow },
  { start: 90, end: 120, label: `${SUBJECT.multicast}  ·  broadcast`, mode: "multicast", color: C.cyan },
] as const;

export type Phase = (typeof PHASES)[number];

export function currentPhase(frame: number): { phase: Phase; t: number } {
  const phase = PHASES.find((p) => frame >= p.start && frame < p.end) ?? PHASES[0]!;
  const t = Math.max(0, Math.min(1, (frame - phase.start) / (phase.end - phase.start)));
  return { phase, t };
}

// --- dot animation ----------------------------------------------------------

export type Cell = { row: number; col: number };
export type Dot = { row: number; col: number; color: string; char?: string };

// Both endpoints are kept and the cells run in travel order, so a dot can ride the
// path from either end with pick().
export function horizontalPath(row: number, startCol: number, endCol: number): Cell[] {
  const step = endCol >= startCol ? 1 : -1;
  const out: Cell[] = [];
  for (let col = startCol; col !== endCol + step; col += step) out.push({ row, col });
  return out;
}

export function pick<T>(path: T[], t: number): T {
  const i = Math.min(Math.floor(t * path.length), path.length - 1);
  return path[Math.max(0, i)]!;
}

// --- scrolling event ticker -------------------------------------------------
// Mirrors a real `cotal console --plain` log line: time · verb · peer → target: text.

type TSeg = { text: string; color: string };
const EVENTS: TSeg[][] = [
  [
    { text: "14:02:18", color: C.dim },
    { text: " join  ", color: C.green },
    { text: "alice", color: AGENT.alice },
    { text: "/planner", color: C.dim },
  ],
  [
    { text: "14:02:21", color: C.dim },
    { text: " #general ", color: C.cyan },
    { text: "alice", color: AGENT.alice },
    { text: " → ", color: C.dim },
    { text: "all: ", color: C.text },
    { text: "who can review?", color: C.dim },
  ],
  [
    { text: "14:02:23", color: C.dim },
    { text: " @reviewer ", color: C.yellow },
    { text: "bob", color: AGENT.bob },
    { text: " → ", color: C.dim },
    { text: "carol", color: AGENT.carol },
    { text: ": on it", color: C.dim },
  ],
];
const SEP: TSeg = { text: "   ·   ", color: C.dim };

type FCell = { ch: string; color: string };
function flatten(): FCell[] {
  const out: FCell[] = [];
  EVENTS.forEach((ev, i) => {
    for (const s of ev) for (const ch of s.text) out.push({ ch, color: s.color });
    if (i < EVENTS.length - 1) for (const ch of SEP.text) out.push({ ch, color: SEP.color });
  });
  for (const ch of SEP.text) out.push({ ch, color: SEP.color }); // wrap separator
  return out;
}
const STREAM: FCell[] = flatten();
export const STREAM_PERIOD = STREAM.length;
const TRIPLE: FCell[] = [...STREAM, ...STREAM, ...STREAM];

export function tickerCells(frame: number, cols: number): FCell[] {
  const start = frame % STREAM_PERIOD;
  return TRIPLE.slice(start, start + cols);
}

// Group adjacent same-color cells into spans (fewer DOM nodes).
export function groupSpans(cells: FCell[]): { text: string; color: string }[] {
  const parts: { text: string; color: string }[] = [];
  let i = 0;
  while (i < cells.length) {
    const color = cells[i]!.color;
    let text = "";
    while (i < cells.length && cells[i]!.color === color) text += cells[i++]!.ch;
    parts.push({ text, color });
  }
  return parts;
}

// --- shared CSS for the monospace grid --------------------------------------

export const GRID_STYLE = {
  fontFamily,
  fontSize: 16,
  lineHeight: "16px",
  whiteSpace: "pre" as const,
  letterSpacing: 0,
  fontFeatureSettings: '"liga" 0, "calt" 0',
  fontVariantLigatures: "none" as const,
};
