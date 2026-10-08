// Multicast: alice posts to #general; every subscriber receives it.
// Loops seamlessly at MULTICAST_DURATION.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  bez,
  Card,
  CARD_TYPE,
  ChannelPill,
  fade,
  fanWire,
  Labels,
  lerp,
  MODE_ALICE,
  MODE_PEERS,
  prog,
  Ripple,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const PILL: Pt = { x: 400, y: 410 };

// The pill's label takes the smallest card text size, which leaves the wires
// on either side room to read.
const PILL_TYPE = (18 * CARD_TYPE) / 24;
const PILL_HALF = 92 * PILL_TYPE + 8;

const IN_START: Pt = { x: MODE_ALICE.at.x + 52, y: MODE_ALICE.at.y };
const IN_END: Pt = { x: PILL.x - PILL_HALF, y: PILL.y };
const OUT_START: Pt = { x: PILL.x + PILL_HALF, y: PILL.y };
const FAN = MODE_PEERS.map((p) => fanWire(OUT_START, p.at));

const IN_PATH = wirePath(IN_START, lerp(IN_START, IN_END, 0.4), lerp(IN_START, IN_END, 0.6), IN_END);
const OUT_PATHS = FAN.map((w) => wirePath(...w));

const T = {
  sendStart: 18,
  sendEnd: 48,
  fanStart: 52,
  fanEnd: 92,
  flashEnd: 118,
};

export const MULTICAST_DURATION = 150;

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
      <AgentNode {...MODE_ALICE} flash={emit} type={CARD_TYPE} />
      <ChannelPill at={PILL} label="#general" glow={pillGlow} type={PILL_TYPE} />
      {MODE_PEERS.map((p) => (
        <AgentNode key={p.name} {...p} flash={flash} type={CARD_TYPE} />
      ))}
      <Beam
        d={IN_PATH}
        pos={(t) => lerp(IN_START, IN_END, t)}
        t={tIn}
        visible={tIn > 0 && tIn < 1}
      />
      {FAN.map((w, i) => (
        <Beam
          key={i}
          d={OUT_PATHS[i]!}
          pos={(t) => bez(...w, t)}
          t={tOut}
          visible={tOut > 0 && tOut < 1}
        />
      ))}
      <Labels
        mode="multicast"
        caption="broadcast to a channel"
        subject="cotal.demo.chat.general"
        type={CARD_TYPE}
      />
    </Card>
  );
};
