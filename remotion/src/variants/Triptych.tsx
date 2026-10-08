import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, currentPhase, fontFamily, gridLine, pick, spliceWordmark, WM_WIDTH, type Cell, type Dot } from "../_shared";
import { Grid, Tagline } from "../components";

// Educational: the three delivery modes side by side, the active one lit.
const W = 102;
const ORIGIN = { multicast: 4, unicast: 38, anycast: 70 } as const;

// Per-panel art (local cols, padded later). Targets sit at local cols 2/10/18.
const PANELS: Record<string, string[]> = {
  multicast: [
    "      (alice)       ",
    "    +----+----+     ",
    "    |    |    |     ",
    "    v    v    v     ",
    "  (bob) (cl) (dave) ",
    "     multicast      ",
    "   one → everyone   ",
  ],
  unicast: [
    "      (alice)       ",
    "         |          ",
    "         |          ",
    "         v          ",
    "       (bob)        ",
    "      unicast       ",
    "    one → one peer  ",
  ],
  anycast: [
    "      (alice)       ",
    "    +····+····+     ",
    "    :    |    :     ",
    "    .    v    .     ",
    "  (rv1) (rv2)(rv3)  ",
    "      anycast       ",
    "  one → any of role ",
  ],
};

const RAW: string[] = Array.from({ length: 7 }, (_, r) =>
  gridLine(
    [ORIGIN.multicast, PANELS.multicast![r]!],
    [ORIGIN.unicast, PANELS.unicast![r]!],
    [ORIGIN.anycast, PANELS.anycast![r]!],
  ),
);
// wordmark below the panels at rows 8..13
const GRID = spliceWordmark(RAW.concat(Array(7).fill("")), W, 8, (W - WM_WIDTH) >> 1);

// Vertical drop on a given absolute column (rows 2→3 of a panel).
const drop = (col: number): Cell[] => [
  { row: 2, col },
  { row: 3, col },
];

function dotsFor(mode: string, t: number): Dot[] {
  const out: Dot[] = [];
  const add = (origin: number, cols: number[], color: string) => {
    for (const c of cols) out.push({ ...pick(drop(origin + c), t), color });
  };
  if (mode === "multicast") add(ORIGIN.multicast, [9, 5, 13], C.cyan);
  else if (mode === "unicast") add(ORIGIN.unicast, [9], C.magenta);
  else add(ORIGIN.anycast, [9], C.yellow); // solid path to the chosen instance
  return out;
}

export const Triptych: React.FC = () => {
  const frame = useCurrentFrame();
  const { phase, t } = currentPhase(frame);
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={dotsFor(phase.mode, t)} top={24} fontSize={16} />
      <Tagline text="multicast · unicast · anycast — the three ways peers reach each other" frame={frame} />
    </AbsoluteFill>
  );
};
