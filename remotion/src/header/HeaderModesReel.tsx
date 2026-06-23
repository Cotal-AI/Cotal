// HeaderModesReel — "Three ways to reach".
//
// The lowest-risk header variant: replay the three existing connection-type
// scenes (multicast -> unicast -> anycast) back-to-back inside a square frame,
// then resolve to the cotal wordmark. Each Mode card is authored for an 860x620
// stage and paints its own cream, so ScaleToFit drops it into the 1080x1080
// CreamStage with matching cream margins above and below.
//
// 150 + 168 + 162 + 75 = 555 frames @ 30fps.

import React from "react";
import { ModeMulticast } from "../modes/Multicast";
import { ModeUnicast } from "../modes/Unicast";
import { ModeAnycast } from "../modes/Anycast";
import {
  CreamStage,
  ScaleToFit,
  Series,
  Wordmark,
  loopEnvelope,
  useCurrentFrame,
} from "./shared";

const DURATION = 555;

// Closing beat: the wordmark animates from its own frame 0 because, inside a
// Series.Sequence, useCurrentFrame() is relative to that sequence's start.
const Outro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Wordmark
      frame={f}
      appear={6}
      tagline="the open standard for agent coordination"
      size={92}
    />
  );
};

export const HeaderModesReel: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <CreamStage>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: loopEnvelope(frame, DURATION, 12),
        }}
      >
        <Series>
          <Series.Sequence durationInFrames={150}>
            <ScaleToFit w={860} h={620}>
              <ModeMulticast />
            </ScaleToFit>
          </Series.Sequence>
          <Series.Sequence durationInFrames={168}>
            <ScaleToFit w={860} h={620}>
              <ModeUnicast />
            </ScaleToFit>
          </Series.Sequence>
          <Series.Sequence durationInFrames={162}>
            <ScaleToFit w={860} h={620}>
              <ModeAnycast />
            </ScaleToFit>
          </Series.Sequence>
          <Series.Sequence durationInFrames={75}>
            <Outro />
          </Series.Sequence>
        </Series>
      </div>
    </CreamStage>
  );
};
