// Identity: the sender rides the subject, and two checks hold it there. The
// server refuses a publish on a subject the credential does not own; the
// receiver drops a message whose payload from does not match the subject.
// alice sends to bob as alice and both checks pass. carol publishes on alice's
// subject and the server refuses it. carol publishes on its own subject with a
// payload claiming alice: the server passes it and bob drops it.

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

// a: alice, honest. f: carol forges the subject. p: carol forges only the payload.
const T = {
  aSend: 8,
  aCheck: 32,
  aDeliverStart: 38,
  aDeliverEnd: 60,
  aFlashEnd: 84,
  fSend: 76,
  fCheck: 100,
  fRefusedEnd: 130,
  pSend: 126,
  pCheck: 150,
  pDeliverStart: 156,
  pDeliverEnd: 178,
  pDroppedEnd: 206,
};

// Both claims travel with the message, so the viewer can see which one each check reads.
const Tag: React.FC<{ at: Pt; subject: string; from: string }> = ({ at, subject, from }) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 90,
      top: at.y - 70,
      width: 180,
      textAlign: "center",
      fontSize: 18,
      lineHeight: "24px",
      color: INK.text,
    }}
  >
    <span style={{ background: INK.card, padding: "0 6px" }}>subject {subject}</span>
    <br />
    <span style={{ background: INK.card, padding: "0 6px" }}>from {from}</span>
  </div>
);

const Verdict: React.FC<{ at: Pt; text: string; ok: boolean; opacity: number }> = ({ at, text, ok, opacity }) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 90,
      top: at.y - 104,
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

const Duty: React.FC<{ at: Pt; text: string }> = ({ at, text }) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 100,
      top: at.y + 88,
      width: 200,
      textAlign: "center",
      fontSize: 17,
      color: INK.dim,
      letterSpacing: 0.3,
    }}
  >
    {text}
  </div>
);

// A refused message falls off the wire where it was stopped and fades out.
const Drop: React.FC<{ at: Pt; frame: number; from: number }> = ({ at, frame, from }) => {
  const drop = fade(frame, from, from + 18);
  if (frame < from || drop >= 1) return null;
  return (
    <div style={{ opacity: 1 - drop }}>
      <Dot at={{ x: at.x, y: at.y + 70 * drop }} />
    </div>
  );
};

const flashAt = (frame: number, start: number, end: number) =>
  frame >= start ? Math.max(0, 1 - fade(frame, start, end)) : 0;

export const NatsIdentity: React.FC = () => {
  const frame = useCurrentFrame();

  const tA = prog(frame, T.aSend, T.aCheck);
  const tAOut = prog(frame, T.aDeliverStart, T.aDeliverEnd);
  const tF = prog(frame, T.fSend, T.fCheck);
  const tP = prog(frame, T.pSend, T.pCheck);
  const tPOut = prog(frame, T.pDeliverStart, T.pDeliverEnd);
  const inFlight = (t: number) => t > 0 && t < 1;

  const emitA = flashAt(frame, T.aSend, T.aSend + 20);
  const emitC = Math.max(flashAt(frame, T.fSend, T.fSend + 20), flashAt(frame, T.pSend, T.pSend + 20));
  const deliverFlash = flashAt(frame, T.aDeliverEnd, T.aFlashEnd);

  const passed = Math.max(
    fade(frame, T.aCheck, T.aCheck + 6) * (1 - fade(frame, T.aDeliverEnd, T.aFlashEnd)),
    fade(frame, T.pCheck, T.pCheck + 6) * (1 - fade(frame, T.pDeliverEnd, T.pDeliverEnd + 12)),
  );
  const refused = fade(frame, T.fCheck, T.fCheck + 6) * (1 - fade(frame, T.fRefusedEnd - 12, T.fRefusedEnd));
  const delivered = fade(frame, T.aDeliverEnd, T.aDeliverEnd + 6) * (1 - fade(frame, T.aFlashEnd - 8, T.aFlashEnd));
  const dropped = fade(frame, T.pDeliverEnd, T.pDeliverEnd + 6) * (1 - fade(frame, T.pDroppedEnd - 12, T.pDroppedEnd));

  // Wire afterglows fade within 8 frames: img2webp -lossy treats a slower per-frame
  // change as no change, so the encoded card would keep the wire lit.
  const glowA = fade(frame, T.aCheck - 4, T.aCheck) * (1 - fade(frame, T.aDeliverStart, T.aDeliverStart + 8));
  const glowP = fade(frame, T.pCheck - 4, T.pCheck) * (1 - fade(frame, T.pDeliverStart, T.pDeliverStart + 8));
  const glowOut = flashAt(frame, T.aDeliverEnd, T.aDeliverEnd + 8);

  return (
    <Card frame={frame}>
      <Wires paths={[PATH_A, PATH_C, PATH_OUT]} glow={[glowA, glowP, glowOut]} />

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
      <Duty at={GATE} text="checks subject" />
      <Duty at={BOB} text="checks from" />
      <Verdict at={GATE} text="✓ passed" ok opacity={passed} />
      <Verdict at={GATE} text="✕ refused" ok={false} opacity={refused} />
      <Verdict at={BOB} text="✓ delivered" ok opacity={delivered} />
      <Verdict at={BOB} text="✕ dropped" ok={false} opacity={dropped} />

      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emitA} />
      <AgentNode at={CAROL} name="carol" role="reviewer" status="working" flash={emitC} />
      <AgentNode at={BOB} name="bob" role="builder" status="idle" flash={deliverFlash} />

      <Beam d={PATH_A} pos={(t) => bez(FROM_A, ...inCtrl(FROM_A), GATE_IN, t)} t={tA} visible={inFlight(tA)} />
      {inFlight(tA) && <Tag at={bez(FROM_A, ...inCtrl(FROM_A), GATE_IN, tA)} subject="alice" from="alice" />}
      <Beam d={PATH_OUT} pos={(t) => lerp(...OUT, t)} t={tAOut} visible={inFlight(tAOut)} />
      {inFlight(tAOut) && <Tag at={lerp(...OUT, tAOut)} subject="alice" from="alice" />}

      <Beam d={PATH_C} pos={(t) => bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, t)} t={tF} visible={inFlight(tF)} />
      {inFlight(tF) && <Tag at={bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, tF)} subject="alice" from="alice" />}
      <Drop at={GATE_IN} frame={frame} from={T.fCheck} />

      <Beam d={PATH_C} pos={(t) => bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, t)} t={tP} visible={inFlight(tP)} />
      {inFlight(tP) && <Tag at={bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, tP)} subject="carol" from="alice" />}
      <Beam d={PATH_OUT} pos={(t) => lerp(...OUT, t)} t={tPOut} visible={inFlight(tPOut)} />
      {inFlight(tPOut) && <Tag at={lerp(...OUT, tPOut)} subject="carol" from="alice" />}
      <Drop at={OUT[1]} frame={frame} from={T.pDeliverEnd} />

      <Labels
        mode="identity"
        caption="the sender rides the subject"
        subject={`cotal.demo.inst.u_….bob.u_….${frame < T.pSend ? "alice" : "carol"}`}
      />
    </Card>
  );
};
