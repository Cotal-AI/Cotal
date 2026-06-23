// DemoCommand — cross-vendor -> topology -> one-command -> logo.
// Seamless loop. 150+150+135+120 = 555f / 18.5s.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S4CrossVendor } from "./S4CrossVendor";
import { S5Topology } from "./S5Topology";
import { S7Command } from "./S7Command";
import { S6Logo } from "./S6Logo";

const DURATION = 555;

export const DemoCommand: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={150}><S4CrossVendor /></Series.Sequence>
        <Series.Sequence durationInFrames={150}><S5Topology /></Series.Sequence>
        <Series.Sequence durationInFrames={135}><S7Command /></Series.Sequence>
        <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
