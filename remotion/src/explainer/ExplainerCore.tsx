// ExplainerCore — the clear-message master (no cross-vendor beat).
// S1 problem -> S2 shift -> S3 modes -> S5 topology -> S6 logo.
// Each snippet is a self-contained CreamStage scene with loopEnvelope edges, so
// back-to-back Series sequences cross-dissolve cleanly through the cream.
// 150 + 150 + 210 + 150 + 120 = 780 frames @ 30fps (26s). Ends holding the logo.

import React from "react";
import { Series } from "../header/shared";
import { S1Problem } from "./S1Problem";
import { S2Shift } from "./S2Shift";
import { S3Modes } from "./S3Modes";
import { S5Topology } from "./S5Topology";
import { S6Logo } from "./S6Logo";

export const ExplainerCore: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={150}><S1Problem /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S2Shift /></Series.Sequence>
    <Series.Sequence durationInFrames={210}><S3Modes /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S5Topology /></Series.Sequence>
    <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
  </Series>
);
