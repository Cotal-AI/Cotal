// S2Shift — "The shift, into one shared space." Continuation of S1: a
// supervised tree (orchestrator over three workers) dissolves as Cotal drops
// every agent into one rounded shared space, then lateral peer wires light up
// and gold beams travel sideways — "anyone can reach anyone."
//
// 1920x1080 @ 30fps, 150-frame seamless loop.
//
//   Tree     ~0-30   orchestrator on top + three workers in a row, tree wires.
//   Dissolve ~30-75  orchestrator eases DOWN into the row (4th peer), tree wires
//                    fade, the SharedSpace boundary ripples + fades in.
//   Connect  ~70-135 lateral peer wires appear; nodes flip idle->working; gold
//                    beams travel sideways between peer pairs, staggered; nodes
//                    flash as beams arrive.

import React from "react";
import {
  AgentNode,
  BeamLine,
  bez,
  CreamStage,
  fade,
  interpolate,
  lerp,
  loopEnvelope,
  PresenceDot,
  prog,
  Ripple,
  SharedSpace,
  Subtitle,
  useCurrentFrame,
  WireLines,
  type Pt,
} from "../header/shared";

const DURATION = 150;

// --- layout (matches S1 for continuity) -----------------------------------------

const ORCH_TOP: Pt = { x: 960, y: 200 }; // orchestrator at the top of the tree
const WORKERS: Pt[] = [
  { x: 520, y: 560 },
  { x: 960, y: 560 },
  { x: 1360, y: 560 },
];
// Where the orchestrator settles: a 4th peer, left of the row, same y.
const ORCH_PEER: Pt = { x: 220, y: 560 };

// Eased orchestrator position over the dissolve: top -> into the row.
const orchAt = (drop: number): Pt => lerp(ORCH_TOP, ORCH_PEER, drop);

// Tree wires: orchestrator down to each worker (gentle vertical curl).
const treePath = (w: Pt): string => {
  const p0: Pt = { x: ORCH_TOP.x, y: ORCH_TOP.y + 52 };
  const p1: Pt = { x: w.x, y: w.y - 52 };
  const c1: Pt = { x: ORCH_TOP.x, y: lerp(p0, p1, 0.45).y };
  const c2: Pt = { x: w.x, y: lerp(p0, p1, 0.55).y };
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
};
const TREE_PATHS = WORKERS.map(treePath);

// Peers, left-to-right once the orchestrator has joined the row.
const PEERS: Pt[] = [ORCH_PEER, ...WORKERS];

// Lateral peer wires: a few edges (not a hairball). Adjacent neighbours are
// straight hairlines along the row; the far orchestrator<->worker3 pair bows up.
const lat = (from: Pt, to: Pt): [Pt, Pt] => [
  { x: from.x + 54, y: from.y },
  { x: to.x - 54, y: to.y },
];
const straightPath = (p0: Pt, p1: Pt): string => {
  const c1 = lerp(p0, p1, 0.4);
  const c2 = lerp(p0, p1, 0.6);
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
};

