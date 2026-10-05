// Identity: the sender rides the subject, and two checks hold it there. The
// server refuses a publish on a subject the credential does not own; the
// receiver drops a message whose payload from does not match the subject.
// alice sends to bob as alice and both checks pass. carol publishes on alice's
// subject and the server refuses it. carol publishes on its own subject with a
// payload claiming alice: the server passes it and bob drops it. Each check's
// line names the claim it read.

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
  GOLD,
  INK,
  Labels,
  lerp,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "../modes/scene";

const ALICE: Pt = { x: 130, y: 220 };
const CAROL: Pt = { x: 130, y: 460 };
const GATE: Pt = { x: 430, y: 340 };
const BOB: Pt = { x: 690, y: 340 };

const GATE_IN: Pt = { x: GATE.x - 42, y: GATE.y };
// Both senders' wires join one trunk into the server early, which keeps them
// clear of the server's two text lines.
const inCtrl = (from: Pt): [Pt, Pt] => [
  { x: from.x + 92, y: from.y },
  { x: from.x + 92, y: GATE_IN.y },
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

type Verdict = { text: string; ok: boolean; opacity: number };

// A check's line: its duty at rest, the verdict on the claim it read while it acts.
// The duty fades out before a verdict fades in, so the two never overlap.
const Check: React.FC<{ x: number; top: number; duty: string; verdicts: Verdict[] }> = ({
  x,
  top,
  duty,
  verdicts,
}) => {
  const line = (text: string, color: string, opacity: number) => (
    <div
      key={text}
      style={{
        position: "absolute",
        left: x - 200,
        top,
        width: 400,
        textAlign: "center",
        fontSize: 18 * CARD_TYPE,
        letterSpacing: 0.3 * CARD_TYPE,
        color,
        opacity,
      }}
    >
      {text}
    </div>
  );
  return (
    <>
      {line(duty, INK.dim, Math.max(0, 1 - 2 * Math.max(...verdicts.map((v) => v.opacity))))}
      {verdicts.map((v) => line(v.text, v.ok ? GOLD : INK.name, Math.max(0, 2 * v.opacity - 1)))}
    </>
  );
};

// A refused message falls off the wire where it was stopped and fades out.
const Drop: React.FC<{ at: Pt; frame: number; from: number }> = ({ at, frame, from }) => {
  const drop = fade(frame, from, from + 18);
  if (frame < from || drop >= 1) return null;
  return (
    <div style={{ opacity: 1 - drop }}>
      <Dot at={{ x: at.x, y: at.y + 40 * drop }} />
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

  const passedA = fade(frame, T.aCheck, T.aCheck + 6) * (1 - fade(frame, T.aDeliverEnd, T.aFlashEnd));
  const passedP = fade(frame, T.pCheck, T.pCheck + 6) * (1 - fade(frame, T.pDeliverEnd, T.pDeliverEnd + 12));
  const passed = Math.max(passedA, passedP);
  const refused = fade(frame, T.fCheck, T.fCheck + 6) * (1 - fade(frame, T.fRefusedEnd - 12, T.fRefusedEnd));
  const delivered = fade(frame, T.aDeliverEnd, T.aDeliverEnd + 6) * (1 - fade(frame, T.aFlashEnd - 8, T.aFlashEnd));
  const dropped = fade(frame, T.pDeliverEnd, T.pDeliverEnd + 6) * (1 - fade(frame, T.pDroppedEnd - 12, T.pDroppedEnd));

  // Wire afterglows fade within 8 frames: img2webp -lossy treats a slower per-frame
  // change as no change, so the encoded card would keep the wire lit.
  const glowA = fade(frame, T.aCheck - 4, T.aCheck) * (1 - fade(frame, T.aDeliverStart, T.aDeliverStart + 8));
  const glowP = fade(frame, T.pCheck - 4, T.pCheck) * (1 - fade(frame, T.pDeliverStart, T.pDeliverStart + 8));
  const glowOut = flashAt(frame, T.aDeliverEnd, T.aDeliverEnd + 8);

  return (
    <Card>
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
          left: GATE.x - 200,
          top: GATE.y - 102,
          width: 400,
          textAlign: "center",
          fontSize: 20 * CARD_TYPE,
          color: INK.dim,
          letterSpacing: 0.3 * CARD_TYPE,
        }}
      >
        nats server
      </div>
      <Check
        x={GATE.x}
        top={GATE.y + 52}
        duty="checks subject"
        verdicts={[
          { text: "✓ subject alice", ok: true, opacity: passedA },
          { text: "✕ subject alice", ok: false, opacity: refused },
          { text: "✓ subject carol", ok: true, opacity: passedP },
        ]}
      />
      <Check
        x={BOB.x}
        top={BOB.y + 120}
        duty="checks from"
        verdicts={[
          { text: "✓ from alice", ok: true, opacity: delivered },
          { text: "✕ from alice", ok: false, opacity: dropped },
        ]}
      />

      <AgentNode at={ALICE} name="alice" status="working" flash={emitA} type={CARD_TYPE} />
      <AgentNode at={CAROL} name="carol" status="working" flash={emitC} type={CARD_TYPE} />
      <AgentNode at={BOB} name="bob" status="idle" flash={deliverFlash} type={CARD_TYPE} />

      <Beam d={PATH_A} pos={(t) => bez(FROM_A, ...inCtrl(FROM_A), GATE_IN, t)} t={tA} visible={inFlight(tA)} />
      <Beam d={PATH_OUT} pos={(t) => lerp(...OUT, t)} t={tAOut} visible={inFlight(tAOut)} />

      <Beam d={PATH_C} pos={(t) => bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, t)} t={tF} visible={inFlight(tF)} />
      <Drop at={GATE_IN} frame={frame} from={T.fCheck} />

      <Beam d={PATH_C} pos={(t) => bez(FROM_C, ...inCtrl(FROM_C), GATE_IN, t)} t={tP} visible={inFlight(tP)} />
      <Beam d={PATH_OUT} pos={(t) => lerp(...OUT, t)} t={tPOut} visible={inFlight(tPOut)} />
      <Drop at={OUT[1]} frame={frame} from={T.pDeliverEnd} />

      <Labels
        mode="identity"
        caption="the sender rides the subject"
        subject={`cotal.demo.inst.u_….bob.u_….${frame < T.pSend ? "alice" : "carol"}`}
        type={CARD_TYPE}
      />
    </Card>
  );
};
