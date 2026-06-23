// DemoCodexShuffle — same as DemoMergedCodex, but the vendor-topology beat uses
// the SHUFFLE variant: a different vendor leads each phase and the peer ring is
// re-ordered (Claude Code is never on top in P2/P3/P4). Seamless loop.
// 110+240+135+120 = 605f / 20s.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline } from "./S0Headline";
import { S5TopologyShuffle } from "./S5TopologyShuffle";
import { S7Command } from "./S7Command";
import { S6Logo } from "./S6Logo";

const DURATION = 605;

export const DemoCodexShuffle: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={110}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={240}><S5TopologyShuffle /></Series.Sequence>
        <Series.Sequence durationInFrames={135}><S7Command /></Series.Sequence>
        <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
