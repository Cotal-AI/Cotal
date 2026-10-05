// Attention: what may wake an agent. The loop steps bob through open, dnd and
// focus; each beat sends the same channel chatter and the same direct message.
// open: both wake it. dnd: chatter waits for its next turn. focus: chatter
// stays on the channel. A direct message wakes it in every mode.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  bez,
  Card,
  ChannelPill,
  Dot,
  fade,
  GOLD,
  INK,
  Labels,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "../modes/scene";

const CHANNEL: Pt = { x: 230, y: 236 };
const ALICE: Pt = { x: 186, y: 440 };
const BOB: Pt = { x: 680, y: 330 };

const CH_FROM: Pt = { x: CHANNEL.x + 92, y: CHANNEL.y };
const DM_FROM: Pt = { x: ALICE.x + 52, y: ALICE.y };
const CH_TO: Pt = { x: BOB.x - 52, y: BOB.y - 16 };
const DM_TO: Pt = { x: BOB.x - 52, y: BOB.y + 16 };
const ctrl = (from: Pt, to: Pt): [Pt, Pt] => [
  { x: from.x + 140, y: from.y },
  { x: to.x - 140, y: to.y },
];
const CH_PATH = wirePath(CH_FROM, ...ctrl(CH_FROM, CH_TO), CH_TO);
const DM_PATH = wirePath(DM_FROM, ...ctrl(DM_FROM, DM_TO), DM_TO);

const MODES = [
  { name: "open", outcome: "chatter and DMs wake bob" },
  { name: "dnd", outcome: "chatter waits for its next turn" },
  { name: "focus", outcome: "chatter stays on the channel" },
] as const;
const BEAT = 60;
const T = { chatStart: 6, chatEnd: 24, dmStart: 28, dmEnd: 44, settle: 56 };

const ModePill: React.FC<{ index: number; name: string; active: number }> = ({ index, name, active }) => (
  <div
    style={{
      position: "absolute",
      left: 530 + 94 * index,
      top: 30,
      width: 84,
      height: 40,
      borderRadius: 20,
      border: `1.5px solid ${active > 0.5 ? GOLD : INK.ring}`,
      background: INK.fill,
      color: active > 0.5 ? GOLD : INK.dim,
      fontSize: 19,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {name}
  </div>
);

export const NatsAttention: React.FC = () => {
  const frame = useCurrentFrame();
  const mode = Math.min(MODES.length - 1, Math.floor(frame / BEAT));
  const f = frame - mode * BEAT;

  const tChat = prog(f, T.chatStart, T.chatEnd);
  const tDm = prog(f, T.dmStart, T.dmEnd);
  const flashAt = (at: number) => (f >= at ? Math.max(0, 1 - fade(f, at, at + 14)) : 0);
  const chatWakes = mode === 0 ? flashAt(T.chatEnd) : 0;
  const dmWakes = flashAt(T.dmEnd);
  const held = fade(f, T.chatEnd, T.chatEnd + 4) * (1 - fade(f, T.settle - 6, T.settle));
  const breath = 0.5 + 0.5 * Math.sin((f / 20) * Math.PI * 2);
  const outcome = fade(f, 2, 8) * (1 - fade(f, T.settle, BEAT - 1));

  return (
    <Card frame={frame}>
      <Wires paths={[CH_PATH, DM_PATH]} glow={[chatWakes, dmWakes]} />

      {MODES.map((m, i) => (
        <ModePill key={m.name} index={i} name={m.name} active={i === mode ? 1 : 0} />
      ))}

      <ChannelPill at={CHANNEL} label="#general" glow={mode === 2 ? held : 0} />
      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={flashAt(T.dmStart)} />
      <AgentNode at={BOB} name="bob" role="builder" status="idle" flash={Math.max(chatWakes, dmWakes)} />

      {mode === 2 ? (
        // focus: the chatter never leaves the channel
        held > 0 && <Dot at={{ x: CH_FROM.x + 22, y: CH_FROM.y }} breath={breath * held} />
      ) : (
        <Beam
          d={CH_PATH}
          pos={(t) => bez(CH_FROM, ...ctrl(CH_FROM, CH_TO), CH_TO, t)}
          t={tChat}
          visible={tChat > 0 && tChat < 1}
        />
      )}
      {/* dnd: the chatter arrives but waits beside bob instead of waking it */}
      {mode === 1 && held > 0 && <Dot at={{ x: CH_TO.x - 26, y: CH_TO.y - 34 }} breath={breath * held} />}
      <Beam
        d={DM_PATH}
        pos={(t) => bez(DM_FROM, ...ctrl(DM_FROM, DM_TO), DM_TO, t)}
        t={tDm}
        visible={tDm > 0 && tDm < 1}
      />

      <div
        style={{
          position: "absolute",
          right: 28,
          top: 90,
          fontSize: 19,
          letterSpacing: 0.3,
          color: INK.name,
          opacity: outcome,
        }}
      >
        {MODES[mode]!.outcome}
      </div>

      <Labels mode="attention" caption="what may wake an agent" subject={`cotal_status attention=${MODES[mode]!.name}`} />
    </Card>
  );
};
