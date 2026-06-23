// S5TopologyVendors — "Any agent, any topology."
//
// Same morph as S5Topology, but the four nodes are the actual VENDOR symbols
// (Claude Code, OpenCode, Hermes, + a second Claude Code instance) instead of
// abstract letters — so ONE beat shows cross-vendor AND any-topology at the same
// time: different-vendor agents wired into peer / supervised / hierarchical /
// hybrid structures. Logos via AgentBadge; labels are roles so the structure
// reads while the symbols carry the vendor identity. 1920x1080 @ 30fps.
//
//   Phase 1  0-40    peer-to-peer  ·  Phase 2  40-78   supervised
//   Phase 3  78-115  hierarchical  ·  Phase 4  115-150 hybrid

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

// vendor symbol per node. Two presets: the default duplicates Claude Code for
// the 4th node; the Codex preset uses OpenAI Codex as a distinct 4th vendor.
const DEFAULT_LOGOS = [
  "agents/claude-code.svg",
  "agents/opencode.svg",
  "agents/hermes.png",
  "agents/claude-code.svg",
];
const CODEX_LOGOS = [
  "agents/claude-code.svg",
  "agents/opencode.svg",
  "agents/hermes.png",
  "agents/codex.svg",
];

// phase boundaries
const G12: [number, number] = [48, 77];
const G23: [number, number] = [109, 138];
const G34: [number, number] = [168, 197];

// --- per-phase layouts (node 0..3), center (960,540) ---------------------------
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

function nodeAt(i: number, frame: number): Pt {
  let p = L1[i]!;
  p = lerp(p, L2[i]!, prog(frame, G12[0], G12[1]));
  p = lerp(p, L3[i]!, prog(frame, G23[0], G23[1]));
  p = lerp(p, L4[i]!, prog(frame, G34[0], G34[1]));
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

const TopologyVendorsBase: React.FC<{ logos: string[] }> = ({ logos }) => {
  const frame = useCurrentFrame();

  const n = [0, 1, 2, 3].map((i) => nodeAt(i, frame));
  const [alice, bob, carol, dave] = n as [Pt, Pt, Pt, Pt];

  const s1 = 1 - fade(frame, G12[0], G12[1]);
  const s2 = fade(frame, G12[0], G12[1]) * (1 - fade(frame, G23[0], G23[1]));
  const s3 = fade(frame, G23[0], G23[1]) * (1 - fade(frame, G34[0], G34[1]));
  const s4 = fade(frame, G34[0], G34[1]);

  // phase 1: peer-to-peer diamond
  const e_ab = edge(alice, bob);
  const e_bc = edge(bob, carol);
  const e_cd = edge(carol, dave);
  const e_da = edge(dave, alice);
  const p1Paths = [e_ab.d, e_bc.d, e_cd.d, e_da.d];
  const t_p1a = prog(frame, 10, 42);
  const t_p1b = prog(frame, 19, 51);
  const p1Glow = [arrival(frame, 10, 42), 0, arrival(frame, 19, 51), 0].map((g) => g * s1);

  // phase 2: supervised
  const e_a_b = edge(alice, bob);
  const e_a_c = edge(alice, carol);
  const e_a_d = edge(alice, dave);
  const p2Paths = [e_a_b.d, e_a_c.d, e_a_d.d];
  const t_p2 = [prog(frame, 77, 106), prog(frame, 86, 115), prog(frame, 96, 122)];
  const p2Glow = [arrival(frame, 77, 106), arrival(frame, 86, 115), arrival(frame, 96, 122)].map((g) => g * s2);

  // phase 3: hierarchical
  const h_ab = edge(alice, bob);
  const h_bc = edge(bob, carol);
  const h_bd = edge(bob, dave);
  const p3Paths = [h_ab.d, h_bc.d, h_bd.d];
  const t_p3 = [prog(frame, 134, 157), prog(frame, 157, 176), prog(frame, 163, 181)];
  const p3Glow = [arrival(frame, 134, 157), arrival(frame, 157, 176), arrival(frame, 163, 181)].map((g) => g * s3);

  // phase 4: hybrid
  const y_ab = edge(alice, bob);
  const y_ac = edge(alice, carol);
  const y_ad = edge(alice, dave);
  const y_bd = edge(bob, dave, 26);
  const y_cd = edge(carol, dave, -26);
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

  const aliceFlash = Math.max(
    arrival(frame, 10, 42) * s1,
    arrival(frame, 77, 106) * s2,
    arrival(frame, 134, 157) * s3,
    arrival(frame, 195, 221) * s4,
  );
  const bobFlash = Math.max(
    arrival(frame, 10, 42) * s1,
    arrival(frame, 77, 106) * s2,
    arrival(frame, 134, 157) * s3,
    arrival(frame, 208, 234) * s4,
  );
  const carolFlash = Math.max(
    arrival(frame, 19, 51) * s1,
    arrival(frame, 86, 115) * s2,
    arrival(frame, 157, 176) * s3,
    arrival(frame, 208, 234) * 0.7 * s4,
  );
  const daveFlash = Math.max(
    arrival(frame, 19, 51) * s1,
    arrival(frame, 96, 122) * s2,
    arrival(frame, 163, 181) * s3,
    arrival(frame, 208, 234) * s4,
  );
  const flashes = [aliceFlash, bobFlash, carolFlash, daveFlash];
  const status: ("idle" | "working")[] = flashes.map((f) => (f > 0.12 ? "working" : "idle"));

  // node-0's role shifts with the topology (peer -> manager -> root -> manager)
  const role0 = s1 > 0.5 ? "peer" : s3 > 0.5 ? "root" : "manager";
  const roles = [role0, "builder", "reviewer", "runner"];

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
            name={roles[i]}
            logo={logos[i]!}
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

// Preset A (default): 4th node is a second Claude Code instance.
export const S5TopologyVendors: React.FC = () => <TopologyVendorsBase logos={DEFAULT_LOGOS} />;
// Preset B: 4th node is OpenAI Codex — four distinct vendors.
export const S5TopologyVendorsCodex: React.FC = () => <TopologyVendorsBase logos={CODEX_LOGOS} />;
