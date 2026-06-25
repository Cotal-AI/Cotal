// HeaderMorph — "Up, then sideways": a topology morph that tells Cotal's core
// story (one protocol, any topology). 1280x400 @ 30fps, 240-frame seamless loop.
//
//   Beat A  ~0-90   supervised:   three agents wire UP to a manager pill; gold
//                                 beams travel up, staggered.
//   Beat B  ~90-175 peer-to-peer: the manager dissolves; the agents wire to
//                                 each other; beams travel sideways; a shared
//                                 space ripples open.
//   Beat C  ~175-240 resolve:     peers settle toward center; the wordmark and
//                                 tagline resolve and hold.

import React from "react";
import {
  AgentNode,
  BeamLine,
  bez,
  Caption,
  ChannelPill,
  CreamStage,
  fade,
  interpolate,
  lerp,
  loopEnvelope,
  prog,
  Ripple,
  useCurrentFrame,
  WireLines,
  Wordmark,
  type Pt,
} from "./shared";

const DURATION = 240;

// --- layout ---------------------------------------------------------------------

const MANAGER: Pt = { x: 640, y: 90 };
const ALICE: Pt = { x: 360, y: 280 };
const BOB: Pt = { x: 640, y: 280 };
const CAROL: Pt = { x: 920, y: 280 };
const AGENTS = [ALICE, BOB, CAROL];

// Up-wires: from just above each agent to just below the manager pill.
const UP_START = (a: Pt): Pt => ({ x: a.x, y: 235 });
const UP_END = (_a: Pt): Pt => ({ x: 640, y: 128 });
// Control points pull vertically so the wires rise straight then curl to centre.
const upCtrl = (a: Pt): [Pt, Pt] => [
  { x: a.x, y: 185 },
  { x: 640, y: 168 },
];
const upPath = (a: Pt): string => {
  const p0 = UP_START(a);
  const p1 = UP_END(a);
  const [c1, c2] = upCtrl(a);
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
};
const upPos = (a: Pt) => (t: number): Pt =>
  bez(UP_START(a), ...upCtrl(a), UP_END(a), t);

const UP_PATHS = AGENTS.map(upPath);

// Lateral wires between peers. Straight hairlines for adjacent neighbours, a
// gentle arc bowing downward for the far alice<->carol pair.
const lat = (from: Pt, to: Pt, dir: 1 | -1): Pt[] => {
  // start/end just inside each node edge along the row
  const a: Pt = { x: from.x + 54 * dir, y: from.y };
  const b: Pt = { x: to.x - 54 * dir, y: to.y };
  return [a, b];
};
const [AB0, AB1] = lat(ALICE, BOB, 1);
const [BC0, BC1] = lat(BOB, CAROL, 1);
// far arc: bow control points below the row
const AC0: Pt = { x: ALICE.x + 30, y: ALICE.y + 40 };
const AC1: Pt = { x: CAROL.x - 30, y: CAROL.y + 40 };
const acCtrl: [Pt, Pt] = [
  { x: ALICE.x + 130, y: 396 },
  { x: CAROL.x - 130, y: 396 },
];

