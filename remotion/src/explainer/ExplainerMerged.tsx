// ExplainerMerged — the full explainer with every improvement folded in:
// problem -> shift -> 3 modes -> cross-vendor (names the agents) -> vendor-
// topology (the same vendors morph through every topology) -> one-command ->
// logo ("one protocol to coordinate them all"). Plays once and holds the logo.
// 150+150+210+150+240+135+120 = 1155f / 38.5s @ 30fps.

import React from "react";
import { Series } from "../header/shared";
import { S1Problem } from "./S1Problem";
import { S2Shift } from "./S2Shift";
import { S3Modes } from "./S3Modes";
import { S4CrossVendor } from "./S4CrossVendor";
import { S5TopologyVendors } from "./S5TopologyVendors";
import { S7Command } from "./S7Command";
import { S6Logo } from "./S6Logo";

export const ExplainerMerged: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={150}><S1Problem /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S2Shift /></Series.Sequence>
    <Series.Sequence durationInFrames={210}><S3Modes /></Series.Sequence>
    <Series.Sequence durationInFrames={150}><S4CrossVendor /></Series.Sequence>
    <Series.Sequence durationInFrames={240}><S5TopologyVendors /></Series.Sequence>
    <Series.Sequence durationInFrames={135}><S7Command /></Series.Sequence>
    <Series.Sequence durationInFrames={120}><S6Logo /></Series.Sequence>
  </Series>
);
