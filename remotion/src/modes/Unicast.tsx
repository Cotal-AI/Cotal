// Unicast: alice addresses bob directly. The same cast is present (carol free,
// dave busy); bob is busy, so the message parks durably in his inbox and
// delivers the moment he frees up. Unicast is point-to-point, so there is no
// shared hub at center: the inbox lives on the direct route to bob, its owner.
// 210 frames @ 30fps = 7s seamless loop.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  Card,
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

// Same cluster as the other cards; bob (top) is the addressee, carol/dave below
// are present but unaddressed. The inbox sits on the alice -> bob route.
const ALICE: Pt = { x: 118, y: 300 };
const BOB: Pt = { x: 726, y: 134 };
const CAROL: Pt = { x: 726, y: 300 };
const DAVE: Pt = { x: 726, y: 466 };
const INBOX: Pt = { x: 442, y: 220 };

const SEG1: [Pt, Pt] = [
  { x: ALICE.x + 50, y: ALICE.y - 13 },
  { x: INBOX.x - 38, y: INBOX.y + 9 },
];
const SEG2: [Pt, Pt] = [
  { x: INBOX.x + 38, y: INBOX.y - 9 },
  { x: BOB.x - 48, y: BOB.y + 12 },
];

const PATH1 = wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]);
const PATH2 = wirePath(SEG2[0], lerp(...SEG2, 0.4), lerp(...SEG2, 0.6), SEG2[1]);

const T = {
  sendStart: 14,
  sendEnd: 48,
  bobFrees: 78,
  deliverStart: 86,
  deliverEnd: 116,
  flashEnd: 140,
  bobBack: 152,
};

export const ModeUnicast: React.FC = () => {
  const frame = useCurrentFrame();

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.deliverStart, T.deliverEnd);

  const parked = frame >= T.sendEnd && frame < T.deliverStart;
  const breath = parked ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 26) * Math.PI * 2) : 0;

  const bobStatus: "idle" | "working" =
    frame < T.bobFrees ? "working" : frame < T.bobBack ? "idle" : "working";
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;
  const deliverFlash =
    frame >= T.deliverEnd ? Math.max(0, 1 - fade(frame, T.deliverEnd, T.flashEnd)) : 0;
  // a quiet ripple of life when bob frees up, so the state change registers
  const freeFlash =
    frame >= T.bobFrees ? 0.4 * Math.max(0, 1 - fade(frame, T.bobFrees, T.bobFrees + 16)) : 0;

  // wire afterglow: seg1 gold while it holds, seg2 gold as it delivers
  const glow1 = fade(frame, T.sendEnd - 4, T.sendEnd) * (1 - fade(frame, T.deliverStart, T.deliverEnd));
  const glow2 = deliverFlash;

  return (
    <Card>
      <Wires paths={[PATH1, PATH2]} glow={[glow1, glow2]} />

      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      <AgentNode at={BOB} name="bob" role="builder" status={bobStatus} flash={Math.max(deliverFlash, freeFlash)} />
      <AgentNode at={CAROL} name="carol" role="reviewer" status="idle" />
      <AgentNode at={DAVE} name="dave" role="builder" status="working" />

      {/* durable inbox: a rounded slot matching the node language; gold while it holds */}
      <div
        style={{
          position: "absolute",
          left: INBOX.x - 36,
          top: INBOX.y - 36,
          width: 72,
          height: 72,
          borderRadius: 20,
          border: `1.5px solid ${parked ? GOLD : INK.ring}`,
          background: INK.fill,
          boxShadow: parked
            ? `0 0 18px 1px rgba(199,154,74,${0.12 + 0.1 * breath})`
            : "0 1px 2px rgba(40,34,20,0.05)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: INBOX.x - 70,
          top: INBOX.y + 48,
          width: 140,
          textAlign: "center",
          fontSize: 20,
          color: INK.dim,
          letterSpacing: 0.3,
        }}
      >
        inbox
      </div>

      {parked ? (
        <Dot at={INBOX} breath={breath} />
      ) : (
        <>
          <Beam d={PATH1} pos={(t) => lerp(...SEG1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
          <Beam d={PATH2} pos={(t) => lerp(...SEG2, t)} t={t2} visible={t2 > 0 && t2 < 1} />
        </>
      )}

      <Labels mode="unicast" caption="deliver to one, durably" subject="cotal.demo.inst.bob" />
    </Card>
  );
};
