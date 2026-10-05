// Anycast: alice addresses the role "reviewer". The same cast is present; bob
// and dave are busy, carol is free, so carol claims the work. Exactly one
// instance picks it up. Loops seamlessly at the length Root.tsx registers.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  bez,
  Card,
  CARD_TYPE,
  Dot,
  fade,
  GOLD,
  INK,
  Labels,
  lerp,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

// Shared stage: alice left, the reviewer pool clustered right, junction center.
const ALICE: Pt = { x: 100, y: 410 };
const JUNCTION: Pt = { x: 400, y: 410 };
const GROUP: Pt[] = [
  { x: 700, y: 240 }, // bob, busy
  { x: 700, y: 410 }, // carol, free -> claims
  { x: 700, y: 580 }, // dave, busy
];
const MEMBERS = [
  { name: "bob", busy: true },
  { name: "carol", busy: false },
  { name: "dave", busy: true },
] as const;
const CLAIMER = 1;

const SEG1: [Pt, Pt] = [
  { x: ALICE.x + 52, y: ALICE.y },
  { x: JUNCTION.x - 10, y: JUNCTION.y },
];
// same fan geometry as multicast, so the two cards glance alike
const outCtrl = (r: Pt): [Pt, Pt] => [
  { x: JUNCTION.x + 60, y: JUNCTION.y },
  { x: r.x - 90, y: r.y },
];
const OUT_END = (r: Pt): Pt => ({ x: r.x - 54, y: r.y });

const PATH1 = wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]);
const OUT_PATHS = GROUP.map((r) => wirePath(JUNCTION, ...outCtrl(r), OUT_END(r)));

const T = {
  sendStart: 14,
  sendEnd: 48,
  probeEnd: 64,
  claimStart: 64,
  claimEnd: 90,
  flashEnd: 116,
  carolBack: 148,
};

export const ModeAnycast: React.FC = () => {
  const frame = useCurrentFrame();

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.claimStart, T.claimEnd);

  const probing = frame >= T.sendEnd && frame < T.probeEnd;
  const breath = probing ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 20) * Math.PI * 2) : 0;

  const flash = frame >= T.claimEnd ? Math.max(0, 1 - fade(frame, T.claimEnd, T.flashEnd)) : 0;
  const carolStatus: "idle" | "working" =
    frame >= T.claimEnd && frame < T.carolBack ? "working" : "idle";
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;
  const dimOthers = probing || (t2 > 0 && t2 < 1) || flash > 0 ? 0.5 : 0;

  const inGlow = fade(frame, T.sendEnd - 4, T.sendEnd) * (1 - fade(frame, T.claimStart, T.claimEnd));
  const claimGlow = flash;

  return (
    <Card>
      <Wires paths={[PATH1, ...OUT_PATHS]} glow={[inGlow, 0, claimGlow, 0]} />

      {/* the role: a quiet bracket around the pool, labelled on its top edge */}
      <div
        style={{
          position: "absolute",
          left: 590,
          top: 178,
          width: 220,
          height: 520,
          borderRadius: 26,
          border: `1px solid ${INK.line}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 590,
          top: 155,
          width: 220,
          textAlign: "center",
          fontSize: 18 * CARD_TYPE,
          letterSpacing: 1,
          color: GOLD,
        }}
      >
        <span style={{ background: INK.card, padding: "0 12px" }}>@reviewer</span>
      </div>

      <AgentNode at={ALICE} name="alice" status="working" flash={emit} type={CARD_TYPE} />
      {MEMBERS.map((m, i) => (
        <AgentNode
          key={m.name}
          at={GROUP[i]!}
          name={m.name}
          status={i === CLAIMER ? carolStatus : m.busy ? "working" : "idle"}
          flash={i === CLAIMER ? flash : 0}
          dimmed={i !== CLAIMER ? dimOthers : 0}
          type={CARD_TYPE}
        />
      ))}

      <Beam d={PATH1} pos={(t) => lerp(...SEG1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
      {probing && <Dot at={JUNCTION} breath={breath} />}
      <Beam
        d={OUT_PATHS[CLAIMER]!}
        pos={(t) => bez(JUNCTION, ...outCtrl(GROUP[CLAIMER]!), OUT_END(GROUP[CLAIMER]!), t)}
        t={t2}
        visible={t2 > 0 && t2 < 1}
      />

      <Labels
        mode="anycast"
        caption="any one of a role claims it"
        subject="cotal.demo.svc.reviewer"
        type={CARD_TYPE}
      />
    </Card>
  );
};
