// HeaderBanner — "Wordmark + lateral pulse": a minimal persistent banner for the
// README header slot (replaces header.gif). Cream/gold brand language, restraint.
// 1280x340 @ 30fps, 180-frame seamless loop (three 60-frame beats).
//
// Left  — the "cotal" wordmark + a tiny gold triangle-of-dots mark + tagline.
//         Stays fully visible the entire time.
// Right — three peers (alice/bob/carol) tapped on a shared horizontal bus.
//         A gold pulse cycles through the three connection modes:
//
//   beat 1  0-60    multicast: alice broadcasts down onto the bus, splitting to
//                              BOTH bob and carol (two pulses); both flash.
//   beat 2  60-120  unicast:   alice -> bus -> bob only; bob flashes.
//   beat 3  120-180 anycast:   alice -> bus -> carol (the free reviewer claims
//                              the work); carol flashes.

import React from "react";
import {
  AbsoluteFill,
  AgentNode,
  Field,
  fontFamily,
  GOLD,
  INK,
  interpolate,
  lerp,
  loopEnvelope,
  prog,
  PulseLine,
  useCurrentFrame,
  type Pt,
} from "./shared";

const DURATION = 180;

// --- layout (comp coordinate space: 1280x340) -----------------------------------

const ALICE: Pt = { x: 740, y: 150 };
const BOB: Pt = { x: 940, y: 150 };
const CAROL: Pt = { x: 1140, y: 150 };

const STUB_Y = 197; // node bottom: just below the rounded square (y150 + ~47)
const BUS_Y = 252; // shared bus hairline
const BUS_X0 = 700;
const BUS_X1 = 1180;

// Tap points: where each node's stub meets the bus.
const tap = (n: Pt): Pt => ({ x: n.x, y: BUS_Y });
const stubTop = (n: Pt): Pt => ({ x: n.x, y: STUB_Y });

// --- pulse path: source node -> bus -> target node ------------------------------
// Three straight legs: down the source stub, along the bus, up the target stub.
// `d` is the SVG path string; `pos(t)` maps a single 0..1 progress to the point
// along that three-leg polyline so the gold head + tapered tail track the wire.

function legPath(src: Pt, dst: Pt) {
  const a = stubTop(src); // start at source node bottom
  const b = tap(src); // down onto the bus
  const c = tap(dst); // slide along the bus
  const e = stubTop(dst); // up the target stub to its node
  const d = `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y} L ${e.x} ${e.y}`;

  // Arc-length weighting so the head moves at a constant visual speed across the
  // three legs (the bus leg is much longer than the two short stubs).
  const l1 = Math.abs(b.y - a.y);
  const l2 = Math.abs(c.x - b.x);
  const l3 = Math.abs(e.y - c.y);
  const total = l1 + l2 + l3;
  const f1 = l1 / total;
  const f2 = l2 / total;

  const pos = (t: number): Pt => {
    if (t <= f1) return lerp(a, b, t / f1);
    if (t <= f1 + f2) return lerp(b, c, (t - f1) / f2);
    return lerp(c, e, (t - f1 - f2) / (1 - f1 - f2));
  };
  return { d, pos };
}

const A_TO_B = legPath(ALICE, BOB);
const A_TO_C = legPath(ALICE, CAROL);

// Symmetric receive flash: ramps up as the pulse arrives, then eases back out.
function arriveFlash(frame: number, start: number, end: number): number {
  const up = interpolate(frame, [start, (start + end) / 2], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const down = interpolate(frame, [(start + end) / 2, end], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return Math.min(up, down);
}

// --- left: gold "agents in a mesh" mark (triangle of 3 dots) ---------------------

const Mark: React.FC<{ size: number }> = ({ size: s }) => {
  const pts: Pt[] = [
    { x: s * 0.5, y: s * 0.16 },
    { x: s * 0.16, y: s * 0.84 },
    { x: s * 0.84, y: s * 0.84 },
  ];
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ display: "block" }}>
      <path
        d={`M${pts[0]!.x} ${pts[0]!.y} L${pts[1]!.x} ${pts[1]!.y} L${pts[2]!.x} ${pts[2]!.y} Z`}
        stroke={GOLD}
        strokeOpacity={0.4}
        strokeWidth={s * 0.03}
        fill="none"
      />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={s * 0.12} fill={GOLD} />
      ))}
    </svg>
  );
};

