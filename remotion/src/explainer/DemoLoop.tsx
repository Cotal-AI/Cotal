// DemoLoop — the core combine: cross-vendor -> topology -> logo.
// Seamless loop (outer loopEnvelope, since S6Logo holds).

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S4CrossVendor, CROSS_VENDOR_DURATION } from "./S4CrossVendor";
import { S5Topology, TOPOLOGY_DURATION } from "./S5Topology";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const DEMO_LOOP_DURATION = CROSS_VENDOR_DURATION + TOPOLOGY_DURATION + LOGO_DURATION;

export const DemoLoop: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_LOOP_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={CROSS_VENDOR_DURATION}><S4CrossVendor /></Series.Sequence>
        <Series.Sequence durationInFrames={TOPOLOGY_DURATION}><S5Topology /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
