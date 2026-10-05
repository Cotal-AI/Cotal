// Multicast: alice posts to #general; every subscriber receives it.
// Loops seamlessly at the length Root.tsx registers.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  bez,
  Card,
  ChannelPill,
  fade,
  Labels,
  lerp,
  prog,
  Ripple,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

// Centered on the stage: alice and the cluster equidistant from the card middle.
const ALICE: Pt = { x: 118, y: 300 };
const PILL: Pt = { x: 425, y: 300 };
const RECV: Pt[] = [
  { x: 726, y: 134 },
  { x: 726, y: 300 },
  { x: 726, y: 466 },
];
// Shared cast + presence, identical across all three cards: bob and dave busy,
// carol free. Only the message flow differs, so the three glance as one space.
const NAMES = [
  { name: "bob", role: "builder", status: "working" },
  { name: "carol", role: "reviewer", status: "idle" },
  { name: "dave", role: "builder", status: "working" },
] as const;

const IN_START: Pt = { x: ALICE.x + 52, y: ALICE.y };
const IN_END: Pt = { x: PILL.x - 100, y: PILL.y };
const OUT_START: Pt = { x: PILL.x + 100, y: PILL.y };
const outCtrl = (r: Pt): [Pt, Pt] => [
  { x: OUT_START.x + 80, y: OUT_START.y },
  { x: r.x - 115, y: r.y },
];
const OUT_END = (r: Pt): Pt => ({ x: r.x - 54, y: r.y });

const IN_PATH = wirePath(IN_START, lerp(IN_START, IN_END, 0.4), lerp(IN_START, IN_END, 0.6), IN_END);
const OUT_PATHS = RECV.map((r) => wirePath(OUT_START, ...outCtrl(r), OUT_END(r)));

const T = {
  sendStart: 18,
  sendEnd: 48,
  fanStart: 52,
  fanEnd: 92,
  flashEnd: 118,
};

export const ModeMulticast: React.FC = () => {
  const frame = useCurrentFrame();

  const tIn = prog(frame, T.sendStart, T.sendEnd);
  const tOut = prog(frame, T.fanStart, T.fanEnd);

  const pillGlow =
    fade(frame, T.sendEnd - 6, T.sendEnd + 4) * (1 - fade(frame, T.fanEnd, T.flashEnd));
  const flash =
    frame >= T.fanEnd ? Math.max(0, 1 - fade(frame, T.fanEnd, T.flashEnd)) : 0;
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;

  // wire afterglow: the in-wire stays gold from send until the fan completes;
  // each out-wire lingers gold as its receiver flashes, then fades to ink.
  const inGlow =
    fade(frame, T.sendEnd - 4, T.sendEnd) * (1 - fade(frame, T.fanStart + 6, T.fanEnd));

  return (
    <Card>
      <Wires paths={[IN_PATH, ...OUT_PATHS]} glow={[inGlow, flash, flash, flash]} />
      <Ripple at={PILL} p={prog(frame, T.fanStart - 2, T.fanStart + 30)} />
      <Ripple at={PILL} p={prog(frame, T.fanStart + 8, T.fanStart + 42)} />
      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      <ChannelPill at={PILL} label="#general" glow={pillGlow} />
      {NAMES.map((n, i) => (
        <AgentNode key={n.name} at={RECV[i]!} name={n.name} role={n.role} status={n.status} flash={flash} />
      ))}
      <Beam
        d={IN_PATH}
        pos={(t) => lerp(IN_START, IN_END, t)}
        t={tIn}
        visible={tIn > 0 && tIn < 1}
      />
      {RECV.map((r, i) => (
        <Beam
          key={i}
          d={OUT_PATHS[i]!}
          pos={(t) => bez(OUT_START, ...outCtrl(r), OUT_END(r), t)}
          t={tOut}
          visible={tOut > 0 && tOut < 1}
        />
      ))}
      <Labels
        mode="multicast"
        caption="broadcast to a channel"
        subject="cotal.demo.chat.general"
      />
    </Card>
  );
};
