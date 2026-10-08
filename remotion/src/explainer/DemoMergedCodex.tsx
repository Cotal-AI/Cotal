// DemoMergedCodex — same as DemoMerged, but the vendor-topology beat uses four
// DISTINCT vendors (Claude Code · OpenCode · Hermes · Codex) instead of a
// duplicated Claude Code. Seamless loop.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline, HEADLINE_DURATION } from "./S0Headline";
import { S5TopologyVendorsCodex, TOPOLOGY_VENDORS_DURATION } from "./S5TopologyVendors";
import { S7Command, COMMAND_DURATION } from "./S7Command";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const DEMO_MERGED_CODEX_DURATION =
  HEADLINE_DURATION + TOPOLOGY_VENDORS_DURATION + COMMAND_DURATION + LOGO_DURATION;

export const DemoMergedCodex: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_MERGED_CODEX_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={HEADLINE_DURATION}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={TOPOLOGY_VENDORS_DURATION}><S5TopologyVendorsCodex /></Series.Sequence>
        <Series.Sequence durationInFrames={COMMAND_DURATION}><S7Command /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
