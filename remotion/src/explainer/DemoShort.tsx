// DemoShort — punchy X loop: headline -> cross-vendor -> logo.
// Seamless loop.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline, HEADLINE_DURATION } from "./S0Headline";
import { S4CrossVendor, CROSS_VENDOR_DURATION } from "./S4CrossVendor";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const DEMO_SHORT_DURATION = HEADLINE_DURATION + CROSS_VENDOR_DURATION + LOGO_DURATION;

export const DemoShort: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_SHORT_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={HEADLINE_DURATION}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={CROSS_VENDOR_DURATION}><S4CrossVendor /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
