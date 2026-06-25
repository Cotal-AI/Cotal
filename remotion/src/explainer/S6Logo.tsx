// S6Logo — the closing logo beat. The three gold Borromean rings draw on and
// interlock, then the "Cotal" wordmark, tagline and CTA settle and HOLD. This is
// the final, silent resolve of the explainer: it does NOT fade out — it lands on
// the finished brand lockup and stays. A soft gold ripple blooms from behind the
// rings as they lock, for a subtle premium flourish.
//
// 1920x1080 @ 30fps, 120 frames. Center (960, 540).
//
//   Fade-in   0-10    the whole lockup eases up from black-zero opacity.
//   Resolve   6-...   Logo draws the rings (interlock via internal RingMark
//                     appear), then lifts the wordmark/tagline/CTA in.
//   Flourish  18-50   a gentle gold Ripple blooms from behind the rings.
//   Hold      ...-120 the finished logo holds, untouched, to the last frame.

import React from "react";
import {
  AbsoluteFill,
  CreamStage,
  interpolate,
  Logo,
  prog,
  Ripple,
  useCurrentFrame,
} from "../header/shared";

export const S6Logo: React.FC = () => {
  const frame = useCurrentFrame();

  // Gentle fade-IN only at the very start; HOLD at the end (no loopEnvelope,
  // which would also fade the finished logo back out).
  const rootOpacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Soft gold ripple blooming from behind the rings as they lock + interlock.
  const ripple = prog(frame, 18, 50);

  return (
    <CreamStage>
      <AbsoluteFill style={{ opacity: rootOpacity }}>
        {/* flourish: behind the Logo, centered on the ring mark */}
        <Ripple at={{ x: 960, y: 470 }} p={ripple} />

        {/* the real brand lockup: interlocking rings + "Cotal" + tagline + CTA */}
        <Logo
          frame={frame}
          appear={6}
          tagline="one protocol to coordinate them all"
          cta="cotal.ai"
          size={104}
        />
      </AbsoluteFill>
    </CreamStage>
  );
};