// edges: orch-w1, w1-w2, w2-w3 (chain) + orch-w3 (far arc) = reach anyone.
const [E01a, E01b] = lat(PEERS[0]!, PEERS[1]!);
const [E12a, E12b] = lat(PEERS[1]!, PEERS[2]!);
const [E23a, E23b] = lat(PEERS[2]!, PEERS[3]!);
const E03a: Pt = { x: PEERS[0]!.x + 30, y: PEERS[0]!.y - 40 };
const E03b: Pt = { x: PEERS[3]!.x - 30, y: PEERS[3]!.y - 40 };
const e03Ctrl: [Pt, Pt] = [
  { x: PEERS[0]!.x + 160, y: 430 },
  { x: PEERS[3]!.x - 160, y: 430 },
];
const arcPath = (p0: Pt, c1: Pt, c2: Pt, p1: Pt): string =>
  `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;

const E01_PATH = straightPath(E01a, E01b);
const E12_PATH = straightPath(E12a, E12b);
const E23_PATH = straightPath(E23a, E23b);
const E03_PATH = arcPath(E03a, e03Ctrl[0], e03Ctrl[1], E03b);
const LAT_PATHS = [E01_PATH, E12_PATH, E23_PATH, E03_PATH];

const e01Pos = (t: number): Pt => lerp(E01a, E01b, t);
const e12Pos = (t: number): Pt => lerp(E12a, E12b, t);
const e23Pos = (t: number): Pt => lerp(E23a, E23b, t);
const e03Pos = (t: number): Pt => bez(E03a, e03Ctrl[0], e03Ctrl[1], E03b, t);
const LAT_POS = [e01Pos, e12Pos, e23Pos, e03Pos];

// Which peers each edge touches (peer indices into PEERS), for arrival flashes.
const EDGE_ENDS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [0, 3],
];

// --- beat timing ----------------------------------------------------------------

const DISSOLVE = [30, 75] as const; // orchestrator drops, tree fades, space forms
// lateral beams, staggered (one per edge)
const LAT_BEAMS: [number, number][] = [
  [78, 104],
  [90, 116],
  [102, 128],
  [110, 136],
];

// soft flash from a beam: rises as it nears the target, then decays.
const arrival = (frame: number, from: number, to: number): number => {
  const span = to - from;
  const lead = to - span * 0.32;
  return fade(frame, lead, to) * (1 - fade(frame, to + 2, to + 26));
};

export const S2Shift: React.FC = () => {
  const frame = useCurrentFrame();

  // --- dissolve: orchestrator eases down, tree fades, space ripples in --------
  const drop = prog(frame, DISSOLVE[0], DISSOLVE[1]);
  const treeOpacity = interpolate(frame, DISSOLVE, [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // shared space fades in as the tree leaves, then holds.
  const spaceOpacity = fade(frame, DISSOLVE[0] + 8, DISSOLVE[1]);

  // --- connect: lateral wires + beams -----------------------------------------
  const tLat = LAT_BEAMS.map(([f, t]) => prog(frame, f, t));
  const latArrive = LAT_BEAMS.map(([f, t]) => arrival(frame, f, t));
  // lateral wires fade in just after the space forms, then hold to the end.
  const latStructure = fade(frame, DISSOLVE[1] - 8, DISSOLVE[1] + 6);

  // per-peer flash = max arrival over the edges that touch it.
  const peerFlash = PEERS.map((_p, pi) =>
    Math.max(
      0,
      ...EDGE_ENDS.map(([a, b], ei) =>
        a === pi || b === pi ? latArrive[ei]! : 0,
      ),
    ),
  );
  // peers go "working" once the space has formed and they are being reached.
  const peersLive = fade(frame, DISSOLVE[1] - 4, DISSOLVE[1] + 10);
  const peerStatus: ("idle" | "working")[] = PEERS.map((_p, pi) =>
    peersLive > 0.5 || peerFlash[pi]! > 0.12 ? "working" : "idle",
  );

  // lateral wire afterglow per edge.
  const latGlow = latArrive.map((g) => g * latStructure);

  // captions crossfade.
  const capOne = fade(frame, 18, 32) * (1 - fade(frame, 70, 82));
  const capTwo = fade(frame, 85, 99) * (1 - fade(frame, 140, 150));

  const rootOpacity = loopEnvelope(frame, DURATION);

  // orchestrator name shows only while it is the supervisor; once it drops into
  // the row it reads as another peer, "node-0".
  const orchPos = orchAt(drop);
  const orchName = drop < 0.5 ? "orch" : "node-0";
  const orchRole = drop < 0.5 ? "supervisor" : "peer";

  return (
    <CreamStage>
      <div style={{ position: "absolute", inset: 0, opacity: rootOpacity }}>
        {/* shared space boundary (forms during the dissolve, holds) */}
        <div style={{ opacity: spaceOpacity }}>
          <SharedSpace x={300} y={380} w={1320} h={380} label="space: demo" />
        </div>

        {/* tree wires (beat: tree) */}
        <div style={{ opacity: treeOpacity }}>
          <WireLines paths={TREE_PATHS} />
        </div>

        {/* lateral peer wires (beat: connect) */}
        <div style={{ opacity: latStructure }}>
          <WireLines paths={LAT_PATHS} glow={latGlow} />
        </div>

        {/* ripple as the space forms */}
        <Ripple at={{ x: 960, y: 570 }} p={prog(frame, DISSOLVE[0] + 4, DISSOLVE[0] + 42)} />
        <Ripple at={{ x: 960, y: 570 }} p={prog(frame, DISSOLVE[0] + 16, DISSOLVE[0] + 54)} />

        {/* orchestrator: top supervisor -> eases down into the row as 4th peer */}
        <AgentNode
          at={orchPos}
          name={orchName}
          role={orchRole}
          status={peerStatus[0]!}
          flash={peerFlash[0]!}
        />

        {/* workers / peers */}
        <AgentNode at={WORKERS[0]!} name="node-1" role="worker" status={peerStatus[1]!} flash={peerFlash[1]!} />
        <AgentNode at={WORKERS[1]!} name="node-2" role="worker" status={peerStatus[2]!} flash={peerFlash[2]!} />
        <AgentNode at={WORKERS[2]!} name="node-3" role="worker" status={peerStatus[3]!} flash={peerFlash[3]!} />

        {/* presence dots inside the space rail: every agent sees who's there */}
        <div style={{ opacity: spaceOpacity }}>
          {PEERS.map((p, pi) => (
            <PresenceDot
              key={pi}
              at={{ x: pi === 0 ? orchPos.x : p.x, y: 412 }}
              status={peerStatus[pi]!}
              size={13}
            />
          ))}
        </div>

        {/* lateral beams (beat: connect): peer -> peer, sideways, staggered */}
        {LAT_PATHS.map((d, i) => (
          <BeamLine
            key={`lat${i}`}
            d={d}
            pos={LAT_POS[i]!}
            t={tLat[i]!}
            visible={tLat[i]! > 0 && tLat[i]! < 1 && latStructure > 0.01}
          />
        ))}

        {/* captions (crossfade), kept clear of the diagram up top */}
        <Subtitle
          text="Cotal puts them in one shared space."
          opacity={capOne}
          place="top"
          offset={70}
          size={40}
        />
        <Subtitle
          text="Every agent sees who's there — and reaches anyone directly."
          opacity={capTwo}
          place="top"
          offset={70}
          size={40}
        />
      </div>
    </CreamStage>
  );
};
