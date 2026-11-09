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
  MODE_MIDDLE,
  MODE_PEERS,
  NODE_R,
  prog,
  straightWire,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const JUNCTION = MODE_MIDDLE;

// The role's bracket follows the pool's extreme coordinates, not the cast's
// array order. Claimant selection still walks MODE_PEERS in order. Below the
// lowest peer the bracket leaves room for its name.
const POOL_TOP_Y = Math.min(...MODE_PEERS.map((p) => p.at.y));
const POOL_BOTTOM_Y = Math.max(...MODE_PEERS.map((p) => p.at.y));
const POOL_LEFT_X = Math.min(...MODE_PEERS.map((p) => p.at.x));
const POOL_RIGHT_X = Math.max(...MODE_PEERS.map((p) => p.at.x));
const BRACKET_TOP = POOL_TOP_Y - NODE_R - 17;
const BRACKET_LEFT = POOL_LEFT_X - NODE_R - 65;
const BRACKET = {
  left: BRACKET_LEFT,
  top: BRACKET_TOP,
  width: POOL_RIGHT_X + NODE_R + 65 - BRACKET_LEFT,
  height: POOL_BOTTOM_Y + NODE_R + 73 - BRACKET_TOP,
};

const SEG1: [Pt, Pt] = [
  { x: MODE_ALICE.at.x + 52, y: MODE_ALICE.at.y },
  { x: JUNCTION.x - 10, y: JUNCTION.y },
];
const FAN = MODE_PEERS.map((p) => fanWire(JUNCTION, p.at));

const PATH1 = straightWire(...SEG1);
const OUT_PATHS = FAN.map((w) => wirePath(...w));

const T = {
  sendStart: 14,
  sendEnd: 48,
  probeEnd: 64,
  claimStart: 64,
  claimEnd: 90,
  flashEnd: 116,
  claimerBack: 148,
};

export const ANYCAST_DURATION = 162;

export const ModeAnycast: React.FC = () => {
  const frame = useCurrentFrame();
  // the peers are the reviewer pool; the first idle one claims, so the shared
  // presence decides who. Checked here, not at import: Root imports every card,
  // so a module-scope throw would also refuse the cards that need no idle peer.
  const claimer = MODE_PEERS.findIndex((p) => p.status === "idle");
  if (claimer < 0) throw new Error("anycast: no idle peer in MODE_PEERS to claim");

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.claimStart, T.claimEnd);

  const probing = frame >= T.sendEnd && frame < T.probeEnd;
  const breath = probing ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 20) * Math.PI * 2) : 0;

  const flash = frame >= T.claimEnd ? Math.max(0, 1 - fade(frame, T.claimEnd, T.flashEnd)) : 0;
  const claimerStatus: "idle" | "working" =
    frame >= T.claimEnd && frame < T.claimerBack ? "working" : "idle";
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;
  const dimOthers = probing || (t2 > 0 && t2 < 1) || flash > 0 ? 0.5 : 0;

  const inGlow = fade(frame, T.sendEnd - 4, T.sendEnd) * (1 - fade(frame, T.claimStart, T.claimEnd));
  const claimGlow = flash;

  return (
    <Card>
      <Wires
        wires={[{ d: PATH1, glow: inGlow }, ...OUT_PATHS.map((d, i) => ({ d, glow: i === claimer ? claimGlow : 0 }))]}
      />

      {/* the role: a quiet bracket around the pool, labelled on its top edge */}
      <div
        style={{
          position: "absolute",
          ...BRACKET,
          borderRadius: 26,
          border: `1px solid ${INK.line}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: BRACKET.left,
          top: BRACKET.top - 23,
          width: BRACKET.width,
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
          status={i === claimer ? claimerStatus : p.status}
          flash={i === claimer ? flash : 0}
          dimmed={i !== claimer ? dimOthers : 0}
          type={CARD_TYPE}
        />
      ))}

      <Beam d={PATH1} pos={(t) => lerp(...SEG1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
      {probing && <Dot at={JUNCTION} breath={breath} />}
      <Beam
        d={OUT_PATHS[claimer]!}
        pos={(t) => bez(...FAN[claimer]!, t)}
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
