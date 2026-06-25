// S1Problem — "The problem: agents stuck in a rigid tree".
//
// One beat of the silent, captioned Cotal explainer. An orchestrator at the top
// fans tasks DOWN to three sibling workers (a strict tree). Then worker-a tries
// to reach worker-b sideways — and the link is broken: a dashed brick-red line
// with an ✕ at its midpoint. The workers stay idle and siloed. The point: in a
// tree, peers can't talk to each other.
//
// 1920x1080, 30fps, 150 frames. Center (960,540). Cream/gold, plus ONE brick-red
// "blocked" cue. Reuses the comp-sized wire/beam primitives from header/shared.
//
// Beats (frames):
//   Fan-out  (12–60):  gold task beams orchestrator -> each worker, staggered.
//   Blocked  (70–110): worker-a -> worker-b sibling link draws, then breaks (✕).
//   Captions: "stuck in a tree" (10–70) crossfades to "can't talk" (78–end).

import React from "react";
import {
  AgentNode,
  BeamLine,
  ChannelPill,
  CreamStage,
  Field,
  INK,
  Subtitle,
  WireLines,
  bez,
  fade,
  lerp,
  loopEnvelope,
  prog,
  useCurrentFrame,
  wirePath,
  type Pt,
} from "../header/shared";

const DURATION = 150;

// The single allowed exception to the cream/gold palette: a muted brick-red,
// used ONLY for the "blocked" sibling link + its ✕.
const BLOCKED = "#c0584e";

// --- layout (comp coords, center 960,540) --------------------------------------

const ORCH: Pt = { x: 960, y: 200 }; // orchestrator pill, top-center
const WORKERS: { at: Pt; name: string; role: string }[] = [
  { at: { x: 520, y: 560 }, name: "worker-a", role: "coder" },
  { at: { x: 960, y: 560 }, name: "worker-b", role: "coder" },
  { at: { x: 1360, y: 560 }, name: "worker-c", role: "coder" },
];

const NODE_R = 45;
const PILL_HALF_H = 31; // ChannelPill is 184x62, centered on `at`

// Tree wire: from the orchestrator pill's bottom edge down to a worker's top
// edge. Gentle S-curve so the fan reads as a tidy hierarchy.
const wireStart: Pt = { x: ORCH.x, y: ORCH.y + PILL_HALF_H };
const wireEnd = (w: Pt): Pt => ({ x: w.x, y: w.y - NODE_R });
const wireCtrls = (w: Pt): [Pt, Pt] => {
  const e = wireEnd(w);
  return [
    { x: wireStart.x, y: lerp(wireStart, e, 0.45).y },
    { x: e.x, y: lerp(wireStart, e, 0.55).y },
  ];
};

const TREE_PATHS = WORKERS.map((w) => wirePath(wireStart, ...wireCtrls(w.at), wireEnd(w.at)));

// The blocked sibling link sits between worker-a and worker-b, at node height.
const A = WORKERS[0]!.at;
const B = WORKERS[1]!.at;
const LINK_START: Pt = { x: A.x + NODE_R, y: A.y };
const LINK_END: Pt = { x: B.x - NODE_R, y: B.y };
const LINK_MID: Pt = lerp(LINK_START, LINK_END, 0.5);

// --- timing --------------------------------------------------------------------

const T = {
  // staggered task beams, one per worker
  fanStart: [12, 24, 36],
  fanLen: 24,
  // blocked sibling link
  linkDraw: [70, 90] as const, // dashed line reveals
  linkBreak: [96, 108] as const, // ✕ appears + line "snaps"
};

