// Anycast: alice addresses the role "reviewer". The same cast is present; bob
// and dave are busy, carol is free, so carol claims the work. Exactly one
// instance picks it up. Loops seamlessly at ANYCAST_DURATION.

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
  fanWire,
  GOLD,
  INK,
  Labels,
  lerp,
  MODE_ALICE,
  MODE_PEERS,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const JUNCTION: Pt = { x: 400, y: 410 };
// the peers are the reviewer pool; carol, the free one, claims
const CLAIMER = 1;

const SEG1: [Pt, Pt] = [
  { x: MODE_ALICE.at.x + 52, y: MODE_ALICE.at.y },
  { x: JUNCTION.x - 10, y: JUNCTION.y },
];
const FAN = MODE_PEERS.map((p) => fanWire(JUNCTION, p.at));

const PATH1 = wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]);
const OUT_PATHS = FAN.map((w) => wirePath(...w));

const T = {
  sendStart: 14,
  sendEnd: 48,
  probeEnd: 64,
  claimStart: 64,
  claimEnd: 90,
  flashEnd: 116,
  carolBack: 148,
};

export const ANYCAST_DURATION = 162;

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

      <AgentNode {...MODE_ALICE} flash={emit} type={CARD_TYPE} />
      {MODE_PEERS.map((p, i) => (
        <AgentNode
          key={p.name}
          {...p}
          status={i === CLAIMER ? carolStatus : p.status}
          flash={i === CLAIMER ? flash : 0}
          dimmed={i !== CLAIMER ? dimOthers : 0}
          type={CARD_TYPE}
        />
      ))}

      <Beam d={PATH1} pos={(t) => lerp(...SEG1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
      {probing && <Dot at={JUNCTION} breath={breath} />}
      <Beam
        d={OUT_PATHS[CLAIMER]!}
        pos={(t) => bez(...FAN[CLAIMER]!, t)}
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
