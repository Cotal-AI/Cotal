// DemoShort — punchy X loop: headline -> cross-vendor -> logo.
// Seamless loop. 110+150+120 = 380f / 12.7s.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline } from "./S0Headline";
import { S4CrossVendor } from "./S4CrossVendor";
import { S6Logo } from "./S6Logo";

const DURATION = 380;

export const DemoShort: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={110}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={150}><S4CrossVendor /></Series.Sequence>
        <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
