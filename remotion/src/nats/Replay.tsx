// Replay: one durable stream, a bookmark per reader. alice keeps posting; bob
// reads each message as it lands. dave goes offline after the first one, his
// bookmark stays put, and when he comes back he reads the rest from there.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  Card,
  fade,
  GOLD,
  INK,
  Labels,
  lerp,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "../modes/scene";

const ALICE: Pt = { x: 118, y: 310 };
const BOB: Pt = { x: 726, y: 160 };
const DAVE: Pt = { x: 726, y: 460 };

const SLOTS = 5;
const SLOT_X = (i: number) => 296 + 64 * i;
const TRACK = { x0: 252, x1: 596, y: 310 };
const START: Pt = { x: ALICE.x + 52, y: ALICE.y };

const readerPath = (r: Pt) =>
  wirePath({ x: TRACK.x1, y: TRACK.y }, { x: TRACK.x1 + 60, y: TRACK.y }, { x: r.x - 120, y: r.y }, { x: r.x - 52, y: r.y });
const PATH_BOB = readerPath(BOB);
const PATH_DAVE = readerPath(DAVE);

const PUBLISH = [10, 34, 58, 82, 106];
const LAND = 16; // frames from publish to the slot
const DAVE_OFF = 40;
const DAVE_BACK = 122;
const CATCH_UP = [134, 141, 148, 155]; // dave reads slots 1..4
const RESET = [164, 178];

// How far a reader has read: the index of the last slot it acked, -1 for none.
function bobAt(frame: number): number {
  return PUBLISH.filter((p) => frame >= p + LAND).length - 1;
}
function daveAt(frame: number): number {
  if (frame < PUBLISH[0]! + LAND) return -1;
  return CATCH_UP.filter((c) => frame >= c).length;
}
// 1 on each of the given frames, fading over the next 18
function pulse(frame: number, at: number[]): number {
  return Math.max(0, ...at.map((a) => (frame >= a ? 1 - fade(frame, a, a + 18) : 0)));
}

const Marker: React.FC<{ index: number; letter: string; above: boolean; opacity: number }> = ({
  index,
  letter,
  above,
  opacity,
}) => (
  <div
    style={{
      position: "absolute",
      left: (index < 0 ? TRACK.x0 + 8 : SLOT_X(index)) - 15,
      top: above ? TRACK.y - 76 : TRACK.y + 46,
      width: 30,
      height: 30,
      borderRadius: 9,
      border: `1.5px solid ${GOLD}`,
      background: INK.fill,
      color: GOLD,
      fontSize: 18,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      opacity,
    }}
  >
    {letter}
  </div>
);

export const NatsReplay: React.FC = () => {
  const frame = useCurrentFrame();

  const shown = fade(frame, 0, 8) * (1 - fade(frame, RESET[0]!, RESET[1]!));
  const bobReads = PUBLISH.map((p) => p + LAND);
  const daveReads = [PUBLISH[0]! + LAND, ...CATCH_UP];
  const bobFlash = pulse(frame, bobReads);
  const daveFlash = pulse(frame, daveReads);
  const emit = pulse(frame, PUBLISH);
  const offline = fade(frame, DAVE_OFF, DAVE_OFF + 8) * (1 - fade(frame, DAVE_BACK, DAVE_BACK + 8));

  return (
    <Card frame={frame}>
      <Wires paths={[PATH_BOB, PATH_DAVE]} glow={[bobFlash, daveFlash]} />

      {/* the durable stream: messages stay stored after anyone reads them */}
      <div
        style={{
          position: "absolute",
          left: TRACK.x0,
          top: TRACK.y - 30,
          width: TRACK.x1 - TRACK.x0,
          height: 60,
          borderRadius: 30,
          border: `1.5px solid ${INK.ring}`,
          background: INK.fill,
        }}
      />
      {Array.from({ length: SLOTS }, (_, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: SLOT_X(i) - 9,
            top: TRACK.y - 9,
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: `1.5px solid ${INK.line}`,
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              background: GOLD,
              opacity: frame >= PUBLISH[i]! + LAND ? shown : 0,
            }}
          />
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: TRACK.x0,
          top: TRACK.y + 92,
          width: TRACK.x1 - TRACK.x0,
          textAlign: "center",
          fontSize: 20,
          color: INK.dim,
          letterSpacing: 0.3,
        }}
      >
        stream
      </div>
      <Marker index={bobAt(frame)} letter="b" above opacity={shown} />
      <Marker index={daveAt(frame)} letter="d" above={false} opacity={shown} />

      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      <AgentNode at={BOB} name="bob" role="builder" status="working" flash={bobFlash} />
      <AgentNode
        at={DAVE}
        name="dave"
        role="builder"
        status={offline > 0.5 ? "idle" : "working"}
        flash={daveFlash}
        dimmed={offline}
      />
      <div
        style={{
          position: "absolute",
          left: DAVE.x - 80,
          top: DAVE.y + 92,
          width: 160,
          textAlign: "center",
          fontSize: 19,
          color: INK.dim,
          opacity: offline,
        }}
      >
        offline
      </div>

      {PUBLISH.map((p, i) => {
        const t = prog(frame, p, p + LAND);
        const end: Pt = { x: SLOT_X(i), y: TRACK.y };
        return (
          <Beam
            key={i}
            d={wirePath(START, lerp(START, end, 0.4), lerp(START, end, 0.6), end)}
            pos={(u) => lerp(START, end, u)}
            t={t}
            visible={t > 0 && t < 1}
          />
        );
      })}

      <Labels mode="replay" caption="each reader keeps its own bookmark" subject="cotal.demo.chat.u_….alice.general" />
    </Card>
  );
};
