// Shared foundation for the four header-video variants (HeaderMorph,
// HeaderModesReel, HeaderAssemble, HeaderBanner). Same cream/gold brand
// language as the README connection-type cards (src/modes/scene.tsx), but:
//   - a SOLID cream full-bleed background (1-bit GIF alpha looks rough), and
//   - wire/beam primitives sized to the whole composition (scene.tsx's hardcode
//     the 860x620 STAGE in their <svg>, which clips wide header layouts).
// Each variant imports from here + ../modes/scene and authors in its own comp
// coordinate space.

import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useVideoConfig,
} from "remotion";
import { loadFont as loadCotalSans } from "@remotion/google-fonts/Poppins";
import { fontFamily } from "../_shared";
import { GOLD, INK, NODE_R, type Pt } from "../modes/scene";

// "Cotal" wordmark face: a geometric sans close to the brand wordmark.
const { fontFamily: sansFamily } = loadCotalSans("normal", {
  weights: ["600", "700"],
  subsets: ["latin"],
});

// Brand gold for the real logo mark (slightly warmer than the scene accent GOLD).
export const LOGO_GOLD = "#E9C46A";

// --- re-exports: one import surface for the variant authors --------------------

export { fontFamily } from "../_shared";
export {
  AgentNode,
  ChannelPill,
  Dot,
  Ripple,
  bez,
  lerp,
  prog,
  fade,
  wirePath,
  GOLD,
  INK,
  NODE_R,
  STAGE,
} from "../modes/scene";
export type { Pt } from "../modes/scene";
export {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  Series,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// --- background ----------------------------------------------------------------

// Full-bleed solid cream with the faint engineering graph-paper dots. Drop this
// at the root of every variant so the GIF has an opaque, brand-correct backdrop.
export const CreamStage: React.FC<{
  children: React.ReactNode;
  dots?: boolean;
}> = ({ children, dots = true }) => (
  <AbsoluteFill
    style={{
      backgroundColor: INK.bg,
      backgroundImage: dots
        ? "radial-gradient(circle, rgba(55,52,46,0.05) 1px, transparent 1.4px)"
        : undefined,
      backgroundSize: "24px 24px",
      fontFamily,
      color: INK.name,
    }}
  >
    {children}
  </AbsoluteFill>
);

// --- full-frame SVG layer + wire/beam/pulse (no 860x620 clip) ------------------

// An <svg> sized to the whole composition. Put <path>s for wires/beams inside.
export const Field: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { width, height } = useVideoConfig();
  return (
    <svg style={{ position: "absolute", inset: 0 }} width={width} height={height}>
      {children}
    </svg>
  );
};

// Resting hairlines + optional gold afterglow per path (glow 0..1). Mirrors
// scene.tsx Wires but fills the frame.
export const WireLines: React.FC<{ paths: string[]; glow?: number[] }> = ({
  paths,
  glow = [],
}) => (
  <Field>
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
  </Field>
);

// Gold fiber-optic reveal of a message charging a wire (head Dot at pos(t)).
// Mirrors scene.tsx Beam but fills the frame. `pos` maps t->point for the head.
export const BeamLine: React.FC<{
  d: string;
  pos: (t: number) => Pt;
  t: number;
  visible: boolean;
}> = ({ d, pos, t, visible }) => {
  if (!visible) return null;
  const head = pos(t);
  return (
    <>
      <Field>
        <path d={d} pathLength={1} stroke={GOLD} strokeOpacity={0.16} strokeWidth={6.5} strokeLinecap="round" strokeDasharray={`${t} 1`} fill="none" />
        <path d={d} pathLength={1} stroke={GOLD} strokeOpacity={0.9} strokeWidth={2.6} strokeLinecap="round" strokeDasharray={`${t} 1`} fill="none" />
      </Field>
      <GoldDot at={head} />
    </>
  );
};

// A tapered pulse of light sliding down a wire. Mirrors scene.tsx Pulse.
export const PulseLine: React.FC<{
  d: string;
  pos: (t: number) => Pt;
  t: number;
  visible: boolean;
}> = ({ d, pos, t, visible }) => {
  if (!visible) return null;
  const TAIL = 0.16;
  const head = pos(t);
  return (
    <>
      <Field>
        <path d={d} pathLength={1} stroke={GOLD} strokeOpacity={0.28} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${TAIL} 1`} strokeDashoffset={-(t - TAIL)} fill="none" />
        <path d={d} pathLength={1} stroke={GOLD} strokeOpacity={0.85} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${TAIL * 0.4} 1`} strokeDashoffset={-(t - TAIL * 0.4)} fill="none" />
      </Field>
      <GoldDot at={head} />
    </>
  );
};

