// HeaderAssemble — "Connect them all".
//
// Six scattered agents fly in from off-frame, snap onto a shared ring, then a
// hairline mesh lights up with gold beams chasing around it; finally the nodes
// converge inward and the cotal wordmark resolves. A seamless cream/gold loop:
// it starts and ends on empty cream so frame 210 returns cleanly to frame 0.
//
// 210 frames @ 30fps. 1080x1080 square.
//
// Beats:
//   Gather   (0–60):   scattered nodes ease onto the ring + fade in, staggered.
//   Mesh     (60–135): hairline wires reveal; gold beams chase the ring + chords;
//                      nodes flash as light passes, some flip to "working".
//   Converge (135–195): nodes ease toward center + fade out; wordmark resolves.
//   Settle   (195–210): held empty cream so the loop returns to the start.

import React from "react";
import {
  AgentNode,
  BeamLine,
  CreamStage,
  Wordmark,
  WireLines,
  bez,
  fade,
  lerp,
  loopEnvelope,
  prog,
  useCurrentFrame,
  wirePath,
  type Pt,
} from "./shared";

const DURATION = 210;

// Composition center + the shared ring the agents snap onto.
const C: Pt = { x: 540, y: 540 };
const R = 300; // ring radius — keeps nodes + their labels well inside 1080.
const SCATTER_R = 760; // start radius: just off the visible square, per angle.

// Six agents, first node at top, then every 60° clockwise.
const CAST = [
  { name: "alice", role: "planner" },
  { name: "bob", role: "builder" },
  { name: "carol", role: "reviewer" },
  { name: "dave", role: "builder" },
  { name: "erin", role: "tester" },
  { name: "frank", role: "ops" },
] as const;

const N = CAST.length;

// Point on a circle of radius `rad` at the i-th agent's angle (i*60° − 90°).
const angleAt = (i: number): number => ((i * 60 - 90) * Math.PI) / 180;
const onCircle = (i: number, rad: number): Pt => ({
  x: C.x + rad * Math.cos(angleAt(i)),
  y: C.y + rad * Math.sin(angleAt(i)),
});

const RING: Pt[] = CAST.map((_, i) => onCircle(i, R));
const SCATTER: Pt[] = CAST.map((_, i) => onCircle(i, SCATTER_R));

// --- mesh geometry: ring edges + a few chords across the circle ---------------

// Adjacent-node ring edges (the hexagon outline): 0-1, 1-2, … 5-0.
const RING_EDGES: [number, number][] = CAST.map((_, i) => [i, (i + 1) % N]);
// Chords across the circle for depth — the three long diagonals.
const CHORDS: [number, number][] = [
  [0, 3],
  [1, 4],
  [2, 5],
];
const EDGES: [number, number][] = [...RING_EDGES, ...CHORDS];

// Pull each wire slightly toward the center so the ring edges bow inward and the
// chords pass cleanly through the middle — softer than straight lines.
const ctrlFor = (a: Pt, b: Pt): [Pt, Pt] => {
  const c1 = lerp(lerp(a, b, 0.33), C, 0.14);
  const c2 = lerp(lerp(a, b, 0.67), C, 0.14);
  return [c1, c2];
};

// Endpoints sit on each node's rim (toward the partner), not its center, so the
// hairlines meet the rounded squares rather than spear through them.
const rim = (from: Pt, to: Pt): Pt => lerp(from, to, 0.18);

const WIRE_PATHS: string[] = EDGES.map(([a, b]) => {
  const p0 = rim(RING[a]!, RING[b]!);
  const p1 = rim(RING[b]!, RING[a]!);
  return wirePath(p0, ...ctrlFor(p0, p1), p1);
});

// Per-edge beam: walk along the same curve as the wire.
const beamPos = (a: number, b: number) => {
  const p0 = rim(RING[a]!, RING[b]!);
  const p1 = rim(RING[b]!, RING[a]!);
  const [c1, c2] = ctrlFor(p0, p1);
  return (t: number): Pt => bez(p0, c1, c2, p1, t);
};

// Beam timing: light travels around the ring edge-by-edge, then the chords flash
// together. Each beam reveals over BEAM_DUR frames from its own start.
const MESH_START = 60;
const BEAM_DUR = 22;
const RING_STAGGER = 9; // frames between consecutive ring edges igniting.
const ringStart = (i: number): number => MESH_START + i * RING_STAGGER;
const chordStart = MESH_START + N * RING_STAGGER - 6; // chords fire near the end.

export const HeaderAssemble: React.FC = () => {
  const frame = useCurrentFrame();

  // --- per-edge wire afterglow (rests gold once a beam has crossed it) --------
  const glow: number[] = EDGES.map((_, i) => {
    const isChord = i >= RING_EDGES.length;
    const s = isChord ? chordStart : ringStart(i);
    // ramp up as the beam reveals, then ease back to ink before converge starts.
    const up = prog(frame, s, s + BEAM_DUR);
    const down = 1 - prog(frame, 128, 138);
    return up * down;
  });

  // Per-node flash: pops when a beam arrives at it (end of an incident edge).
  const flashAt = (node: number): number => {
    // ring edges land on node (i+1)%N at the end of edge i; also the previous
    // edge departs from it — use whichever incident edge completes nearest.
    const incoming = (node - 1 + N) % N; // edge that ends at this node
    const arrive = ringStart(incoming) + BEAM_DUR;
    return Math.max(0, 1 - fade(frame, arrive - 2, arrive + 16));
  };

  return (
    <CreamStage>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: loopEnvelope(frame, DURATION),
        }}
      >
        {/* Mesh hairlines — only present once gathering is essentially done. */}
        {frame >= MESH_START - 6 && frame < 150 ? (
          <WireLines paths={WIRE_PATHS} glow={glow} />
        ) : null}

        {/* Agents: scatter -> ring (gather), hold (mesh), ring -> center (converge). */}
        {CAST.map((a, i) => {
          // Gather: ease from scatter point onto the ring, staggered per node.
          const gather = prog(frame, i * 3, 60);
          const arrived = lerp(SCATTER[i]!, RING[i]!, gather);
          // Converge: ease from the ring inward to center.
          const converge = prog(frame, 135, 190);
          const at = lerp(arrived, C, converge);

          // Fade in during gather (staggered), fade out during converge.
          const inOp = fade(frame, i * 4, i * 4 + 28);
          const outOp = 1 - fade(frame, 150, 185);
          const op = inOp * outOp;

          // Alternate builders/testers flip to "working" as the mesh lights up.
          const working = i % 2 === 1 && frame >= ringStart(i) + BEAM_DUR;

          return (
            <div key={a.name} style={{ opacity: op }}>
              <AgentNode
                at={at}
                name={a.name}
                role={a.role}
                status={working ? "working" : "idle"}
                flash={frame >= MESH_START ? flashAt(i) : 0}
              />
            </div>
          );
        })}

        {/* Gold beams chasing around the ring, then the chords across it. */}
        {EDGES.map(([a, b], i) => {
          const isChord = i >= RING_EDGES.length;
          const s = isChord ? chordStart : ringStart(i);
          const t = prog(frame, s, s + BEAM_DUR);
          return (
            <BeamLine
              key={`beam-${i}`}
              d={WIRE_PATHS[i]!}
              pos={beamPos(a, b)}
              t={t}
              visible={t > 0 && t < 1}
            />
          );
        })}

        {/* Closing wordmark resolves as the nodes converge into the center. */}
        <Wordmark frame={frame} appear={150} tagline="connect them all" size={96} />
      </div>
    </CreamStage>
  );
};