export const S1Problem: React.FC = () => {
  const frame = useCurrentFrame();

  // Per-wire task beam progress + a lingering gold afterglow on each tree wire.
  const beamT = T.fanStart.map((s) => prog(frame, s, s + T.fanLen));
  const treeGlow = T.fanStart.map((s) =>
    fade(frame, s + T.fanLen - 6, s + T.fanLen) * (1 - fade(frame, s + T.fanLen + 24, s + T.fanLen + 48)),
  );

  // A brief receive-flash on each worker as its task lands.
  const flash = T.fanStart.map((s) => {
    const land = s + T.fanLen;
    return frame >= land ? Math.max(0, 1 - fade(frame, land, land + 14)) : 0;
  });

  // Orchestrator emits while any beam is in flight.
  const orchGlow = Math.max(
    ...T.fanStart.map((s) => fade(frame, s, s + 6) * (1 - fade(frame, s + T.fanLen - 4, s + T.fanLen + 8))),
  );

  // Blocked link: dashed line reveals, then "snaps" + an ✕ blinks in.
  const linkReveal = prog(frame, T.linkDraw[0], T.linkDraw[1]);
  const broken = prog(frame, T.linkBreak[0], T.linkBreak[1]);
  const xPop = prog(frame, T.linkBreak[0], T.linkBreak[1] + 4);
  // line opacity dips slightly as it breaks (reads as a failed connection)
  const linkOpacity = linkReveal * (1 - 0.35 * broken);

  // Snap: split the dashed line into two stubs that recoil from the midpoint.
  const recoil = 26 * broken;
  const leftEnd: Pt = { x: LINK_MID.x - recoil, y: LINK_MID.y };
  const rightStart: Pt = { x: LINK_MID.x + recoil, y: LINK_MID.y };

  // Caption crossfade.
  const capTreeOp = fade(frame, 10, 24) * (1 - fade(frame, 64, 78));
  const capTalkOp = fade(frame, 78, 92);

  return (
    <CreamStage>
      <div style={{ opacity: loopEnvelope(frame, DURATION) }}>
        {/* tree wires from orchestrator down to each worker, with task afterglow */}
        <WireLines paths={TREE_PATHS} glow={treeGlow} />

        {/* the broken sibling link: dashed brick-red, snapping with an ✕ */}
        <Field>
          {broken < 0.02 ? (
            <line
              x1={LINK_START.x}
              y1={LINK_START.y}
              x2={LINK_END.x}
              y2={LINK_END.y}
              stroke={BLOCKED}
              strokeWidth={2.5}
              strokeDasharray="9 9"
              strokeOpacity={linkOpacity}
              strokeLinecap="round"
            />
          ) : (
            <>
              <line
                x1={LINK_START.x}
                y1={LINK_START.y}
                x2={leftEnd.x}
                y2={leftEnd.y}
                stroke={BLOCKED}
                strokeWidth={2.5}
                strokeDasharray="9 9"
                strokeOpacity={linkOpacity}
                strokeLinecap="round"
              />
              <line
                x1={rightStart.x}
                y1={rightStart.y}
                x2={LINK_END.x}
                y2={LINK_END.y}
                stroke={BLOCKED}
                strokeWidth={2.5}
                strokeDasharray="9 9"
                strokeOpacity={linkOpacity}
                strokeLinecap="round"
              />
            </>
          )}
          {/* ✕ at the midpoint — the "blocked" mark */}
          {xPop > 0.01 ? (
            <g
              opacity={Math.min(1, xPop)}
              transform={`translate(${LINK_MID.x} ${LINK_MID.y}) scale(${0.6 + 0.4 * Math.min(1, xPop)})`}
            >
              <circle r={17} fill={INK.bg} stroke={BLOCKED} strokeWidth={2.5} />
              <line x1={-7} y1={-7} x2={7} y2={7} stroke={BLOCKED} strokeWidth={3} strokeLinecap="round" />
              <line x1={7} y1={-7} x2={-7} y2={7} stroke={BLOCKED} strokeWidth={3} strokeLinecap="round" />
            </g>
          ) : null}
        </Field>

        {/* orchestrator + the three idle, siloed workers */}
        <ChannelPill at={ORCH} label="orchestrator" glow={orchGlow} />
        {WORKERS.map((w, i) => (
          <AgentNode
            key={w.name}
            at={w.at}
            name={w.name}
            role={w.role}
            status="idle"
            flash={flash[i]}
          />
        ))}

        {/* staggered gold task beams flowing DOWN the tree */}
        {WORKERS.map((w, i) => (
          <BeamLine
            key={w.name}
            d={TREE_PATHS[i]!}
            pos={(t) => bez(wireStart, ...wireCtrls(w.at), wireEnd(w.at), t)}
            t={beamT[i]!}
            visible={beamT[i]! > 0 && beamT[i]! < 1}
          />
        ))}

        {/* captions: crossfade the problem statement into the punchline */}
        <Subtitle text="Your agents are stuck in a tree." opacity={capTreeOp} size={40} />
        <Subtitle text="Workers can't talk to each other." opacity={capTalkOp} size={40} />
      </div>
    </CreamStage>
  );
};
