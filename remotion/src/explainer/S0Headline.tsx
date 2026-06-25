// S0Headline — the lead title card for the demo cuts.
// The gold interlocking-rings mark settles, then three staccato lines reveal:
// "Any agent." -> "Any topology." -> "One space." 110 frames @ 30fps.

import React from "react";
import {
  AbsoluteFill,
  CreamStage,
  Easing,
  GOLD,
  INK,
  RingMark,
  fade,
  fontFamily,
  interpolate,
  loopEnvelope,
  useCurrentFrame,
} from "../header/shared";

const DURATION = 110;
const LINES = ["Any agent", "Any topology", "One space"];

export const S0Headline: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <CreamStage>
      <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION), justifyContent: "center", alignItems: "center" }}>
        <div style={{ marginBottom: 54 }}>
          <RingMark size={132} frame={frame} appear={0} id="headline" />
        </div>
        <div style={{ textAlign: "center" }}>
          {LINES.map((line, i) => {
            const start = 20 + i * 13;
            const op = fade(frame, start, start + 12);
            const dy = interpolate(frame, [start, start + 16], [16, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.out(Easing.cubic),
            });
            // the final line lands in gold for a touch of emphasis
            const color = i === LINES.length - 1 ? GOLD : INK.name;
            return (
              <div
                key={i}
                style={{
                  fontFamily,
                  fontSize: 78,
                  color,
                  opacity: op,
                  transform: `translateY(${dy}px)`,
                  lineHeight: 1.22,
                  letterSpacing: 1,
                }}
              >
                {line}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </CreamStage>
  );
};
