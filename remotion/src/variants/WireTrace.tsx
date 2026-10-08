import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, fontFamily, gridLine, spliceWordmark, WM_WIDTH, type Dot } from "../_shared";
import { Grid, Ticker, Tagline } from "../components";

// Protocol-forward: one message routing across the four subject lanes, with
// the envelope fields shown above. From packages/core/src/subjects.ts.
const W = 100;
const TRACK_A = 32; // dot travels cols 32..69
const TRACK_B = 69;

const LANES = [
  { subject: "cotal.demo.chat.general", mode: "multicast", color: C.cyan },
  { subject: "cotal.demo.inst.bob", mode: "unicast", color: C.magenta },
  { subject: "cotal.demo.svc.reviewer", mode: "anycast", color: C.yellow },
  { subject: "cotal.demo.ctl.manager", mode: "control", color: C.green },
];

function laneRow(subject: string, mode: string): string {
  const track = "-".repeat(TRACK_B - TRACK_A);
  return gridLine(
    [4, subject],
    [TRACK_A, track + ">"],
    [TRACK_B + 3, mode],
  );
}

const RAW: string[] = [
  gridLine([4, "envelope  { id · ts · space · from · parts[] }   target: channel | to | toService"]),
  "",
  laneRow(LANES[0]!.subject, LANES[0]!.mode),
  laneRow(LANES[1]!.subject, LANES[1]!.mode),
  laneRow(LANES[2]!.subject, LANES[2]!.mode),
  laneRow(LANES[3]!.subject, LANES[3]!.mode),
  "",
  "",
];
// lane rows are grid indices 2..5; wordmark below at rows 7..12
const GRID = spliceWordmark(RAW.slice(0, 6).concat(Array(7).fill("")), W, 7, (W - WM_WIDTH) >> 1);

export const WireTrace: React.FC = () => {
  const frame = useCurrentFrame();
  const lane = Math.floor(frame / 30) % 4; // one lane per 30-frame beat
  const t = (frame % 30) / 30;
  const col = Math.round(TRACK_A + t * (TRACK_B - TRACK_A));
  const active = LANES[lane]!;
  const dots: Dot[] = [{ row: 2 + lane, col, color: active.color }];
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={GRID} dots={dots} top={26} fontSize={16} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 52,
          textAlign: "center",
          fontFamily,
          fontSize: 13,
          color: active.color,
          opacity: 0.55 + 0.45 * Math.sin(t * Math.PI),
        }}
      >
        {active.subject}
      </div>
      <Ticker frame={frame} />
      <Tagline text="one envelope · four subjects · three delivery modes" frame={frame} />
    </AbsoluteFill>
  );
};
