import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, currentPhase, fontFamily, gridLine, pick, spliceWordmark, WM_WIDTH, type Cell, type Dot } from "../_shared";
import { Grid, PhaseLabel, Ticker, Tagline } from "../components";

// Four peers, every pair directly connected — no bus, no hub. The center "+"
// is just where edges cross. Pushes the many-to-many lateral story hardest.
const W = 100;

const RAW: string[] = [
  gridLine([45, "(alice)"]),
  gridLine([47, "/"], [48, "|"], [49, "\\"]),
  gridLine([46, "/"], [48, "|"], [50, "\\"]),
  gridLine([45, "/"], [48, "|"], [51, "\\"]),
  gridLine([38, "(dave)"], [44, "----"], [48, "+"], [49, "---"], [53, "(bob)"]),
  gridLine([45, "\\"], [48, "|"], [51, "/"]),
  gridLine([46, "\\"], [48, "|"], [50, "/"]),
  gridLine([47, "\\"], [48, "|"], [49, "/"]),
  gridLine([45, "(carol)"]),
];
const GRID = spliceWordmark(RAW.concat(Array(7).fill("")), W, 11, (W - WM_WIDTH) >> 1);

const EDGE = {
  aliceBob: [{ row: 1, col: 49 }, { row: 2, col: 50 }, { row: 3, col: 51 }, { row: 4, col: 52 }],
  aliceDave: [{ row: 1, col: 47 }, { row: 2, col: 46 }, { row: 3, col: 45 }, { row: 4, col: 44 }],
  aliceCarol: [1, 2, 3, 4, 5, 6, 7].map((r) => ({ row: r, col: 48 })),
  bobCarol: [{ row: 5, col: 51 }, { row: 6, col: 50 }, { row: 7, col: 49 }, { row: 8, col: 48 }],
} satisfies Record<string, Cell[]>;

function flowDots(mode: string, t: number): Dot[] {
  if (mode === "multicast") {
    return [
      { ...pick(EDGE.aliceBob, t), color: C.cyan },
      { ...pick(EDGE.aliceDave, t), color: C.cyan },
      { ...pick(EDGE.aliceCarol, t), color: C.cyan },
    ];
  }
  if (mode === "unicast") return [{ ...pick(EDGE.aliceBob, t), color: C.magenta }];
  return [{ ...pick(EDGE.bobCarol, t), color: C.yellow }]; // anycast → reviewer (carol)
}

export const MeshFull: React.FC = () => {
  const frame = useCurrentFrame();
  const { phase, t } = currentPhase(frame);
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={flowDots(phase.mode, t)} top={18} fontSize={16} />
      <PhaseLabel label={phase.label} color={phase.color} t={t} />
      <Ticker frame={frame} />
      <Tagline text="every peer reachable by every peer — no hub" frame={frame} />
    </AbsoluteFill>
  );
};
