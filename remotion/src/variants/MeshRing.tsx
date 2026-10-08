import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, currentPhase, fontFamily, gridLine, pick, spliceWordmark, WM_WIDTH, type Cell, type Dot } from "../_shared";
import { Grid, PhaseLabel, Ticker, Tagline } from "../components";

// Peers on a loop, connected around the ring — a circle of equals, no center.
// A token circulates the ring continuously.
const W = 100;
const LV = 20; // left vertical col
const RV = 68; // right vertical col

const RAW: string[] = [
  gridLine([18, "(alice)"], [25, "-".repeat(41)], [66, "(bob)"]),
  gridLine([LV, "|"], [RV, "|"]),
  gridLine([LV, "|"], [RV, "|"]),
  gridLine([LV, "|"], [RV, "|"]),
  gridLine([LV, "|"], [RV, "|"]),
  gridLine([LV, "|"], [RV, "|"]),
  gridLine([18, "(dave)"], [25, "-".repeat(41)], [66, "(carol)"]),
];
const GRID = spliceWordmark(RAW.concat(Array(7).fill("")), W, 9, (W - WM_WIDTH) >> 1);

// One continuous clockwise loop around the ring.
const LOOP: Cell[] = [
  ...Array.from({ length: 41 }, (_, i) => ({ row: 0, col: 25 + i })), // top →
  ...Array.from({ length: 5 }, (_, i) => ({ row: 1 + i, col: RV })), // right ↓
  ...Array.from({ length: 41 }, (_, i) => ({ row: 6, col: 65 - i })), // bottom ←
  ...Array.from({ length: 5 }, (_, i) => ({ row: 5 - i, col: LV })), // left ↑
];

export const MeshRing: React.FC = () => {
  const frame = useCurrentFrame();
  const { phase, t } = currentPhase(frame);
  const lap = (frame % 60) / 60; // two laps over the 120-frame loop
  const dots: Dot[] = [
    { ...pick(LOOP, lap), color: phase.color },
    { ...pick(LOOP, (lap + 0.5) % 1), color: C.cyan },
  ];
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={dots} top={18} fontSize={16} />
      <PhaseLabel label={phase.label} color={phase.color} t={t} />
      <Ticker frame={frame} />
      <Tagline text="a circle of equals — coordination goes around, not up" frame={frame} />
    </AbsoluteFill>
  );
};
