// ExplainerCore — the clear-message master (no cross-vendor beat).
// S1 problem -> S2 shift -> S3 modes -> S5 topology -> S6 logo.
// Each snippet is a self-contained CreamStage scene with loopEnvelope edges, so
// back-to-back Series sequences cross-dissolve cleanly through the cream.
// Ends holding the logo.

import React from "react";
import { Series } from "../header/shared";
import { S1Problem, PROBLEM_DURATION } from "./S1Problem";
import { S2Shift, SHIFT_DURATION } from "./S2Shift";
import { S3Modes, MODES_DURATION } from "./S3Modes";
import { S5Topology, TOPOLOGY_DURATION } from "./S5Topology";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const EXPLAINER_CORE_DURATION =
  PROBLEM_DURATION + SHIFT_DURATION + MODES_DURATION + TOPOLOGY_DURATION + LOGO_DURATION;

export const ExplainerCore: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={PROBLEM_DURATION}><S1Problem /></Series.Sequence>
    <Series.Sequence durationInFrames={SHIFT_DURATION}><S2Shift /></Series.Sequence>
    <Series.Sequence durationInFrames={MODES_DURATION}><S3Modes /></Series.Sequence>
    <Series.Sequence durationInFrames={TOPOLOGY_DURATION}><S5Topology /></Series.Sequence>
    <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
  </Series>
);