const straightPath = (p0: Pt, p1: Pt): string => {
  const c1 = lerp(p0, p1, 0.4);
  const c2 = lerp(p0, p1, 0.6);
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
};
const arcPath = (p0: Pt, c1: Pt, c2: Pt, p1: Pt): string =>
  `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;

const AB_PATH = straightPath(AB0, AB1);
const BC_PATH = straightPath(BC0, BC1);
const AC_PATH = arcPath(AC0, acCtrl[0], acCtrl[1], AC1);

const abPos = (t: number): Pt => lerp(AB0, AB1, t);
const bcPos = (t: number): Pt => lerp(BC0, BC1, t);
const acPos = (t: number): Pt => bez(AC0, acCtrl[0], acCtrl[1], AC1, t);

// --- beat timing ---------------------------------------------------------------

const A = {
  // up-beams, staggered (alice, bob, carol)
  up: [
    [10, 34],
    [22, 46],
    [34, 58],
  ] as const,
};
const B = {
  managerOut: [90, 112] as const,
  // lateral beams, staggered (alice-bob, bob-carol, alice-carol)
  lat: [
    [108, 134],
    [120, 146],
    [132, 162],
  ] as const,
};
const C = {
  contract: [178, 222] as const,
};

// soft flash from a beam: rises as the beam nears its target, then decays.
const arrival = (frame: number, from: number, to: number): number => {
  const span = to - from;
  const lead = to - span * 0.32;
  return (
    fade(frame, lead, to) * (1 - fade(frame, to + 2, to + 26))
  );
};

export const HeaderMorph: React.FC = () => {
  const frame = useCurrentFrame();

  // --- beat A: supervised ------------------------------------------------------
  const tUp = A.up.map(([f, t]) => prog(frame, f, t));
  // each agent flashes as its up-beam reaches the manager / settles
  const upArrive = A.up.map(([f, t]) => arrival(frame, f, t));
  // manager pill glows while up-beams are arriving
  const pillReceive =
    Math.max(...A.up.map(([f, t]) => arrival(frame, f, t))) *
    (1 - fade(frame, B.managerOut[0], B.managerOut[1]));

  // manager + up-structure fade out across the A->B handoff
  const managerOpacity = interpolate(
    frame,
    [B.managerOut[0], B.managerOut[1]],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  // up-wires present in A, gone by mid-B
  const upStructure = managerOpacity;

  // --- beat B: peer-to-peer ----------------------------------------------------
  const tLat = B.lat.map(([f, t]) => prog(frame, f, t));
  const latArrive = B.lat.map(([f, t]) => arrival(frame, f, t));
  // lateral wires fade in as the manager leaves, out again as we resolve
  const latStructure =
    fade(frame, B.managerOut[0] + 2, B.managerOut[1] + 8) *
    (1 - fade(frame, C.contract[0] + 8, C.contract[1]));

  // per-agent flash: max of its up-arrival (A) and any lateral arrival (B)
  const agentFlash = [
    Math.max(upArrive[0]!, latArrive[0]!, latArrive[2]!), // alice: a-b, a-c
    Math.max(upArrive[1]!, latArrive[0]!, latArrive[1]!), // bob:   a-b, b-c
    Math.max(upArrive[2]!, latArrive[1]!, latArrive[2]!), // carol: b-c, a-c
  ];
  // a node reads "working" while it is actively lit
  const agentStatus: ("idle" | "working")[] = agentFlash.map((f) =>
    f > 0.12 ? "working" : "idle",
  );

  // --- beat C: resolve ---------------------------------------------------------
  const contract = prog(frame, C.contract[0], C.contract[1]);
  // peers contract gently toward centre + fade out under the wordmark
  const agentAt = AGENTS.map((a) => lerp(a, BOB, contract * 0.5));
  const agentDim = contract; // fade as the wordmark takes over

  // captions crossfade
  const capSupervised =
    fade(frame, 6, 18) * (1 - fade(frame, 88, 104));
  const capPeer =
    fade(frame, 100, 116) * (1 - fade(frame, 166, 178));

  // --- wire glow bundles -------------------------------------------------------
  const upGlow = upArrive.map((g) => g * upStructure);
  const latGlow = latArrive.map((g) => g * latStructure);

  // root loop envelope (fade in/out so the loop is seamless over the cream bg)
  const rootOpacity = loopEnvelope(frame, DURATION);

  return (
    <CreamStage>
      <div style={{ position: "absolute", inset: 0, opacity: rootOpacity }}>
        {/* up-wires (beat A) */}
        <div style={{ opacity: upStructure }}>
          <WireLines paths={UP_PATHS} glow={upGlow} />
        </div>

        {/* lateral wires (beat B) */}
        <div style={{ opacity: latStructure }}>
          <WireLines
            paths={[AB_PATH, BC_PATH, AC_PATH]}
            glow={latGlow}
          />
        </div>

        {/* shared-space ripples as the peer mesh forms */}
        <Ripple at={{ x: 640, y: 280 }} p={prog(frame, 95, 135)} />
        <Ripple at={{ x: 640, y: 280 }} p={prog(frame, 108, 150)} />

        {/* manager pill (beat A) */}
        <div style={{ opacity: managerOpacity }}>
          <ChannelPill at={MANAGER} label="manager" glow={pillReceive} />
        </div>

        {/* agents */}
        <AgentNode
          at={agentAt[0]!}
          name="alice"
          role="planner"
          status={agentStatus[0]!}
          flash={agentFlash[0]!}
          dimmed={agentDim}
        />
        <AgentNode
          at={agentAt[1]!}
          name="bob"
          role="builder"
          status={agentStatus[1]!}
          flash={agentFlash[1]!}
          dimmed={agentDim}
        />
        <AgentNode
          at={agentAt[2]!}
          name="carol"
          role="reviewer"
          status={agentStatus[2]!}
          flash={agentFlash[2]!}
          dimmed={agentDim}
        />

        {/* up-beams (beat A): agent -> manager */}
        {AGENTS.map((a, i) => (
          <BeamLine
            key={`up${i}`}
            d={UP_PATHS[i]!}
            pos={upPos(a)}
            t={tUp[i]!}
            visible={tUp[i]! > 0 && tUp[i]! < 1 && upStructure > 0.01}
          />
        ))}

        {/* lateral beams (beat B): peer -> peer */}
        <BeamLine
          d={AB_PATH}
          pos={abPos}
          t={tLat[0]!}
          visible={tLat[0]! > 0 && tLat[0]! < 1 && latStructure > 0.01}
        />
        <BeamLine
          d={BC_PATH}
          pos={bcPos}
          t={tLat[1]!}
          visible={tLat[1]! > 0 && tLat[1]! < 1 && latStructure > 0.01}
        />
        <BeamLine
          d={AC_PATH}
          pos={acPos}
          t={tLat[2]!}
          visible={tLat[2]! > 0 && tLat[2]! < 1 && latStructure > 0.01}
        />

        {/* phase captions (crossfade) */}
        <Caption text="supervised" opacity={capSupervised} top={28} />
        <Caption text="peer-to-peer" opacity={capPeer} top={28} />

        {/* resolve: wordmark + tagline */}
        <Wordmark
          frame={frame}
          appear={180}
          tagline="one protocol, any topology"
          size={78}
        />
      </div>
    </CreamStage>
  );
};
