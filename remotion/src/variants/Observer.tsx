import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AGENT, C, fontFamily, GRID_STYLE, spliceWordmark, STATUS, WM_WIDTH } from "../_shared";
import { Grid, Ticker, Tagline } from "../components";

// Reproduces the real `cotal console` dashboard (render.ts): roster with live
// presence badges + a scrolling subject log. The "Explain" pillar, literally.

type Seg = { text: string; color: string; bold?: boolean };
const PW = 60;

const WORDMARK = spliceWordmark(["", "", "", "", "", ""], WM_WIDTH, 0, 0);

// Presence flips over the 120-frame loop so the roster reads as live.
function roster(frame: number) {
  const carol =
    frame < 45
      ? { status: "idle" as const, activity: "" }
      : frame < 90
        ? { status: "working" as const, activity: "reviewing #general" }
        : { status: "waiting" as const, activity: "needs your input" };
  const bob =
    frame < 60
      ? { status: "waiting" as const, activity: "awaiting review" }
      : { status: "working" as const, activity: "applying patch" };
  return [
    { name: "alice", status: "working" as const, activity: "drafting the schema", age: "2s" },
    { name: "bob", status: bob.status, activity: bob.activity, age: "6s" },
    { name: "carol", status: carol.status, activity: carol.activity, age: "14s" },
  ];
}

function agentRow(p: ReturnType<typeof roster>[number]): Seg[] {
  const s = STATUS[p.status];
  return [
    { text: " " + s.dot + " ", color: s.color },
    { text: p.name.padEnd(8), color: AGENT[p.name as keyof typeof AGENT] ?? C.white },
    { text: s.word.padEnd(9), color: s.color },
    { text: p.activity.padEnd(26), color: C.dim },
    { text: p.age.padStart(4), color: C.dim },
  ];
}

function Line({ segs }: { segs: Seg[] }) {
  return (
    <div style={{ ...GRID_STYLE, fontSize: 16, lineHeight: "22px" }}>
      {segs.map((s, i) => (
        <span key={i} style={{ color: s.color, fontWeight: s.bold ? 700 : 400 }}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

export const Observer: React.FC = () => {
  const frame = useCurrentFrame();
  const list = roster(frame);
  const count = `${list.length} agents`;
  const headLeft = "COTAL · demo";
  const rule = "─".repeat(PW);
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily, color: C.white }}>
      <Grid grid={WORDMARK} top={20} fontSize={13} />
      <div style={{ position: "absolute", left: "50%", top: 130, transform: "translateX(-50%)" }}>
        <Line
          segs={[
            { text: "COTAL", color: C.white, bold: true },
            { text: " · demo", color: C.dim },
            { text: " ".repeat(Math.max(1, PW - headLeft.length - count.length)), color: C.dim },
            { text: count, color: C.dim },
          ]}
        />
        <Line segs={[{ text: rule, color: C.dim }]} />
        {list.map((p, i) => (
          <Line key={i} segs={agentRow(p)} />
        ))}
        <Line segs={[{ text: rule, color: C.dim }]} />
      </div>
      <Ticker frame={frame} />
      <Tagline text="watch the whole mesh think — presence, history, every message" frame={frame} />
    </AbsoluteFill>
  );
};
