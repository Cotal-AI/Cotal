// S7Command — "one command to get started." A terminal window types the README
// quickstart `npx cotal-ai setup --full`, then a ✓ confirmation line settles.
// 135 frames @ 30fps.

import React from "react";
import {
  AbsoluteFill,
  CreamStage,
  GOLD,
  INK,
  Subtitle,
  fade,
  fontFamily,
  interpolate,
  loopEnvelope,
  useCurrentFrame,
} from "../header/shared";

const DURATION = 135;
const CMD = "npx cotal-ai setup --full";

export const S7Command: React.FC = () => {
  const frame = useCurrentFrame();

  // type the command in over frames 18..72, blinking block cursor
  const chars = Math.round(
    interpolate(frame, [18, 72], [0, CMD.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  );
  const typed = CMD.slice(0, chars);
  const typing = frame >= 18 && frame < 78;
  const cursorOn = typing ? Math.floor(frame / 8) % 2 === 0 : Math.floor(frame / 15) % 2 === 0;
  const resultOp = fade(frame, 84, 100);

  return (
    <CreamStage>
      <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION), justifyContent: "center", alignItems: "center" }}>
        <Subtitle place="top" text="One command to get started." />

        <div
          style={{
            width: 1000,
            borderRadius: 16,
            background: INK.fill,
            border: `1px solid ${INK.line}`,
            boxShadow: "0 10px 34px rgba(40,34,20,0.08)",
            padding: "26px 34px 30px",
            fontFamily,
          }}
        >
          {/* window chrome */}
          <div style={{ display: "flex", gap: 9, marginBottom: 26 }}>
            {[INK.ring, INK.ring, GOLD].map((c, i) => (
              <div key={i} style={{ width: 12, height: 12, borderRadius: "50%", background: c, opacity: 0.7 }} />
            ))}
          </div>

          {/* the command line */}
          <div style={{ fontSize: 36, color: INK.name, letterSpacing: 0.3, whiteSpace: "pre" }}>
            <span style={{ color: GOLD }}>$ </span>
            {typed}
            <span style={{ color: INK.name, opacity: cursorOn ? 1 : 0 }}>▌</span>
          </div>

          {/* the result line */}
          <div style={{ fontSize: 26, color: INK.text, letterSpacing: 0.3, marginTop: 22, opacity: resultOp }}>
            <span style={{ color: GOLD }}>✓</span> mesh up · dashboard · your agent connected
          </div>
        </div>
      </AbsoluteFill>
    </CreamStage>
  );
};
