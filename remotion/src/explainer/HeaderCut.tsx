// HeaderCut — a short, seamless loop cut from the explainer for the README
// header: the topology morph (S5) + the logo resolve (S6). The outer
// loopEnvelope fades the whole thing out->in at the boundary so the held logo
// loops cleanly back to the topology.

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S5Topology, TOPOLOGY_DURATION } from "./S5Topology";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const HEADER_CUT_DURATION = TOPOLOGY_DURATION + LOGO_DURATION;

export const HeaderCut: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, HEADER_CUT_DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={TOPOLOGY_DURATION}><S5Topology /></Series.Sequence>
        <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
