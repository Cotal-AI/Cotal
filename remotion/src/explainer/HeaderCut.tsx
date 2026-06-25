// HeaderCut — a short, seamless loop cut from the explainer for the README
// header: the topology morph (S5) + the logo resolve (S6). The outer
// loopEnvelope fades the whole thing out->in at the boundary so the held logo
// loops cleanly back to the topology. 150 + 120 = 270 frames @ 30fps (9s).

import React from "react";
import { AbsoluteFill, Series, loopEnvelope, useCurrentFrame } from "../header/shared";
import { S5Topology } from "./S5Topology";
import { S6Logo } from "./S6Logo";

const DURATION = 270;

export const HeaderCut: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      <Series>
        <Series.Sequence durationInFrames={150}><S5Topology /></Series.Sequence>
        <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
