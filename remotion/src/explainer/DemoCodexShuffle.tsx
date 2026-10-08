// DemoCodexShuffle — same as DemoMergedCodex, but the vendor-topology beat uses
// the SHUFFLE variant: a different vendor leads each phase and the peer ring is
// re-ordered (Claude Code is never on top in P2/P3/P4). Seamless loop.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline, HEADLINE_DURATION } from "./S0Headline";
import { S5TopologyShuffle, TOPOLOGY_SHUFFLE_DURATION } from "./S5TopologyShuffle";
import { S7Command, COMMAND_DURATION } from "./S7Command";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const DEMO_CODEX_SHUFFLE_DURATION =
  HEADLINE_DURATION + TOPOLOGY_SHUFFLE_DURATION + COMMAND_DURATION + LOGO_DURATION;

export const DemoCodexShuffle: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_CODEX_SHUFFLE_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={HEADLINE_DURATION}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={TOPOLOGY_SHUFFLE_DURATION}><S5TopologyShuffle /></Series.Sequence>
        <Series.Sequence durationInFrames={COMMAND_DURATION}><S7Command /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
