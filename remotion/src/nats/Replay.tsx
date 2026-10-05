// Replay: one durable stream, a bookmark per reader. alice keeps posting; bob
// reads each message as it lands. dave goes offline after the first one, its
// bookmark stays put, and when it comes back it reads the rest from there.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  Card,
  CARD_TYPE,
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

const ALICE: Pt = { x: 130, y: 340 };
const BOB: Pt = { x: 690, y: 215 };
const DAVE: Pt = { x: 690, y: 470 };

const SLOTS = 5;
const SLOT_X = (i: number) => 266 + 56 * i;
const TRACK = { x0: 230, x1: 520, y: 340 };
const START: Pt = { x: ALICE.x + 52, y: ALICE.y };
const MARKER = 44;

const readerPath = (r: Pt) =>
  wirePath({ x: TRACK.x1, y: TRACK.y }, { x: TRACK.x1 + 60, y: TRACK.y }, { x: r.x - 112, y: r.y }, { x: r.x - 52, y: r.y });
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
      left: (index < 0 ? TRACK.x0 + 8 : SLOT_X(index)) - MARKER / 2,
      top: above ? TRACK.y - 40 - MARKER : TRACK.y + 40,
      width: MARKER,
      height: MARKER,
      borderRadius: 12,
      border: `1.5px solid ${GOLD}`,
      background: INK.fill,
      color: GOLD,
      fontSize: 18 * CARD_TYPE,
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
    <Card>
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
          fontSize: 20 * CARD_TYPE,
          color: INK.dim,
          letterSpacing: 0.3 * CARD_TYPE,
        }}
      >
        stream
      </div>
      <Marker index={bobAt(frame)} letter="b" above opacity={shown} />
      <Marker index={daveAt(frame)} letter="d" above={false} opacity={shown} />

      <AgentNode at={ALICE} name="alice" status="working" flash={emit} type={CARD_TYPE} />
      <AgentNode at={BOB} name="bob" status="working" flash={bobFlash} type={CARD_TYPE} />
      <AgentNode
        at={DAVE}
        name="dave"
        status={offline > 0.5 ? "idle" : "working"}
        flash={daveFlash}
        dimmed={offline}
        type={CARD_TYPE}
      />
      <div
        style={{
          position: "absolute",
          left: DAVE.x - 200,
          top: DAVE.y - 101,
          width: 400,
          textAlign: "center",
          fontSize: 19 * CARD_TYPE,
          color: INK.dim,
          // img2webp -lossy keeps the faint last steps of a text fade, so the word switches
          opacity: offline > 0.5 ? 1 : 0,
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

      <Labels
        mode="replay"
        caption="each reader keeps its own bookmark"
        subject="cotal.demo.chat.u_….alice.general"
        type={CARD_TYPE}
      />
    </Card>
  );
};