// Small gold dot (head of a beam/pulse or a parked message). Div-based, so it
// is resolution-independent. Same look as scene.tsx Dot.
export const GoldDot: React.FC<{ at: Pt; breath?: number }> = ({ at, breath = 0 }) => {
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

// --- variant 2: the invented wordmark (kept as an alternate) --------------------

// A tiny gold "agents in a mesh" glyph: three nodes in a triangle joined by
// hairlines. This was the first (invented) mark — kept as variant 2; the real
// brand logo is `RingMark` / `Logo` below.
export const MarkV2: React.FC<{ size: number }> = ({ size: s }) => {
  const pts = [
    { x: s * 0.5, y: s * 0.15 },
    { x: s * 0.15, y: s * 0.83 },
    { x: s * 0.85, y: s * 0.83 },
  ];
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ display: "block" }}>
      <path
        d={`M${pts[0]!.x} ${pts[0]!.y} L${pts[1]!.x} ${pts[1]!.y} L${pts[2]!.x} ${pts[2]!.y} Z`}
        stroke={GOLD}
        strokeOpacity={0.45}
        strokeWidth={s * 0.03}
        fill="none"
      />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={s * 0.12} fill={GOLD} />
      ))}
    </svg>
  );
};

// Variant-2 centered "cotal" wordmark + optional tagline (invented lockup).
export const WordmarkV2: React.FC<{
  frame: number;
  appear?: number;
  tagline?: string;
  size?: number;
}> = ({ frame, appear = 0, tagline, size = 84 }) => {
  const op = interpolate(frame, [appear, appear + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const dy = interpolate(frame, [appear, appear + 20], [14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        opacity: op,
        transform: `translateY(${dy}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: size * 0.34 }}>
        <MarkV2 size={size * 0.82} />
        <div
          style={{
            fontFamily,
            fontSize: size,
            color: INK.name,
            letterSpacing: size * 0.02,
            fontWeight: 500,
          }}
        >
          cotal
        </div>
      </div>
      {tagline ? (
        <div
          style={{
            fontFamily,
            fontSize: size * 0.22,
            color: INK.text,
            letterSpacing: 1,
            marginTop: size * 0.3,
          }}
        >
          {tagline}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// A small gold phase caption (e.g. "supervised", "peer-to-peer"). Centered at
// top by default, or left-aligned if `left` is given.
export const Caption: React.FC<{
  text: string;
  opacity?: number;
  top?: number;
  left?: number;
}> = ({ text, opacity = 1, top = 30, left }) => (
  <div
    style={{
      position: "absolute",
      top,
      left: left ?? 0,
      right: left == null ? 0 : undefined,
      textAlign: left == null ? "center" : "left",
      fontFamily,
      fontSize: 26,
      letterSpacing: 6,
      color: GOLD,
      opacity,
    }}
  >
    {text}
  </div>
);

// --- layout + loop helpers -----------------------------------------------------

// Scale a fixed (w x h) design group to fit the composition and center it.
// Used by HeaderModesReel to drop the 860x620 Mode scenes into a square frame.
export const ScaleToFit: React.FC<{
  w: number;
  h: number;
  children: React.ReactNode;
}> = ({ w, h, children }) => {
  const { width, height } = useVideoConfig();
  const s = Math.min(width / w, height / h);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: w, height: h, transform: `scale(${s})`, position: "relative" }}>
        {children}
      </div>
    </AbsoluteFill>
  );
};

// Opacity envelope that ramps in at the start and out at the end, so any loop is
// seamless even if the motion itself does not perfectly cycle. Optional.
export function loopEnvelope(frame: number, duration: number, edge = 10): number {
  return Math.min(
    interpolate(frame, [0, edge], [0, 1], { extrapolateRight: "clamp" }),
    interpolate(frame, [duration - edge, duration], [1, 0], { extrapolateLeft: "clamp" }),
  );
}

// --- real brand logo: three interlocking gold rings + "Cotal" -------------------

// Faithful recreation of cotal-mark.svg: three Borromean rings (outer r279,
// inner r213 annulus) whose over/under is cut by a mask at the *next* ring's
// centre. Each ring pops + scales in, staggered, from `appear` — reads as
// "agents connecting". `frame` omitted => fully drawn (static use).
const RING_CENTERS = [
  { cx: 500, cy: 320 }, // top
  { cx: 344.12, cy: 590 }, // bottom-left
  { cx: 655.88, cy: 590 }, // bottom-right
] as const;
const RING_PATHS = [
  "M 221 320 A 279 279 0 1 1 779 320 A 279 279 0 1 1 221 320 Z M 287 320 A 213 213 0 1 0 713 320 A 213 213 0 1 0 287 320 Z",
  "M 65.12 590 A 279 279 0 1 1 623.12 590 A 279 279 0 1 1 65.12 590 Z M 131.12 590 A 213 213 0 1 0 557.12 590 A 213 213 0 1 0 131.12 590 Z",
  "M 376.88 590 A 279 279 0 1 1 934.88 590 A 279 279 0 1 1 376.88 590 Z M 442.88 590 A 213 213 0 1 0 868.88 590 A 213 213 0 1 0 442.88 590 Z",
] as const;
// each ring is masked by a stroke-circle at the *other* ring's centre (over/under)
const RING_MASK_CUT = [
  { cx: 655.88, cy: 590 }, // mTOP cuts at bottom-right
  { cx: 500, cy: 320 }, // mBL cuts at top
  { cx: 344.12, cy: 590 }, // mBR cuts at bottom-left
] as const;

export const RingMark: React.FC<{
  size: number;
  frame?: number;
  appear?: number;
  id?: string;
}> = ({ size, frame = 1e9, appear = 0, id = "rm" }) => (
  <svg width={size} height={size} viewBox="0 0 1000 1000" style={{ display: "block", overflow: "visible" }}>
    <defs>
      {RING_MASK_CUT.map((c, i) => (
        <mask key={i} id={`m-${id}-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">
          <rect width="1000" height="1000" fill="white" />
          <circle cx={c.cx} cy={c.cy} r={246} fill="none" stroke="black" strokeWidth={126} />
        </mask>
      ))}
    </defs>
    {RING_PATHS.map((d, i) => {
      const start = appear + i * 7;
      const k = interpolate(frame, [start, start + 18], [0.5, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
      const op = interpolate(frame, [start, start + 12], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const { cx, cy } = RING_CENTERS[i]!;
      return (
        <g key={i} opacity={op} transform={`translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`}>
          <path d={d} fill={LOGO_GOLD} fillRule="evenodd" mask={`url(#m-${id}-${i})`} />
        </g>
      );
    })}
  </svg>
);

// The real centered brand lockup: animated RingMark + "Cotal" + optional tagline
// and CTA. Same prop shape as the old wordmark, so it is a drop-in default.
export const Logo: React.FC<{
  frame: number;
  appear?: number;
  tagline?: string;
  cta?: string;
  size?: number;
  id?: string;
}> = ({ frame, appear = 0, tagline, cta, size = 84, id = "logo" }) => {
  const op = interpolate(frame, [appear, appear + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const dy = interpolate(frame, [appear, appear + 20], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: op, transform: `translateY(${dy}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: size * 0.3 }}>
        <RingMark size={size * 1.08} frame={frame} appear={appear + 2} id={id} />
        <div style={{ fontFamily: sansFamily, fontSize: size, fontWeight: 600, color: INK.name, letterSpacing: size * 0.004 }}>
          Cotal
        </div>
      </div>
      {tagline ? (
        <div style={{ fontFamily, fontSize: size * 0.22, color: INK.text, letterSpacing: 0.5, marginTop: size * 0.32 }}>
          {tagline}
        </div>
      ) : null}
      {cta ? (
        <div style={{ fontFamily, fontSize: size * 0.2, color: GOLD, letterSpacing: 0.5, marginTop: size * 0.12 }}>
          {cta}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// Default brand wordmark = the real Logo (existing variants pick this up).
export const Wordmark = Logo;

// --- snippet building blocks ---------------------------------------------------

// On-screen caption (silent explainer). Bottom-centered by default; `accent`
// renders the main line in gold. `sub` adds a quieter second line.
export const Subtitle: React.FC<{
  text: string;
  sub?: string;
  opacity?: number;
  place?: "top" | "bottom";
  offset?: number;
  size?: number;
  accent?: boolean;
}> = ({ text, sub, opacity = 1, place = "bottom", offset = 60, size = 34, accent }) => (
  <AbsoluteFill
    style={{
      justifyContent: place === "top" ? "flex-start" : "flex-end",
      alignItems: "center",
      opacity,
      pointerEvents: "none",
    }}
  >
    <div style={{ [place === "top" ? "marginTop" : "marginBottom"]: offset, textAlign: "center" }}>
      <div style={{ fontFamily, fontSize: size, color: accent ? GOLD : INK.name, letterSpacing: 0.5 }}>{text}</div>
      {sub ? (
        <div style={{ fontFamily, fontSize: size * 0.62, color: INK.text, letterSpacing: 0.5, marginTop: 10 }}>{sub}</div>
      ) : null}
    </div>
  </AbsoluteFill>
);

// A soft rounded "shared space" boundary with an optional inset label.
export const SharedSpace: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  radius?: number;
  label?: string;
}> = ({ x, y, w, h, opacity = 1, radius = 48, label }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: radius,
      border: `1.5px solid ${INK.ring}`,
      background: "rgba(199,154,74,0.045)",
      opacity,
    }}
  >
    {label ? (
      <div
        style={{
          position: "absolute",
          top: -12,
          left: 26,
          background: INK.bg,
          padding: "0 10px",
          fontFamily,
          fontSize: 16,
          color: INK.dim,
          letterSpacing: 2,
        }}
      >
        {label}
      </div>
    ) : null}
  </div>
);

// A standalone presence dot: gold = working, hollow ring = idle.
export const PresenceDot: React.FC<{ at: Pt; status: "working" | "idle"; size?: number }> = ({
  at,
  status,
  size = 12,
}) => (
  <div
    style={{
      position: "absolute",
      left: at.x - size / 2,
      top: at.y - size / 2,
      width: size,
      height: size,
      borderRadius: "50%",
      background: status === "working" ? GOLD : "transparent",
      border: status === "working" ? "none" : `1.5px solid ${INK.dim}`,
    }}
  />
);

// An AgentNode that shows a vendor logo (Img via staticFile) instead of a
// letter — for the cross-vendor beat. `logo` is a path under public/.
export const AgentBadge: React.FC<{
  at: Pt;
  name?: string;
  role?: string;
  logo: string;
  status?: "working" | "idle";
  flash?: number;
  size?: number;
}> = ({ at, name, role, logo, status = "idle", flash = 0, size = NODE_R }) => {
  const ring = flash > 0.05 ? GOLD : INK.ring;
  return (
    <div style={{ position: "absolute", left: at.x - size, top: at.y - size }}>
      {flash > 0 ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: size * 2,
            height: size * 2,
            borderRadius: 26,
            border: `1.5px solid ${GOLD}`,
            transform: `scale(${1 + 0.55 * (1 - flash)})`,
            opacity: flash * 0.5,
          }}
        />
      ) : null}
      <div
        style={{
          width: size * 2,
          height: size * 2,
          borderRadius: 22,
          background: INK.fill,
          border: `1.5px solid ${ring}`,
          boxShadow: flash > 0.05 ? `0 0 22px 1px rgba(199,154,74,${0.28 * flash})` : "0 1px 2px rgba(40,34,20,0.05)",
          transform: `scale(${1 + 0.06 * flash})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Img src={staticFile(logo)} style={{ width: size * 1.15, height: size * 1.15, objectFit: "contain" }} />
      </div>
      <div
        style={{
          position: "absolute",
          top: 11,
          left: size * 2 - 23,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: status === "working" ? GOLD : "transparent",
          border: status === "working" ? "none" : `1.5px solid ${INK.dim}`,
        }}
      />
      {name || role ? (
        <div
          style={{
            position: "absolute",
            top: size * 2 + 13,
            left: -80,
            width: size * 2 + 160,
            textAlign: "center",
            fontFamily,
            fontSize: 22,
            letterSpacing: 0.3,
          }}
        >
          {name ? <span style={{ color: INK.name }}>{name}</span> : null}
          {role ? <span style={{ color: INK.dim }}>/{role}</span> : null}
        </div>
      ) : null}
    </div>
  );
};