// --- composition -----------------------------------------------------------------

export const HeaderBanner: React.FC = () => {
  const frame = useCurrentFrame();
  const env = loopEnvelope(frame, DURATION, 8);

  // beats: [start, end); active pulse runs prog(start+6, end-6).
  const inBeat1 = frame < 60;
  const inBeat2 = frame >= 60 && frame < 120;
  const inBeat3 = frame >= 120;

  const t1 = prog(frame, 6, 54); // multicast (both)
  const t2 = prog(frame, 66, 114); // unicast -> bob
  const t3 = prog(frame, 126, 174); // anycast -> carol

  // Flash a node as a pulse lands on it. Tuned to the back third of each beat,
  // when the head reaches the target stub.
  const bobFlash = Math.max(
    inBeat1 ? arriveFlash(frame, 40, 58) : 0, // multicast arrival
    inBeat2 ? arriveFlash(frame, 100, 118) : 0, // unicast arrival
  );
  const carolFlash = Math.max(
    inBeat1 ? arriveFlash(frame, 40, 58) : 0, // multicast arrival
    inBeat3 ? arriveFlash(frame, 160, 178) : 0, // anycast arrival
  );

  return (
    <AbsoluteFill style={{ opacity: env }}>
      <AbsoluteFill style={{ backgroundColor: INK.bg, fontFamily, color: INK.name }}>
        {/* faint engineering graph-paper dots */}
        <AbsoluteFill
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(55,52,46,0.05) 1px, transparent 1.4px)",
            backgroundSize: "24px 24px",
          }}
        />

        {/* --- left: wordmark + tagline (constant) --- */}
        <div style={{ position: "absolute", left: 84, top: 96, display: "flex", alignItems: "center", gap: 22 }}>
          <Mark size={56} />
          <div
            style={{
              fontFamily,
              fontSize: 88,
              color: INK.name,
              letterSpacing: 2,
              fontWeight: 500,
              lineHeight: 1,
            }}
          >
            cotal
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 88,
            top: 206,
            fontFamily,
            fontSize: 20,
            color: INK.text,
            letterSpacing: 0.3,
          }}
        >
          lateral agents in a shared space
        </div>

        {/* --- right: shared bus + vertical stubs (resting hairlines) --- */}
        <Field>
          {/* horizontal bus */}
          <line x1={BUS_X0} y1={BUS_Y} x2={BUS_X1} y2={BUS_Y} stroke={INK.line} strokeWidth={2} />
          {/* tap dots on the bus */}
          {[ALICE, BOB, CAROL].map((n, i) => (
            <circle key={`tap${i}`} cx={n.x} cy={BUS_Y} r={3} fill={INK.ring} />
          ))}
          {/* vertical stub wires from each node down to its bus tap */}
          {[ALICE, BOB, CAROL].map((n, i) => (
            <line key={`stub${i}`} x1={n.x} y1={STUB_Y} x2={n.x} y2={BUS_Y} stroke={INK.line} strokeWidth={2} />
          ))}
        </Field>

        {/* --- pulses (gold), one beat at a time --- */}
        {/* beat 1: multicast — alice splits to bob AND carol */}
        <PulseLine d={A_TO_B.d} pos={A_TO_B.pos} t={t1} visible={inBeat1} />
        <PulseLine d={A_TO_C.d} pos={A_TO_C.pos} t={t1} visible={inBeat1} />
        {/* beat 2: unicast — alice -> bob */}
        <PulseLine d={A_TO_B.d} pos={A_TO_B.pos} t={t2} visible={inBeat2} />
        {/* beat 3: anycast — alice -> carol */}
        <PulseLine d={A_TO_C.d} pos={A_TO_C.pos} t={t3} visible={inBeat3} />

        {/* --- nodes (alice working, others idle; flash on arrival) --- */}
        <AgentNode at={ALICE} name="alice" role="planner" status="working" />
        <AgentNode at={BOB} name="bob" role="builder" status="idle" flash={bobFlash} />
        <AgentNode at={CAROL} name="carol" role="reviewer" status="idle" flash={carolFlash} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
