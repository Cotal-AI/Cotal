// S5TopologyRotate — "Any agent, any topology." (rotating-leader variant)
//
// Identical morph + timing to S5TopologyVendors, but a DIFFERENT vendor leads
// each structured topology instead of Claude Code always sitting on top. A
// per-phase node ordering remaps which node occupies which position SLOT:
// slot 0 is the leader (top / manager / root). The leader sequence here is
// OpenCode -> Hermes -> Codex.
//
// Node->vendor (Codex preset): 0=Claude Code, 1=OpenCode, 2=Hermes, 3=Codex.
//
//   Phase 1  peer-to-peer  order [0,1,2,3]  (diamond)
//   Phase 2  supervised    order [1,0,2,3]  -> OpenCode on top
//   Phase 3  hierarchical  order [2,3,0,1]  -> Hermes root, Codex mid
//   Phase 4  hybrid        order [3,0,1,2]  -> Codex manages
//
// 1920x1080 @ 30fps.

import React from "react";
import {
  AgentBadge,
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

const DURATION = 240;

// vendor symbol per node — four distinct vendors (Codex preset).
const LOGOS = [
  "agents/claude-code.svg",
  "agents/opencode.svg",
  "agents/hermes.png",
  "agents/codex.svg",
];

// phase boundaries
const G12: [number, number] = [48, 77];
const G23: [number, number] = [109, 138];
const G34: [number, number] = [168, 197];

// --- per-phase position SLOT layouts (slot 0 = leader), center (960,540) -------
// These are the SAME coordinates as S5TopologyVendors' L1..L4. Slot index k is
// remapped to a node via the per-phase order below.
const L1: Pt[] = [
  { x: 960, y: 320 },
  { x: 1300, y: 540 },
  { x: 960, y: 760 },
  { x: 620, y: 540 },
];
const L2: Pt[] = [
  { x: 960, y: 300 },
  { x: 1280, y: 700 },
  { x: 960, y: 700 },
  { x: 640, y: 700 },
];
const L3: Pt[] = [
  { x: 960, y: 290 },
  { x: 960, y: 530 },
  { x: 1230, y: 760 },
  { x: 690, y: 760 },
];
const L4: Pt[] = [
  { x: 960, y: 300 },
  { x: 720, y: 660 },
  { x: 1200, y: 660 },
  { x: 960, y: 660 },
];

// per-phase node ordering: order[k] is the node placed in slot k (slot 0 = leader).
const O1 = [0, 1, 2, 3]; // peer (diamond — order doesn't matter much)
const O2 = [1, 0, 2, 3]; // supervised — OpenCode leads
const O3 = [2, 3, 0, 1]; // hierarchical — Hermes root, Codex mid
const O4 = [3, 0, 1, 2]; // hybrid — Codex manages

// remap a slot-indexed layout into a NODE-indexed layout: LP[node] = L[slot of node].
const byNode = (L: Pt[], order: number[]): Pt[] =>
  [0, 1, 2, 3].map((i) => L[order.indexOf(i)]!);

const LP1 = byNode(L1, O1);
const LP2 = byNode(L2, O2);
const LP3 = byNode(L3, O3);
const LP4 = byNode(L4, O4);

function nodeAt(i: number, frame: number): Pt {
  let p = LP1[i]!;
  p = lerp(p, LP2[i]!, prog(frame, G12[0], G12[1]));
  p = lerp(p, LP3[i]!, prog(frame, G23[0], G23[1]));
  p = lerp(p, LP4[i]!, prog(frame, G34[0], G34[1]));
  return p;
}

function edge(from: Pt, to: Pt, bow = 0): { d: string; pos: (t: number) => Pt } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const TRIM = 56;
  const p0: Pt = { x: from.x + ux * TRIM, y: from.y + uy * TRIM };
  const p1: Pt = { x: to.x - ux * TRIM, y: to.y - uy * TRIM };
  const nx = -uy;
  const ny = ux;
  const c1: Pt = { x: lerp(p0, p1, 0.35).x + nx * bow, y: lerp(p0, p1, 0.35).y + ny * bow };
  const c2: Pt = { x: lerp(p0, p1, 0.65).x + nx * bow, y: lerp(p0, p1, 0.65).y + ny * bow };
  return {
    d: `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`,
    pos: (t: number) => bez(p0, c1, c2, p1, t),
  };
}

const arrival = (frame: number, from: number, to: number): number => {
  const span = to - from;
  const lead = to - span * 0.32;
  return fade(frame, lead, to) * (1 - fade(frame, to + 2, to + 22));
};
const live = (t: number): boolean => t > 0 && t < 1;

