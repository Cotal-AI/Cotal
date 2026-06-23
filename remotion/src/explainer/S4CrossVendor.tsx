// S4CrossVendor — "Any agent. One space." Three different-vendor agents
// (Claude Code, OpenCode, Hermes) sit in ONE shared mesh and coordinate:
// gold beams travel around the triangle, each badge flashes as a beam lands,
// some flip to "working". 1920x1080, 30fps, exactly 150 frames, seamless loop.

import React from "react";
import {
  useCurrentFrame,
  AbsoluteFill,
  fontFamily,
  CreamStage,
  loopEnvelope,
  Subtitle,
  SharedSpace,
  AgentBadge,
  WireLines,
  BeamLine,
  Ripple,
  wirePath,
  bez,
  lerp,
  prog,
  fade,
  type Pt,
} from "../header/shared";

const DURATION = 150;

// Three vendors in a triangle inside the shared space. Center (960,540).
const CLAUDE: Pt = { x: 640, y: 520 };
const OPENCODE: Pt = { x: 960, y: 420 };
const HERMES: Pt = { x: 1280, y: 520 };

// Each leg is a gentle bezier so the mesh reads as coordination, not a hard
// wire diagram. ctrl() bows the curve outward from the triangle's centroid.
const CENTROID: Pt = {
  x: (CLAUDE.x + OPENCODE.x + HERMES.x) / 3,
  y: (CLAUDE.y + OPENCODE.y + HERMES.y) / 3,
};
const ctrl = (a: Pt, b: Pt): [Pt, Pt] => {
  const m = lerp(a, b, 0.5);
  const bow = { x: (m.x - CENTROID.x) * 0.22, y: (m.y - CENTROID.y) * 0.22 };
  return [
    { x: lerp(a, b, 0.32).x + bow.x, y: lerp(a, b, 0.32).y + bow.y },
    { x: lerp(a, b, 0.68).x + bow.x, y: lerp(a, b, 0.68).y + bow.y },
  ];
};

// Directed legs around the triangle (and back), so light keeps circulating.
const LEGS: { from: Pt; to: Pt; t0: number; t1: number }[] = [
  { from: CLAUDE, to: OPENCODE, t0: 22, t1: 52 }, // claude -> opencode
  { from: OPENCODE, to: HERMES, t0: 42, t1: 72 }, // opencode -> hermes
  { from: HERMES, to: CLAUDE, t0: 62, t1: 92 }, // hermes -> claude
  { from: HERMES, to: OPENCODE, t0: 84, t1: 112 }, // back: hermes -> opencode
  { from: OPENCODE, to: CLAUDE, t0: 96, t1: 124 }, // back: opencode -> claude
];

const LEG_CTRL = LEGS.map((l) => ctrl(l.from, l.to));
const LEG_PATHS = LEGS.map((l, i) => wirePath(l.from, ...LEG_CTRL[i]!, l.to));

// Resting mesh outline (the full triangle), shown faintly under the beams.
const MESH = [
  wirePath(CLAUDE, ...ctrl(CLAUDE, OPENCODE), OPENCODE),
  wirePath(OPENCODE, ...ctrl(OPENCODE, HERMES), HERMES),
  wirePath(HERMES, ...ctrl(HERMES, CLAUDE), CLAUDE),
];

// A badge flashes when a beam *arrives* at it: peak at the leg's t1, decay.
function arrivalFlash(frame: number, at: Pt): number {
  let f = 0;
  for (let i = 0; i < LEGS.length; i++) {
    const leg = LEGS[i]!;
    if (leg.to.x === at.x && leg.to.y === at.y) {
      // ramp up just before arrival, decay over ~18 frames
      const g =
        fade(frame, leg.t1 - 4, leg.t1) * (1 - fade(frame, leg.t1, leg.t1 + 18));
      f = Math.max(f, g);
    }
  }
  return f;
}

export const S4CrossVendor: React.FC = () => {
  const frame = useCurrentFrame();

  const beams = LEGS.map((l, i) => {
    const t = prog(frame, l.t0, l.t1);
    return {
      d: LEG_PATHS[i]!,
      pos: (tt: number) => bez(l.from, ...LEG_CTRL[i]!, l.to, tt),
      t,
      visible: t > 0 && t < 1,
    };
  });

  // Per-leg afterglow so each wire lingers gold right after its beam runs.
  const glow = LEGS.map((l) =>
    fade(frame, l.t1 - 6, l.t1) * (1 - fade(frame, l.t1 + 6, l.t1 + 26)),
  );
  // Collapse the 5 directed-leg glows onto the 3 mesh edges by max.
  const meshGlow = [
    Math.max(glow[0]!, glow[4]!), // claude<->opencode
    Math.max(glow[1]!, glow[3]!), // opencode<->hermes
    glow[2]!, // hermes<->claude
  ];

  const claudeFlash = arrivalFlash(frame, CLAUDE);
  const openFlash = arrivalFlash(frame, OPENCODE);
  const hermesFlash = arrivalFlash(frame, HERMES);

  // Some agents flip to "working" once coordination reaches them and stay so.
  const openWorking = frame >= LEGS[0]!.t1 - 2 ? "working" : "idle";
  const hermesWorking = frame >= LEGS[1]!.t1 - 2 ? "working" : "idle";
  const claudeWorking = frame >= LEGS[2]!.t1 - 2 ? "working" : "idle";

  // The mesh first lights when the first beam departs claude.
  const meshRipple = prog(frame, LEGS[0]!.t0 - 2, LEGS[0]!.t0 + 30);

  // Captions: crossfade between the two lines.
  const capA = fade(frame, 15, 28) * (1 - fade(frame, 66, 78));
  const capB = fade(frame, 80, 94) * (1 - fade(frame, 138, 145));

  return (
    <CreamStage>
      <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION), fontFamily }}>
        <SharedSpace x={430} y={300} w={1060} h={520} label="one mesh" />

        <WireLines paths={MESH} glow={meshGlow} />

        <Ripple at={OPENCODE} p={meshRipple} />
        <Ripple at={CENTROID} p={prog(frame, LEGS[0]!.t0 + 6, LEGS[0]!.t0 + 40)} />

        <AgentBadge
          at={CLAUDE}
          name="claude code"
          role="agent"
          logo="agents/claude-code.svg"
          status={claudeWorking}
          flash={claudeFlash}
          size={54}
        />
        <AgentBadge
          at={OPENCODE}
          name="opencode"
          role="agent"
          logo="agents/opencode.svg"
          status={openWorking}
          flash={openFlash}
          size={54}
        />
        <AgentBadge
          at={HERMES}
          name="hermes"
          role="agent"
          logo="agents/hermes.png"
          status={hermesWorking}
          flash={hermesFlash}
          size={54}
        />

        {beams.map((b, i) => (
          <BeamLine key={i} d={b.d} pos={b.pos} t={b.t} visible={b.visible} />
        ))}

        <Subtitle
          text="Any agent. One space."
          opacity={capA}
          place="bottom"
          offset={64}
          size={40}
        />
        <Subtitle
          text="Claude Code · OpenCode · Hermes — same mesh."
          opacity={capB}
          place="bottom"
          offset={64}
          size={40}
        />
      </AbsoluteFill>
    </CreamStage>
  );
};
