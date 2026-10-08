import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import {
  C,
  currentPhase,
  fontFamily,
  gridLine,
  pick,
  spliceWordmark,
  STATUS,
  WM_WIDTH,
  type Cell,
  type Dot,
} from "../_shared";
import { Grid, PhaseLabel, Ticker, Tagline } from "../components";

// Peers live INSIDE one shared "space" container, each carrying a live
// presence badge. Same bus + delivery-mode dots as PeerMesh.
const W = 100;
const L = 2;
const R = 97;
const PEERS = [
  { x: 8, name: "alice/planner", status: "working" as const },
  { x: 40, name: "bob/builder  ", status: "waiting" as const },
  { x: 72, name: "carol/review ", status: "idle" as const },
];
const TOP = "+----------------+"; // 18 wide
const BOT = "+-------+--------+"; // tap at index 8
const TAP = PEERS.map((p) => p.x + 8); // 16, 48, 80
const DOT = PEERS.map((p) => p.x + 1); // presence-badge slot col

function fill(write: (arr: string[]) => void): string {
  const arr = new Array(W).fill(" ");
  write(arr);
  return arr.join("");
}
const border = (extra: [number, string][] = []) =>
  gridLine([L, "|"], [R, "|"], ...extra.map(([c, s]) => [c, s] as [number, string]));

const outerTop = fill((a) => {
  for (let c = L; c <= R; c++) a[c] = "-";
  a[L] = "+";
  a[R] = "+";
  const label = " space: demo ";
  for (let i = 0; i < label.length; i++) a[L + 2 + i] = label[i]!;
});
const outerBot = fill((a) => {
  for (let c = L; c <= R; c++) a[c] = "-";
  a[L] = "+";
  a[R] = "+";
});
const bus = fill((a) => {
  for (let c = TAP[0]!; c <= TAP[2]!; c++) a[c] = "=";
  for (const t of TAP) a[t] = "+";
  a[L] = "|";
  a[R] = "|";
});

const RAW: string[] = [
  outerTop,
  border(),
  border(PEERS.map((p) => [p.x, TOP])),
  border(PEERS.map((p) => [p.x, `|   ${p.name} |`])),
  border(PEERS.map((p) => [p.x, BOT])),
  border(TAP.map((t) => [t, "|"])),
  bus,
  border(),
  outerBot,
];
const GRID = spliceWordmark(RAW.concat(Array(7).fill("")), W, 10, (W - WM_WIDTH) >> 1);

const down = (col: number): Cell[] => [
  { row: 5, col },
  { row: 6, col },
];
const busRun = (c1: number, c2: number): Cell[] => {
  const step = c2 >= c1 ? 1 : -1;
  const out: Cell[] = [];
  for (let c = c1; c !== c2 + step; c += step) out.push({ row: 6, col: c });
  return out;
};

function flowDots(mode: string, t: number): Dot[] {
  const [A, B, Cc] = TAP as [number, number, number];
  if (mode === "multicast") {
    const toB = [...down(A), ...busRun(A, B), { row: 5, col: B }];
    const toC = [...down(A), ...busRun(A, Cc), { row: 5, col: Cc }];
    return [
      { ...pick(toB, t), color: C.cyan },
      { ...pick(toC, t), color: C.cyan },
    ];
  }
  if (mode === "unicast") {
    return [{ ...pick([...down(A), ...busRun(A, B), { row: 5, col: B }], t), color: C.magenta }];
  }
  return [{ ...pick([...down(B), ...busRun(B, Cc), { row: 5, col: Cc }], t), color: C.yellow }];
}

export const MeshFrame: React.FC = () => {
  const frame = useCurrentFrame();
  const { phase, t } = currentPhase(frame);
  // carol wakes up mid-loop so the badges read live
  const carol = frame < 60 ? "idle" : "working";
  const statuses = [PEERS[0]!.status, PEERS[1]!.status, carol] as const;
  const badges: Dot[] = PEERS.map((_, i) => ({
    row: 3,
    col: DOT[i]!,
    color: STATUS[statuses[i]!].color,
    char: STATUS[statuses[i]!].dot,
  }));
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={[...badges, ...flowDots(phase.mode, t)]} top={18} fontSize={16} />
      <PhaseLabel label={phase.label} color={phase.color} t={t} />
      <Ticker frame={frame} />
      <Tagline text="peers as equals inside one shared space" frame={frame} />
    </AbsoluteFill>
  );
};
