import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import {
  busRoute,
  C,
  currentPhase,
  fontFamily,
  gridLine,
  pick,
  spliceWordmark,
  WM_WIDTH,
  type Dot,
} from "../_shared";
import { Grid, PhaseLabel, Ticker, Tagline } from "../components";

// Peers as equals on one shared bus — no central broker. The bus IS the space.
const W = 100;
const BOX = "+--------------+"; // 16 wide
// box starts + their center taps (start + 7)
const BOXES = [
  { col: 6, label: "| alice/planner|" },
  { col: 42, label: "| bob/builder  |" },
  { col: 78, label: "|carol/reviewer|" },
];
const TAP = BOXES.map((b) => b.col + 7); // 13, 49, 85
const [A, B, Cc] = TAP as [number, number, number];

const bus = (() => {
  const arr = new Array(W).fill(" ");
  for (let c = BOXES[0]!.col; c < BOXES[2]!.col + 16; c++) arr[c] = "=";
  for (const t of TAP) arr[t] = "+";
  return arr.join("");
})();

const RAW: string[] = [
  gridLine(...BOXES.map((b) => [b.col, BOX] as [number, string])),
  gridLine(...BOXES.map((b) => [b.col, b.label] as [number, string])),
  gridLine(...BOXES.map((b) => [b.col, "+------+-------+"] as [number, string])),
  gridLine(...TAP.map((t) => [t, "|"] as [number, string])),
  bus,
  gridLine([6, "one shared pub/sub space  ·  space: demo  ·  no orchestrator on the wire"]),
];
// wordmark centered, one row below the schematic (rows 7..12)
const GRID = spliceWordmark(RAW.concat(Array(7).fill("")), W, 7, (W - WM_WIDTH) >> 1);

function dotsFor(mode: string, t: number): Dot[] {
  if (mode === "multicast") {
    return [
      { ...pick(busRoute(4, A, B), t), color: C.cyan },
      { ...pick(busRoute(4, A, Cc), t), color: C.cyan },
    ];
  }
  if (mode === "unicast") {
    return [{ ...pick(busRoute(4, A, B), t), color: C.magenta }];
  }
  // anycast: bob → whoever is reviewer (carol)
  return [{ ...pick(busRoute(4, B, Cc), t), color: C.yellow }];
}

export const PeerMesh: React.FC = () => {
  const frame = useCurrentFrame();
  const { phase, t } = currentPhase(frame);
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={dotsFor(phase.mode, t)} top={18} fontSize={16} />
      <PhaseLabel label={phase.label} color={phase.color} t={t} />
      <Ticker frame={frame} />
      <Tagline text="lateral peers in a shared pub/sub space" frame={frame} />
    </AbsoluteFill>
  );
};
