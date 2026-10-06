// Shared scene system for the README card animations (modes/ and nats/).
// Brand language: cool cream card floating on the page, one gold accent,
// hairline strokes, rounded-square nodes, lowercase mono, restraint.

import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";
import { fontFamily } from "../_shared";

// Square-ish stage. Single source of truth for size.
export const STAGE = { w: 860, h: 620 } as const;

// The README shows the NATS cards (nats/) one per row at the column width, 294
// CSS px on a 360 px phone, and the mode cards (modes/) at a fixed 270 CSS px,
// three to a row on a desktop page. Their type is scaled so the smallest text
// (18 px) still renders above 10 CSS px at 270, and their stages are taller to
// make room for it.
export const CARD_TYPE = 1.9;
export const MODE_STAGE = { w: STAGE.w, h: 780 } as const;
export const NATS_STAGE = { w: STAGE.w, h: 700 } as const;
const INSET = 16;

// --- palette (cool cream + gold + ink) -----------------------------------------

export const GOLD = "#c79a4a";
export const INK = {
  bg: "#f0efeb", // page / card: neutral beige, no gold cast
  card: "#f0efeb",
  line: "#dcd9d2", // hairline strokes, wires at rest
  ring: "#c9c5bc", // node rings
  fill: "#fafaf7", // node fill (a touch lighter than the card, reads raised)
  name: "#222222",
  text: "#5b5852",
  dim: "#a09b91",
};

export type Pt = { x: number; y: number };

export function bez(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

export function lerp(p0: Pt, p1: Pt, t: number): Pt {
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
}

export function prog(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
}

export function fade(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

// --- backdrop --------------------------------------------------------------------

export const Card: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  return (
    // outer margin transparent: the rounded cream card floats on the page,
    // so the alpha WebP looks right on GitHub light or dark.
    <AbsoluteFill style={{ fontFamily, background: "transparent" }}>
      <div
        style={{
          position: "absolute",
          inset: INSET,
          borderRadius: 26,
          // faint engineering graph-paper dots on a neutral beige base
          backgroundImage:
            `radial-gradient(circle, rgba(55,52,46,0.05) 1px, transparent 1.4px)`,
          backgroundSize: "24px 24px",
          backgroundColor: INK.card,
          border: "1px solid #e2dfd8",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

// Mode name + one-line caption top-left, real wire subject bottom-left.
// The caption makes each card self-explanatory standalone (npm, social).
export const Labels: React.FC<{ mode: string; caption: string; subject: string; type?: number }> = ({
  mode,
  caption,
  subject,
  type = 1,
}) => (
  <>
    <div
      style={{
        position: "absolute",
        top: 28,
        left: 38,
        fontSize: 26 * type,
        letterSpacing: 6 * type,
        color: GOLD,
      }}
    >
      {mode}
    </div>
    <div
      style={{
        position: "absolute",
        top: 28 + 40 * type,
        left: 40,
        fontSize: 19 * type,
        letterSpacing: 0.3 * type,
        color: INK.text,
      }}
    >
      {caption}
    </div>
    <div
      style={{
        position: "absolute",
        bottom: 24,
        left: 38,
        fontSize: 18 * type,
        color: INK.dim,
        letterSpacing: 0.5 * type,
      }}
    >
      {subject}
    </div>
  </>
);

// --- nodes -------------------------------------------------------------------------

// Rounded-square nodes. NODE_R is the half-size (box is NODE_R*2 on a side).
export const NODE_R = 45;
const NODE_RADIUS = 22;

export const AgentNode: React.FC<{
  at: Pt;
  name: string;
  role?: string;
  status: "idle" | "working";
  flash?: number; // 0..1 receive/emit pulse
  dimmed?: number; // 0..1
  type?: number;
}> = ({ at, name, role, status, flash = 0, dimmed = 0, type = 1 }) => {
  const ring = flash > 0.05 ? GOLD : INK.ring;
  const labelW = (NODE_R * 2 + 160) * type;
  return (
    <div
      style={{
        position: "absolute",
        left: at.x - NODE_R,
        top: at.y - NODE_R,
        opacity: 1 - 0.5 * dimmed,
      }}
    >
      {flash > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: NODE_R * 2,
            height: NODE_R * 2,
            borderRadius: NODE_RADIUS + 4,
            border: `1.5px solid ${GOLD}`,
            transform: `scale(${1 + 0.55 * (1 - flash)})`,
            opacity: flash * 0.5,
          }}
        />
      )}
      <div
        style={{
          width: NODE_R * 2,
          height: NODE_R * 2,
          borderRadius: NODE_RADIUS,
          background: INK.fill,
          border: `1.5px solid ${ring}`,
          boxShadow: flash > 0.05
            ? `0 0 22px 1px rgba(199,154,74,${0.28 * flash})`
            : "0 1px 2px rgba(40,34,20,0.05)",
          // receive-pop: a small spring when a message lands
          transform: `scale(${1 + 0.06 * flash})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 33,
          color: flash > 0.4 ? GOLD : INK.dim,
        }}
      >
        {name[0]}
      </div>
      {/* status: a quiet dot in the corner; gold = working, hollow = idle */}
      <div
        style={{
          position: "absolute",
          top: 11,
          left: NODE_R * 2 - 23,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: status === "working" ? GOLD : "transparent",
          border: status === "working" ? "none" : `1.5px solid ${INK.dim}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: NODE_R * 2 + 13,
          left: NODE_R - labelW / 2,
          width: labelW,
          textAlign: "center",
          fontSize: 22 * type,
          letterSpacing: 0.3 * type,
        }}
      >
        <span style={{ color: INK.name }}>{name}</span>
        {role && <span style={{ color: INK.dim }}>/{role}</span>}
      </div>
    </div>
  );
};

export const ChannelPill: React.FC<{ at: Pt; label: string; glow?: number; type?: number }> = ({
  at,
  label,
  glow = 0,
  type = 1,
}) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 92 * type,
      top: at.y - 31 * type,
      width: 184 * type,
      height: 62 * type,
      borderRadius: 31 * type,
      background: INK.fill,
      border: `1.5px solid ${glow > 0.05 ? GOLD : INK.ring}`,
      boxShadow: glow > 0.05
        ? `0 0 20px 1px rgba(199,154,74,${0.22 * glow})`
        : "0 1px 2px rgba(40,34,20,0.05)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 24 * type,
      letterSpacing: 0.5 * type,
      color: glow > 0.4 ? INK.name : INK.text,
    }}
  >
    {label}
  </div>
);

