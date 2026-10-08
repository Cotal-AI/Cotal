// DemoCommand — cross-vendor -> topology -> one-command -> logo.
// Seamless loop.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S4CrossVendor, CROSS_VENDOR_DURATION } from "./S4CrossVendor";
import { S5Topology, TOPOLOGY_DURATION } from "./S5Topology";
import { S7Command, COMMAND_DURATION } from "./S7Command";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const DEMO_COMMAND_DURATION =
  CROSS_VENDOR_DURATION + TOPOLOGY_DURATION + COMMAND_DURATION + LOGO_DURATION;

export const DemoCommand: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_COMMAND_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={CROSS_VENDOR_DURATION}><S4CrossVendor /></Series.Sequence>
        <Series.Sequence durationInFrames={TOPOLOGY_DURATION}><S5Topology /></Series.Sequence>
        <Series.Sequence durationInFrames={COMMAND_DURATION}><S7Command /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
