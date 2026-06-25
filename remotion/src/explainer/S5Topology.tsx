// S5Topology — "One protocol, any topology — you decide."
//
// The SAME four agents (alice/bob/carol/dave) re-arrange through four
// topologies. Only their positions and the wires between them change: nodes
// glide with lerp(posA, posB, prog(...)) and each phase redraws its own
// WireLines, cross-fading the old layout out as the new one fades in. A gold
// BeamLine travels each layout to show the protocol "working". Same morph
// technique as HeaderMorph (../header/HeaderMorph.tsx). 1920x1080 @ 30fps.
//
//   Phase 1  0-40    peer-to-peer:  4 nodes on a diamond, lateral links all around.
//   Phase 2  40-78   supervised:    one rises to manager, other 3 in a row below.
//   Phase 3  78-115  hierarchical:  depth-2 tree (top -> middle -> two leaves).
//   Phase 4  115-150 hybrid:        manager over two peers that also link laterally.

import React from "react";
import {
  AgentNode,
  BeamLine,
  bez,
  CreamStage,
  fade,
  lerp,
  loopEnvelope,
  prog,
  Subtitle,
  useCurrentFrame,
  WireLines,
  type Pt,
} from "../header/shared";

const DURATION = 150;

// glide windows (where node positions interpolate between layouts)
const G12: [number, number] = [30, 48];
const G23: [number, number] = [68, 86];
const G34: [number, number] = [105, 123];

// --- per-phase node layouts (alice, bob, carol, dave) ---------------------------
// Center (960,540). Labels sit ~58px below a node, so keep all y well inside
// 1080 (deepest leaf y ~ 760 -> label ~ 818, safe).

// Phase 1 — peer-to-peer diamond, centered.
const L1: Pt[] = [
  { x: 960, y: 320 }, // alice (top)
  { x: 1300, y: 540 }, // bob   (right)
  { x: 960, y: 760 }, // carol (bottom)
  { x: 620, y: 540 }, // dave  (left)
];

// Phase 2 — supervised: alice rises to manager, the other three in a row.
const L2: Pt[] = [
  { x: 960, y: 300 }, // alice (manager, top-center)
  { x: 1280, y: 700 }, // bob
  { x: 960, y: 700 }, // carol
  { x: 640, y: 700 }, // dave
];

// Phase 3 — hierarchical: alice -> bob (middle) -> {carol, dave} leaves.
const L3: Pt[] = [
  { x: 960, y: 290 }, // alice (root)
  { x: 960, y: 530 }, // bob   (middle)
  { x: 1230, y: 760 }, // carol (leaf)
  { x: 690, y: 760 }, // dave  (leaf)
];

// Phase 4 — hybrid: alice manages bob & carol, which also peer laterally; dave
// peers in too. (manager over two peers that link to each other + a third peer)
const L4: Pt[] = [
  { x: 960, y: 300 }, // alice (manager)
  { x: 720, y: 660 }, // bob   (peer)
  { x: 1200, y: 660 }, // carol (peer)
  { x: 960, y: 660 }, // dave  (peer, between)
];

// glide node i: hold L1 -> L2 -> L3 -> L4 across the three glide windows.
function nodeAt(i: number, frame: number): Pt {
  let p = L1[i]!;
  p = lerp(p, L2[i]!, prog(frame, G12[0], G12[1]));
  p = lerp(p, L3[i]!, prog(frame, G23[0], G23[1]));
  p = lerp(p, L4[i]!, prog(frame, G34[0], G34[1]));
  return p;
}

// --- wires --------------------------------------------------------------------
// A gentle cubic between two node centers, trimmed to each node's edge so the
// hairline meets the rounded-square cleanly. `bow` offsets control points
// perpendicular to give lateral links a slight arc (so overlapping pairs read).
function edge(from: Pt, to: Pt, bow = 0): { d: string; pos: (t: number) => Pt } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const TRIM = 52; // node half-size-ish, keeps the wire off the glyph
  const p0: Pt = { x: from.x + ux * TRIM, y: from.y + uy * TRIM };
  const p1: Pt = { x: to.x - ux * TRIM, y: to.y - uy * TRIM };
  // perpendicular for the bow
  const nx = -uy;
  const ny = ux;
  const c1: Pt = { x: lerp(p0, p1, 0.35).x + nx * bow, y: lerp(p0, p1, 0.35).y + ny * bow };
  const c2: Pt = { x: lerp(p0, p1, 0.65).x + nx * bow, y: lerp(p0, p1, 0.65).y + ny * bow };
  return {
    d: `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`,
    pos: (t: number) => bez(p0, c1, c2, p1, t),
  };
}

