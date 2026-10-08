// DemoReadme — the README header loop: just the message + the topology setups.
// headline ("Any agent / Any topology / One space") -> the rotating-leader
// vendor-topology. No command beat and no logo close — the README already shows
// the Cotal wordmark up top and has a Quickstart with the command, so both would
// be redundant. Seamless loop.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline, HEADLINE_DURATION } from "./S0Headline";
import { S5TopologyRotate, TOPOLOGY_ROTATE_DURATION } from "./S5TopologyRotate";

export const DEMO_README_DURATION = HEADLINE_DURATION + TOPOLOGY_ROTATE_DURATION;

export const DemoReadme: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DEMO_README_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={HEADLINE_DURATION}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={TOPOLOGY_ROTATE_DURATION}><S5TopologyRotate /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
