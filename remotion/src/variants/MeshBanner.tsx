import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, currentPhase, fontFamily, gridLine, horizontalPath, pick, spliceWordmark, type Cell, type Dot } from "../_shared";
import { Grid, Tagline } from "../components";

// Short, wide logo banner: wordmark left, a compact peer+bus diagram right.
const W = 100;
const TAP = [53, 64, 76];

const bus = (() => {
  const arr = new Array(W).fill(" ");
  for (let c = TAP[0]!; c <= TAP[2]!; c++) arr[c] = "=";
  for (const t of TAP) arr[t] = "+";
  return arr.join("");
})();

const RAW: string[] = [
  "",
  gridLine([50, "(alice)"], [62, "(bob)"], [73, "(carol)"]),
  gridLine([53, "|"], [64, "|"], [76, "|"]),
  bus,
  gridLine([57, "space: demo"]),
  "",
];
// wordmark on the LEFT, vertically aligned with the diagram
const GRID = spliceWordmark(RAW, W, 0, 4);

const down = (col: number): Cell[] => [
  { row: 2, col },
  { row: 3, col },
];
const busRun = (c1: number, c2: number) => horizontalPath(3, c1, c2);

function flowDots(mode: string, t: number): Dot[] {
  const [A, B, Cc] = TAP as [number, number, number];
  if (mode === "multicast") {
    return [
      { ...pick([...down(A), ...busRun(A, B), { row: 2, col: B }], t), color: C.cyan },
      { ...pick([...down(A), ...busRun(A, Cc), { row: 2, col: Cc }], t), color: C.cyan },
    ];
  }
  if (mode === "unicast")
    return [{ ...pick([...down(A), ...busRun(A, B), { row: 2, col: B }], t), color: C.magenta }];
  return [{ ...pick([...down(B), ...busRun(B, Cc), { row: 2, col: Cc }], t), color: C.yellow }];
}

export const MeshBanner: React.FC = () => {
  const frame = useCurrentFrame();
  const { phase, t } = currentPhase(frame);
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={flowDots(phase.mode, t)} top={34} fontSize={18} />
      <Tagline text="lateral peers in a shared pub/sub space" frame={frame} />
    </AbsoluteFill>
  );
};
