// ExplainerFull — the full master, adding the cross-vendor beat (S4) after the
// three addressing modes. S1 -> S2 -> S3 -> S4 -> S5 -> S6. Ends on the logo.

import React from "react";
import { Series } from "../header/shared";
import { S1Problem, PROBLEM_DURATION } from "./S1Problem";
import { S2Shift, SHIFT_DURATION } from "./S2Shift";
import { S3Modes, MODES_DURATION } from "./S3Modes";
import { S4CrossVendor, CROSS_VENDOR_DURATION } from "./S4CrossVendor";
import { S5Topology, TOPOLOGY_DURATION } from "./S5Topology";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const EXPLAINER_FULL_DURATION =
  PROBLEM_DURATION + SHIFT_DURATION + MODES_DURATION +
  CROSS_VENDOR_DURATION + TOPOLOGY_DURATION + LOGO_DURATION;

export const ExplainerFull: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={PROBLEM_DURATION}><S1Problem /></Series.Sequence>
    <Series.Sequence durationInFrames={SHIFT_DURATION}><S2Shift /></Series.Sequence>
    <Series.Sequence durationInFrames={MODES_DURATION}><S3Modes /></Series.Sequence>
    <Series.Sequence durationInFrames={CROSS_VENDOR_DURATION}><S4CrossVendor /></Series.Sequence>
    <Series.Sequence durationInFrames={TOPOLOGY_DURATION}><S5Topology /></Series.Sequence>
    <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
  </Series>
);
