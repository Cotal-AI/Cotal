// DemoLoop — the core combine: cross-vendor -> topology -> logo.
// Seamless loop (outer loopEnvelope, since S6Logo holds). 150+150+120 = 420f / 14s.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S4CrossVendor } from "./S4CrossVendor";
import { S5Topology } from "./S5Topology";
import { S6Logo } from "./S6Logo";

const DURATION = 420;

export const DemoLoop: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={150}><S4CrossVendor /></Series.Sequence>
        <Series.Sequence durationInFrames={150}><S5Topology /></Series.Sequence>
        <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