// --- wires + the light that runs along them ------------------------------------------

export function wirePath(p0: Pt, c1: Pt, c2: Pt, p1: Pt): string {
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
}

// Resting hairlines, plus an optional gold "afterglow" that lingers on a wire
// once a message has just traversed it (glow 0..1 per path), fading back to ink.
export const Wires: React.FC<{ paths: string[]; glow?: number[] }> = ({ paths, glow = [] }) => (
  <svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
    {paths.map((d, i) => (
      <path key={`r${i}`} d={d} stroke={INK.line} strokeOpacity={0.95} strokeWidth={2} fill="none" />
    ))}
    {paths.map((d, i) =>
      (glow[i] ?? 0) > 0.01 ? (
        <path
          key={`g${i}`}
          d={d}
          stroke={GOLD}
          strokeOpacity={0.55 * (glow[i] ?? 0)}
          strokeWidth={2}
          fill="none"
        />
      ) : null,
    )}
  </svg>
);

// The message charging a wire: gold fills the hairline from source to head as
// t goes 0..1 (fiber-optic reveal), with a soft underglow and a bright head.
export const Beam: React.FC<{
  d: string;
  pos: (t: number) => Pt;
  t: number;
  visible: boolean;
}> = ({ d, pos, t, visible }) => {
  if (!visible) return null;
  const head = pos(t);
  return (
    <>
      <svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
        <path
          d={d}
          pathLength={1}
          stroke={GOLD}
          strokeOpacity={0.16}
          strokeWidth={6.5}
          strokeLinecap="round"
          strokeDasharray={`${t} 1`}
          fill="none"
        />
        <path
          d={d}
          pathLength={1}
          stroke={GOLD}
          strokeOpacity={0.9}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeDasharray={`${t} 1`}
          fill="none"
        />
      </svg>
      <Dot at={head} />
    </>
  );
};

// A pulse of light running along a wire: a tapered dash sliding down the path,
// with a small bright head. No comet balls.
export const Pulse: React.FC<{
  d: string;
  pos: (t: number) => Pt;
  t: number; // eased 0..1
  visible: boolean;
}> = ({ d, pos, t, visible }) => {
  if (!visible) return null;
  const TAIL = 0.16;
  const head = pos(t);
  // dash window [t - TAIL, t], clamped by offset motion
  const off = -(t - TAIL);
  return (
    <>
      <svg style={{ position: "absolute", inset: 0 }} width="100%" height="100%">
        <path
          d={d}
          pathLength={1}
          stroke={GOLD}
          strokeOpacity={0.28}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${TAIL} 1`}
          strokeDashoffset={off}
          fill="none"
        />
        <path
          d={d}
          pathLength={1}
          stroke={GOLD}
          strokeOpacity={0.85}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${TAIL * 0.4} 1`}
          strokeDashoffset={-(t - TAIL * 0.4)}
          fill="none"
        />
      </svg>
      <Dot at={head} />
    </>
  );
};

// A concentric gold ring expanding from a point and fading. Multicast's
// signature "broadcast" beat. p is eased 0..1; render one or two staggered.
export const Ripple: React.FC<{ at: Pt; p: number }> = ({ at, p }) => {
  if (p <= 0 || p >= 1) return null;
  const r = 32 + 190 * p;
  return (
    <div
      style={{
        position: "absolute",
        left: at.x - r,
        top: at.y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        border: `1.5px solid ${GOLD}`,
        opacity: 0.4 * (1 - p),
      }}
    />
  );
};

// The message itself: a small gold dot (head of a pulse, or parked).
export const Dot: React.FC<{ at: Pt; breath?: number }> = ({ at, breath = 0 }) => {
  const r = 7 + 1.5 * breath;
  return (
    <div
      style={{
        position: "absolute",
        left: at.x - r,
        top: at.y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        background: GOLD,
        boxShadow: `0 0 ${10 + 4 * breath}px 1px rgba(199,154,74,0.45)`,
      }}
    />
  );
};
