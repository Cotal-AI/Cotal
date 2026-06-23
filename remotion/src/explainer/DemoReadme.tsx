// DemoReadme — the README header loop: just the message + the topology setups.
// headline ("Any agent / Any topology / One space") -> the rotating-leader
// vendor-topology. No command beat and no logo close — the README already shows
// the Cotal wordmark up top and has a Quickstart with the command, so both would
// be redundant. Seamless loop. 110 + 240 = 350f / ~11.7s.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S0Headline } from "./S0Headline";
import { S5TopologyRotate } from "./S5TopologyRotate";

const DURATION = 350;

export const DemoReadme: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={110}><S0Headline /></Series.Sequence>
        <Series.Sequence durationInFrames={240}><S5TopologyRotate /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