// soft flash that rises as a beam nears its target, then decays (per HeaderMorph)
const arrival = (frame: number, from: number, to: number): number => {
  const span = to - from;
  const lead = to - span * 0.32;
  return fade(frame, lead, to) * (1 - fade(frame, to + 2, to + 22));
};

// a beam that is only live (renders) while its phase structure is up
const live = (t: number): boolean => t > 0 && t < 1;

export const S5Topology: React.FC = () => {
  const frame = useCurrentFrame();

  const n = [0, 1, 2, 3].map((i) => nodeAt(i, frame));
  const [alice, bob, carol, dave] = n as [Pt, Pt, Pt, Pt];

  // --- structure opacities: each phase's wires fade in/out around its window ---
  const s1 = 1 - fade(frame, G12[0], G12[1]); // peer-to-peer present until glide 1
  const s2 = fade(frame, G12[0], G12[1]) * (1 - fade(frame, G23[0], G23[1]));
  const s3 = fade(frame, G23[0], G23[1]) * (1 - fade(frame, G34[0], G34[1]));
  const s4 = fade(frame, G34[0], G34[1]);

  // --- phase 1: peer-to-peer — all four lateral links of the diamond ---------
  const e_ab = edge(alice, bob);
  const e_bc = edge(bob, carol);
  const e_cd = edge(carol, dave);
  const e_da = edge(dave, alice);
  const p1Paths = [e_ab.d, e_bc.d, e_cd.d, e_da.d];
  // two beams travel the ring (ab, cd) to show it working
  const t_p1a = prog(frame, 6, 26);
  const t_p1b = prog(frame, 12, 32);
  const p1Glow = [arrival(frame, 6, 26), 0, arrival(frame, 12, 32), 0].map((g) => g * s1);

  // --- phase 2: supervised — manager (alice) down to each of the row ---------
  const e_a_b = edge(alice, bob);
  const e_a_c = edge(alice, carol);
  const e_a_d = edge(alice, dave);
  const p2Paths = [e_a_b.d, e_a_c.d, e_a_d.d];
  // staggered down-beams
  const t_p2 = [prog(frame, 48, 66), prog(frame, 54, 72), prog(frame, 60, 76)];
  const p2Glow = [
    arrival(frame, 48, 66),
    arrival(frame, 54, 72),
    arrival(frame, 60, 76),
  ].map((g) => g * s2);

  // --- phase 3: hierarchical — alice->bob, bob->carol, bob->dave -------------
  const h_ab = edge(alice, bob);
  const h_bc = edge(bob, carol);
  const h_bd = edge(bob, dave);
  const p3Paths = [h_ab.d, h_bc.d, h_bd.d];
  // beam flows down the chain: root->middle, then middle->each leaf
  const t_p3 = [prog(frame, 84, 98), prog(frame, 98, 110), prog(frame, 102, 113)];
  const p3Glow = [
    arrival(frame, 84, 98),
    arrival(frame, 98, 110),
    arrival(frame, 102, 113),
  ].map((g) => g * s3);

  // --- phase 4: hybrid — manager alice over bob/carol; bob-carol peer; dave --
  const y_ab = edge(alice, bob);
  const y_ac = edge(alice, carol);
  const y_ad = edge(alice, dave);
  const y_bd = edge(bob, dave, 26); // lateral peer link (bowed)
  const y_cd = edge(carol, dave, -26); // lateral peer link (bowed)
  const p4Paths = [y_ab.d, y_ac.d, y_ad.d, y_bd.d, y_cd.d];
  // a managed beam down + a lateral peer beam, to show the mix working
  const t_p4mgr = prog(frame, 122, 138);
  const t_p4lat = prog(frame, 130, 146);
  const p4Glow = [
    arrival(frame, 122, 138),
    arrival(frame, 122, 138) * 0.6,
    0,
    arrival(frame, 130, 146),
    arrival(frame, 130, 146) * 0.7,
  ].map((g) => g * s4);

  // --- per-agent flash: max of any arriving beam touching that node ----------
  const aliceFlash = Math.max(
    arrival(frame, 6, 26) * s1, // p1 ab
    arrival(frame, 48, 66) * s2, // p2 manager emit
    arrival(frame, 84, 98) * s3, // p3 root
    arrival(frame, 122, 138) * s4, // p4 manager emit
  );
  const bobFlash = Math.max(
    arrival(frame, 6, 26) * s1,
    arrival(frame, 48, 66) * s2,
    arrival(frame, 84, 98) * s3, // p3 middle receives
    arrival(frame, 130, 146) * s4, // p4 lateral
  );
  const carolFlash = Math.max(
    arrival(frame, 12, 32) * s1,
    arrival(frame, 54, 72) * s2,
    arrival(frame, 98, 110) * s3,
    arrival(frame, 130, 146) * 0.7 * s4,
  );
  const daveFlash = Math.max(
    arrival(frame, 12, 32) * s1,
    arrival(frame, 60, 76) * s2,
    arrival(frame, 102, 113) * s3,
    arrival(frame, 130, 146) * s4,
  );
  const flashes = [aliceFlash, bobFlash, carolFlash, daveFlash];
  const status: ("idle" | "working")[] = flashes.map((f) =>
    f > 0.12 ? "working" : "idle",
  );

  // alice's role shifts as the topology does (peer -> manager -> root -> manager)
  const aliceRole =
    s1 > 0.5 ? "peer" : s3 > 0.5 ? "root" : "manager";

  // --- bottom caption: name the current topology (crossfade per phase) -------
  const cap1 = fade(frame, 4, 14) * (1 - fade(frame, 30, 40));
  const cap2 = fade(frame, 42, 52) * (1 - fade(frame, 68, 78));
  const cap3 = fade(frame, 80, 90) * (1 - fade(frame, 105, 115));
  const cap4 = fade(frame, 117, 127);

  const rootOpacity = loopEnvelope(frame, DURATION);

  return (
    <CreamStage>
      <div style={{ position: "absolute", inset: 0, opacity: rootOpacity }}>
        {/* phase 1 wires: peer-to-peer */}
        <div style={{ opacity: s1 }}>
          <WireLines paths={p1Paths} glow={p1Glow} />
        </div>
        {/* phase 2 wires: supervised */}
        <div style={{ opacity: s2 }}>
          <WireLines paths={p2Paths} glow={p2Glow} />
        </div>
        {/* phase 3 wires: hierarchical */}
        <div style={{ opacity: s3 }}>
          <WireLines paths={p3Paths} glow={p3Glow} />
        </div>
        {/* phase 4 wires: hybrid */}
        <div style={{ opacity: s4 }}>
          <WireLines paths={p4Paths} glow={p4Glow} />
        </div>

        {/* agents (same four, gliding between layouts) */}
        <AgentNode at={alice} name="alice" role={aliceRole} status={status[0]!} flash={flashes[0]!} />
        <AgentNode at={bob} name="bob" role="builder" status={status[1]!} flash={flashes[1]!} />
        <AgentNode at={carol} name="carol" role="reviewer" status={status[2]!} flash={flashes[2]!} />
        <AgentNode at={dave} name="dave" role="runner" status={status[3]!} flash={flashes[3]!} />

        {/* phase 1 beams */}
        <BeamLine d={e_ab.d} pos={e_ab.pos} t={t_p1a} visible={live(t_p1a) && s1 > 0.02} />
        <BeamLine d={e_cd.d} pos={e_cd.pos} t={t_p1b} visible={live(t_p1b) && s1 > 0.02} />

        {/* phase 2 beams (manager -> row, staggered) */}
        <BeamLine d={e_a_b.d} pos={e_a_b.pos} t={t_p2[0]!} visible={live(t_p2[0]!) && s2 > 0.02} />
        <BeamLine d={e_a_c.d} pos={e_a_c.pos} t={t_p2[1]!} visible={live(t_p2[1]!) && s2 > 0.02} />
        <BeamLine d={e_a_d.d} pos={e_a_d.pos} t={t_p2[2]!} visible={live(t_p2[2]!) && s2 > 0.02} />

        {/* phase 3 beams (down the tree) */}
        <BeamLine d={h_ab.d} pos={h_ab.pos} t={t_p3[0]!} visible={live(t_p3[0]!) && s3 > 0.02} />
        <BeamLine d={h_bc.d} pos={h_bc.pos} t={t_p3[1]!} visible={live(t_p3[1]!) && s3 > 0.02} />
        <BeamLine d={h_bd.d} pos={h_bd.pos} t={t_p3[2]!} visible={live(t_p3[2]!) && s3 > 0.02} />

        {/* phase 4 beams (managed + lateral peer) */}
        <BeamLine d={y_ab.d} pos={y_ab.pos} t={t_p4mgr} visible={live(t_p4mgr) && s4 > 0.02} />
        <BeamLine d={y_bd.d} pos={y_bd.pos} t={t_p4lat} visible={live(t_p4lat) && s4 > 0.02} />

        {/* persistent top caption */}
        <Subtitle place="top" text="One protocol, any topology — you decide." offset={64} size={40} />

        {/* bottom caption: current topology name (crossfade per phase) */}
        <Subtitle place="bottom" text="peer-to-peer" opacity={cap1} offset={70} size={34} accent />
        <Subtitle place="bottom" text="supervised" opacity={cap2} offset={70} size={34} accent />
        <Subtitle place="bottom" text="hierarchical" opacity={cap3} offset={70} size={34} accent />
        <Subtitle place="bottom" text="hybrid" opacity={cap4} offset={70} size={34} accent />
      </div>
    </CreamStage>
  );
};
