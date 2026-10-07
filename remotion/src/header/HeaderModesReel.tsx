// HeaderModesReel — "Three ways to reach".
//
// The lowest-risk header variant: replay the three existing connection-type
// scenes (multicast -> unicast -> anycast) back-to-back inside a square frame,
// then resolve to the cotal wordmark. Each Mode card is authored for an 860x620
// stage and paints its own cream, so ScaleToFit drops it into the 1080x1080
// CreamStage with matching cream margins above and below.

import React from "react";
import { ModeMulticast, MULTICAST_DURATION } from "../modes/Multicast";
import { ModeUnicast, UNICAST_DURATION } from "../modes/Unicast";
import { ModeAnycast, ANYCAST_DURATION } from "../modes/Anycast";
import {
  CreamStage,
  ScaleToFit,
  Series,
  Wordmark,
  loopEnvelope,
  useCurrentFrame,
} from "./shared";

const OUTRO_DURATION = 75;

export const REEL_DURATION =
  MULTICAST_DURATION + UNICAST_DURATION + ANYCAST_DURATION + OUTRO_DURATION;

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
          opacity: loopEnvelope(frame, REEL_DURATION, 12),
        }}
      >
        <Series>
          <Series.Sequence durationInFrames={MULTICAST_DURATION}>
            <ScaleToFit w={860} h={620}>
              <ModeMulticast />
            </ScaleToFit>
          </Series.Sequence>
          <Series.Sequence durationInFrames={UNICAST_DURATION}>
            <ScaleToFit w={860} h={620}>
              <ModeUnicast />
            </ScaleToFit>
          </Series.Sequence>
          <Series.Sequence durationInFrames={ANYCAST_DURATION}>
            <ScaleToFit w={860} h={620}>
              <ModeAnycast />
            </ScaleToFit>
          </Series.Sequence>
          <Series.Sequence durationInFrames={OUTRO_DURATION}>
            <Outro />
          </Series.Sequence>
        </Series>
      </div>
    </CreamStage>
  );
};
