// ExplainerMerged — the full explainer with every improvement folded in:
// problem -> shift -> 3 modes -> cross-vendor (names the agents) -> vendor-
// topology (the same vendors morph through every topology) -> one-command ->
// logo ("one protocol to coordinate them all"). Plays once and holds the logo.

import React from "react";
import { Series } from "../header/shared";
import { S1Problem, PROBLEM_DURATION } from "./S1Problem";
import { S2Shift, SHIFT_DURATION } from "./S2Shift";
import { S3Modes, MODES_DURATION } from "./S3Modes";
import { S4CrossVendor, CROSS_VENDOR_DURATION } from "./S4CrossVendor";
import { S5TopologyVendors, TOPOLOGY_VENDORS_DURATION } from "./S5TopologyVendors";
import { S7Command, COMMAND_DURATION } from "./S7Command";
import { S6Logo, LOGO_DURATION } from "./S6Logo";

export const EXPLAINER_MERGED_DURATION =
  PROBLEM_DURATION + SHIFT_DURATION + MODES_DURATION + CROSS_VENDOR_DURATION +
  TOPOLOGY_VENDORS_DURATION + COMMAND_DURATION + LOGO_DURATION;

export const ExplainerMerged: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={PROBLEM_DURATION}><S1Problem /></Series.Sequence>
    <Series.Sequence durationInFrames={SHIFT_DURATION}><S2Shift /></Series.Sequence>
    <Series.Sequence durationInFrames={MODES_DURATION}><S3Modes /></Series.Sequence>
    <Series.Sequence durationInFrames={CROSS_VENDOR_DURATION}><S4CrossVendor /></Series.Sequence>
    <Series.Sequence durationInFrames={TOPOLOGY_VENDORS_DURATION}><S5TopologyVendors /></Series.Sequence>
    <Series.Sequence durationInFrames={COMMAND_DURATION}><S7Command /></Series.Sequence>
    <Series.Sequence durationInFrames={LOGO_DURATION}><S6Logo /></Series.Sequence>
  </Series>
);
