// DemoCodexRotate — same as DemoMergedCodex, but the vendor-topology beat uses
// the rotating-leader variant (S5TopologyRotate): a different vendor leads each
// topology (OpenCode -> Hermes -> Codex) so Claude Code is never always on top.
// Seamless loop.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline, HEADLINE_DURATION } from "./S0Headline";
import { S5TopologyRotate, TOPOLOGY_ROTATE_DURATION } from "./S5TopologyRotate";
import { S7Command, COMMAND_DURATION } from "./S7Command";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const DEMO_CODEX_ROTATE_DURATION =
  HEADLINE_DURATION + TOPOLOGY_ROTATE_DURATION + COMMAND_DURATION + LOGO_DURATION;

export const DemoCodexRotate: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_CODEX_ROTATE_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={HEADLINE_DURATION}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={TOPOLOGY_ROTATE_DURATION}><S5TopologyRotate /></Series.Sequence>
        <Series.Sequence durationInFrames={COMMAND_DURATION}><S7Command /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