export const S5TopologyRotate: React.FC = () => {
  const frame = useCurrentFrame();

  // node positions (indexed by NODE id, gliding through the remapped slots)
  const n = [0, 1, 2, 3].map((i) => nodeAt(i, frame));

  // per-phase leader + members, by NODE id.
  const [l1, m1a, m1b, m1c] = O1.map((nd) => n[nd]!) as [Pt, Pt, Pt, Pt];
  const [l2, m2a, m2b, m2c] = O2.map((nd) => n[nd]!) as [Pt, Pt, Pt, Pt];
  const [l3, mid3, leaf3a, leaf3b] = O3.map((nd) => n[nd]!) as [Pt, Pt, Pt, Pt];
  const [l4, m4a, m4b, m4c] = O4.map((nd) => n[nd]!) as [Pt, Pt, Pt, Pt];

  const s1 = 1 - fade(frame, G12[0], G12[1]);
  const s2 = fade(frame, G12[0], G12[1]) * (1 - fade(frame, G23[0], G23[1]));
  const s3 = fade(frame, G23[0], G23[1]) * (1 - fade(frame, G34[0], G34[1]));
  const s4 = fade(frame, G34[0], G34[1]);

  // phase 1: peer-to-peer diamond — ring edges between adjacent slots.
  const e_ab = edge(l1, m1a);
  const e_bc = edge(m1a, m1b);
  const e_cd = edge(m1b, m1c);
  const e_da = edge(m1c, l1);
  const p1Paths = [e_ab.d, e_bc.d, e_cd.d, e_da.d];
  const t_p1a = prog(frame, 10, 42);
  const t_p1b = prog(frame, 19, 51);
  const p1Glow = [arrival(frame, 10, 42), 0, arrival(frame, 19, 51), 0].map((g) => g * s1);

  // phase 2: supervised — leader -> each member (three down-beams).
  const e_a_b = edge(l2, m2a);
  const e_a_c = edge(l2, m2b);
  const e_a_d = edge(l2, m2c);
  const p2Paths = [e_a_b.d, e_a_c.d, e_a_d.d];
  const t_p2 = [prog(frame, 77, 106), prog(frame, 86, 115), prog(frame, 96, 122)];
  const p2Glow = [arrival(frame, 77, 106), arrival(frame, 86, 115), arrival(frame, 96, 122)].map((g) => g * s2);

  // phase 3: hierarchical — root -> mid; mid -> each leaf.
  const h_ab = edge(l3, mid3);
  const h_bc = edge(mid3, leaf3a);
  const h_bd = edge(mid3, leaf3b);
  const p3Paths = [h_ab.d, h_bc.d, h_bd.d];
  const t_p3 = [prog(frame, 134, 157), prog(frame, 157, 176), prog(frame, 163, 181)];
  const p3Glow = [arrival(frame, 134, 157), arrival(frame, 157, 176), arrival(frame, 163, 181)].map((g) => g * s3);

  // phase 4: hybrid — manager -> 3 members + two lateral peer links among members.
  const y_ab = edge(l4, m4a);
  const y_ac = edge(l4, m4b);
  const y_ad = edge(l4, m4c);
  const y_bd = edge(m4a, m4c, 26);
  const y_cd = edge(m4b, m4c, -26);
  const p4Paths = [y_ab.d, y_ac.d, y_ad.d, y_bd.d, y_cd.d];
  const t_p4mgr = prog(frame, 195, 221);
  const t_p4lat = prog(frame, 208, 234);
  const p4Glow = [
    arrival(frame, 195, 221),
    arrival(frame, 195, 221) * 0.6,
    0,
    arrival(frame, 208, 234),
    arrival(frame, 208, 234) * 0.7,
  ].map((g) => g * s4);

  // --- per-SLOT arrival flashes (same timing as the base), keyed to the node ---
  // currently occupying that slot in each phase, then maxed per node.
  // Slot flash timings per phase (slot index -> arrival window):
  //   p1: leader slot0 (10,42), slot1 0, slot2 (19,51), slot3 0
  //   p2: slot0 0 (leader sends), slot1 (77,106), slot2 (86,115), slot3 (96,122)
  //   p3: slot0 0 (root sends), slot1=mid (134,157), slot2=leaf (157,176), slot3=leaf (163,181)
  //   p4: slot0 0 (mgr sends), slot1 (195,221), slot2 (208,234)*0.7, slot3 (208,234)
  const slotFlash1 = [arrival(frame, 10, 42), 0, arrival(frame, 19, 51), 0].map((f) => f * s1);
  const slotFlash2 = [0, arrival(frame, 77, 106), arrival(frame, 86, 115), arrival(frame, 96, 122)].map((f) => f * s2);
  const slotFlash3 = [0, arrival(frame, 134, 157), arrival(frame, 157, 176), arrival(frame, 163, 181)].map((f) => f * s3);
  const slotFlash4 = [
    0,
    arrival(frame, 195, 221),
    arrival(frame, 208, 234) * 0.7,
    arrival(frame, 208, 234),
  ].map((f) => f * s4);

  // map slot flash -> node flash for a phase: node O[k] receives slotFlash[k].
  const nodeFlashFromSlots = (slotFlash: number[], order: number[]): number[] => {
    const out = [0, 0, 0, 0];
    order.forEach((nd, k) => {
      out[nd] = slotFlash[k]!;
    });
    return out;
  };
  const nf1 = nodeFlashFromSlots(slotFlash1, O1);
  const nf2 = nodeFlashFromSlots(slotFlash2, O2);
  const nf3 = nodeFlashFromSlots(slotFlash3, O3);
  const nf4 = nodeFlashFromSlots(slotFlash4, O4);

  const flashes = [0, 1, 2, 3].map((i) => Math.max(nf1[i]!, nf2[i]!, nf3[i]!, nf4[i]!));
  const status: ("idle" | "working")[] = flashes.map((f) => (f > 0.12 ? "working" : "idle"));

  // role label by the SLOT each node occupies in the current phase. Leader slot
  // reads as a leader ("peer"/"manager"/"root"). We pick the dominant phase by
  // structure opacity so the label tracks the visible topology.
  const slotRole = (slot: number): string => {
    if (s3 > 0.5) return slot === 0 ? "root" : slot === 1 ? "manager" : "leaf";
    if (s1 > 0.5) return "peer";
    return slot === 0 ? "manager" : slot === 1 ? "builder" : slot === 2 ? "reviewer" : "runner";
  };
  // resolve current dominant phase order, then label each node by its slot.
  const curOrder = s3 > 0.5 ? O3 : s4 > 0.5 ? O4 : s2 > 0.5 ? O2 : O1;
  const roles = [0, 1, 2, 3].map((i) => slotRole(curOrder.indexOf(i)));

  const cap1 = fade(frame, 6, 22) * (1 - fade(frame, 48, 64));
  const cap2 = fade(frame, 67, 83) * (1 - fade(frame, 109, 125));
  const cap3 = fade(frame, 128, 144) * (1 - fade(frame, 168, 184));
  const cap4 = fade(frame, 187, 203);

  const rootOpacity = loopEnvelope(frame, DURATION);

  return (
    <CreamStage>
      <div style={{ position: "absolute", inset: 0, opacity: rootOpacity }}>
        <div style={{ opacity: s1 }}><WireLines paths={p1Paths} glow={p1Glow} /></div>
        <div style={{ opacity: s2 }}><WireLines paths={p2Paths} glow={p2Glow} /></div>
        <div style={{ opacity: s3 }}><WireLines paths={p3Paths} glow={p3Glow} /></div>
        <div style={{ opacity: s4 }}><WireLines paths={p4Paths} glow={p4Glow} /></div>

        {/* the four agents are vendor symbols, gliding between layouts */}
        {n.map((at, i) => (
          <AgentBadge
            key={i}
            at={at}
            name={roles[i]!}
            logo={LOGOS[i]!}
            status={status[i]!}
            flash={flashes[i]!}
            size={50}
          />
        ))}

        {/* phase 1 beams */}
        <BeamLine d={e_ab.d} pos={e_ab.pos} t={t_p1a} visible={live(t_p1a) && s1 > 0.02} />
        <BeamLine d={e_cd.d} pos={e_cd.pos} t={t_p1b} visible={live(t_p1b) && s1 > 0.02} />
        {/* phase 2 beams */}
        <BeamLine d={e_a_b.d} pos={e_a_b.pos} t={t_p2[0]!} visible={live(t_p2[0]!) && s2 > 0.02} />
        <BeamLine d={e_a_c.d} pos={e_a_c.pos} t={t_p2[1]!} visible={live(t_p2[1]!) && s2 > 0.02} />
        <BeamLine d={e_a_d.d} pos={e_a_d.pos} t={t_p2[2]!} visible={live(t_p2[2]!) && s2 > 0.02} />
        {/* phase 3 beams */}
        <BeamLine d={h_ab.d} pos={h_ab.pos} t={t_p3[0]!} visible={live(t_p3[0]!) && s3 > 0.02} />
        <BeamLine d={h_bc.d} pos={h_bc.pos} t={t_p3[1]!} visible={live(t_p3[1]!) && s3 > 0.02} />
        <BeamLine d={h_bd.d} pos={h_bd.pos} t={t_p3[2]!} visible={live(t_p3[2]!) && s3 > 0.02} />
        {/* phase 4 beams */}
        <BeamLine d={y_ab.d} pos={y_ab.pos} t={t_p4mgr} visible={live(t_p4mgr) && s4 > 0.02} />
        <BeamLine d={y_bd.d} pos={y_bd.pos} t={t_p4lat} visible={live(t_p4lat) && s4 > 0.02} />

        <Subtitle place="top" text="Any agent, any topology" offset={64} size={40} />
        <Subtitle place="bottom" text="peer-to-peer" opacity={cap1} offset={70} size={34} accent />
        <Subtitle place="bottom" text="supervised" opacity={cap2} offset={70} size={34} accent />
        <Subtitle place="bottom" text="hierarchical" opacity={cap3} offset={70} size={34} accent />
        <Subtitle place="bottom" text="hybrid" opacity={cap4} offset={70} size={34} accent />
      </div>
    </CreamStage>
  );
};
