// Identity: the sender rides the subject. alice sends to bob as herself and
// the server lets it through; carol sends claiming to be alice and the server
// refuses, because her credential only lets her publish as carol.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  bez,
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
} from "../modes/scene";

const ALICE: Pt = { x: 118, y: 200 };
const CAROL: Pt = { x: 118, y: 430 };
const GATE: Pt = { x: 430, y: 315 };
const BOB: Pt = { x: 726, y: 315 };

const GATE_IN: Pt = { x: GATE.x - 42, y: GATE.y };
const inCtrl = (from: Pt): [Pt, Pt] => [
  { x: from.x + 130, y: from.y },
  { x: GATE_IN.x - 130, y: GATE_IN.y },
];
const FROM_A: Pt = { x: ALICE.x + 52, y: ALICE.y };
const FROM_C: Pt = { x: CAROL.x + 52, y: CAROL.y };
const OUT: [Pt, Pt] = [
  { x: GATE.x + 42, y: GATE.y },
  { x: BOB.x - 52, y: BOB.y },
];

const PATH_A = wirePath(FROM_A, ...inCtrl(FROM_A), GATE_IN);
const PATH_C = wirePath(FROM_C, ...inCtrl(FROM_C), GATE_IN);
const PATH_OUT = wirePath(OUT[0], lerp(...OUT, 0.4), lerp(...OUT, 0.6), OUT[1]);

const T = {
  aSend: 12,
  aCheck: 40,
  aDeliverStart: 50,
  aDeliverEnd: 76,
  aFlashEnd: 100,
  cSend: 92,
  cCheck: 120,
  cRefusedEnd: 152,
};

// The claim travels with the message, so the viewer reads who it says it is.
const Tag: React.FC<{ at: Pt; text: string }> = ({ at, text }) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 80,
      top: at.y - 44,
      width: 160,
      textAlign: "center",
      fontSize: 18,
      color: INK.text,
    }}
  >
    <span style={{ background: INK.card, padding: "0 6px" }}>{text}</span>
  </div>
);

const Verdict: React.FC<{ text: string; ok: boolean; opacity: number }> = ({ text, ok, opacity }) => (
  <div
    style={{
      position: "absolute",
      left: GATE.x - 90,
      top: GATE.y - 104,
      width: 180,
      textAlign: "center",
      fontSize: 21,
      letterSpacing: 0.5,
      color: ok ? GOLD : INK.name,
      opacity,
    }}
  >
    {text}
  </div>
);

export const NatsIdentity: React.FC = () => {
  const frame = useCurrentFrame();

  const tA = prog(frame, T.aSend, T.aCheck);
  const tOut = prog(frame, T.aDeliverStart, T.aDeliverEnd);
  const tC = prog(frame, T.cSend, T.cCheck);

  const emitA = frame >= T.aSend ? Math.max(0, 1 - fade(frame, T.aSend, T.aSend + 20)) : 0;
  const emitC = frame >= T.cSend ? Math.max(0, 1 - fade(frame, T.cSend, T.cSend + 20)) : 0;
  const passed = fade(frame, T.aCheck, T.aCheck + 6) * (1 - fade(frame, T.aDeliverEnd, T.aFlashEnd));
  const refused = fade(frame, T.cCheck, T.cCheck + 6) * (1 - fade(frame, T.cRefusedEnd - 12, T.cRefusedEnd));
  const deliverFlash =
    frame >= T.aDeliverEnd ? Math.max(0, 1 - fade(frame, T.aDeliverEnd, T.aFlashEnd)) : 0;
  // the refused message drops at the gate and fades out, never reaching bob
  const drop = fade(frame, T.cCheck, T.cCheck + 18);

  const glowA = fade(frame, T.aCheck - 4, T.aCheck) * (1 - fade(frame, T.aDeliverStart, T.aDeliverEnd));

  return (
    <Card frame={frame}>
      <Wires paths={[PATH_A, PATH_C, PATH_OUT]} glow={[glowA, 0, deliverFlash]} />

      {/* the server: checks the sender in the subject against the credential */}
      <div
        style={{
          position: "absolute",
          left: GATE.x - 42,
          top: GATE.y - 42,
          width: 84,
          height: 84,
          borderRadius: 22,
          border: `1.5px solid ${passed > 0.05 ? GOLD : refused > 0.05 ? INK.name : INK.ring}`,
          background: INK.fill,
          boxShadow: passed > 0.05
            ? `0 0 18px 1px rgba(199,154,74,${0.22 * passed})`
            : "0 1px 2px rgba(40,34,20,0.05)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: GATE.x - 90,
          top: GATE.y + 56,
          width: 180,
          textAlign: "center",
          fontSize: 20,
          color: INK.dim,
          letterSpacing: 0.3,
        }}
      >
        nats server
      </div>
      <Verdict text="✓ alice" ok opacity={passed} />
      <Verdict text="✕ refused" ok={false} opacity={refused} />

      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emitA} />
      <AgentNode at={CAROL} name="carol" role="reviewer" status="working" flash={emitC} />
      <AgentNode at={BOB} name="bob" role="builder" status="idle" flash={deliverFlash} />

      <Beam d={PATH_A} pos={(t) => bez(FROM_A, ...inCtrl(FROM_A), GATE_IN, t)} t={tA} visible={tA > 0 && tA < 1} />
      {tA > 0 && tA < 1 && <Tag at={bez(FROM_A, ...inCtrl(FROM_A), GATE_IN, tA)} text="from alice" />}
      <Beam d={PATH_OUT} pos={(t) => lerp(...OUT, t)} t={tOut} visible={tOut > 0 && tOut < 1} />

      <Beam d={PATH_C} pos={(t) => bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, t)} t={tC} visible={tC > 0 && tC < 1} />
      {tC > 0 && tC < 1 && <Tag at={bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, tC)} text="from alice" />}
      {frame >= T.cCheck && drop < 1 && (
        <div style={{ opacity: 1 - drop }}>
          <Dot at={{ x: GATE_IN.x, y: GATE_IN.y + 70 * drop }} />
        </div>
      )}

      <Labels mode="identity" caption="the sender rides the subject" subject="cotal.demo.inst.u_….bob.u_….alice" />
    </Card>
  );
};
