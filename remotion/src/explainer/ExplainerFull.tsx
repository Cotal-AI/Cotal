// ExplainerFull — the full master, adding the cross-vendor beat (S4) after the
// three addressing modes. S1 -> S2 -> S3 -> S4 -> S5 -> S6.
// 150 + 150 + 210 + 150 + 150 + 120 = 930 frames @ 30fps (31s). Ends on the logo.

import React from "react";
import { Series } from "../header/shared";
import { S1Problem } from "./S1Problem";
import { S2Shift } from "./S2Shift";
import { S3Modes } from "./S3Modes";
import { S4CrossVendor } from "./S4CrossVendor";
import { S5Topology } from "./S5Topology";
import { S6Logo } from "./S6Logo";

export const ExplainerFull: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={150}><S1Problem /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S2Shift /></Series.Sequence>
    <Series.Sequence durationInFrames={210}><S3Modes /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S4CrossVendor /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S5Topology /></Series.Sequence>
    <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
  </Series>
);
