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
  NODE_R,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const JUNCTION: Pt = { x: 400, y: 410 };

// The role's bracket is measured from the first and last peer so it follows the
// pool when the cast moves; below the last peer it leaves room for its name.
const POOL_TOP = MODE_PEERS[0].at;
const POOL_BOTTOM = MODE_PEERS[MODE_PEERS.length - 1].at;
const BRACKET_TOP = POOL_TOP.y - NODE_R - 17;
const BRACKET = {
  left: POOL_TOP.x - NODE_R - 65,
  top: BRACKET_TOP,
  width: 2 * (NODE_R + 65),
  height: POOL_BOTTOM.y + NODE_R + 73 - BRACKET_TOP,
};

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
        paths={[PATH1, ...OUT_PATHS]}
        glow={[inGlow, ...OUT_PATHS.map((_, i) => (i === claimer ? claimGlow : 0))]}
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
