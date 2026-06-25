// S3Modes — "Three ways to address — one model." The how-it-works beat: one
// shared cast (alice/planner left, a #general channel pill at center, and three
// peers on the right) addressed three different ways without ever changing the
// space. A persistent top caption holds while three 70-frame beats cross-fade
// the connection types and replay their signature motions, compactly:
//
//   multicast 0-70    alice -> #general -> fan-out beams to all three peers,
//                     a ripple at the pill; everyone receives.
//   unicast   70-140  a single direct, durable beam alice -> bob; the other two
//                     peers dim — message one, durably.
//   anycast   140-210 alice addresses a role; exactly one FREE peer (carol)
//                     claims it (beam to carol, carol flips idle->working), the
//                     rest dim — any one of a role claims it.
//
// 1920x1080 @ 30fps, exactly 210 frames, seamless via loopEnvelope.

import React from "react";
import {
  AgentNode,
  BeamLine,
  bez,
  ChannelPill,
  CreamStage,
  fade,
  GoldDot,
  lerp,
  loopEnvelope,
  prog,
  Ripple,
  Subtitle,
  useCurrentFrame,
  WireLines,
  type Pt,
} from "../header/shared";

const DURATION = 210;

// --- beats ----------------------------------------------------------------------

const B1 = [0, 70] as const; // multicast
const B2 = [70, 140] as const; // unicast
const B3 = [140, 210] as const; // anycast

// --- layout ---------------------------------------------------------------------

const ALICE: Pt = { x: 420, y: 560 };
const PILL: Pt = { x: 960, y: 470 };
const PEERS: Pt[] = [
  { x: 1460, y: 380 }, // bob, builder (busy)
  { x: 1460, y: 560 }, // carol, reviewer (free -> claims in anycast)
  { x: 1460, y: 740 }, // dave, builder (busy)
];
const CAST = [
  { name: "bob", role: "builder", status: "working" },
  { name: "carol", role: "reviewer", status: "idle" },
  { name: "dave", role: "builder", status: "working" },
] as const;
const CLAIMER = 1; // carol is the free peer who claims the anycast role

// --- wires ----------------------------------------------------------------------

const cubicPath = (p0: Pt, c1: Pt, c2: Pt, p1: Pt): string =>
  `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;

// alice -> pill (the post into the channel): a gentle hairline.
const IN_START: Pt = { x: ALICE.x + 56, y: ALICE.y };
const IN_END: Pt = { x: PILL.x - 104, y: PILL.y };
const IN_PATH = cubicPath(IN_START, lerp(IN_START, IN_END, 0.4), lerp(IN_START, IN_END, 0.6), IN_END);
const inPos = (t: number): Pt => lerp(IN_START, IN_END, t);

// pill -> each peer (the fan-out), bowed so the three read as a spray.
const OUT_START: Pt = { x: PILL.x + 104, y: PILL.y };
const outCtrl = (r: Pt): [Pt, Pt] => [
  { x: OUT_START.x + 150, y: OUT_START.y },
  { x: r.x - 150, y: r.y },
];
const OUT_END = (r: Pt): Pt => ({ x: r.x - 56, y: r.y });
const OUT_PATHS = PEERS.map((r) => cubicPath(OUT_START, outCtrl(r)[0], outCtrl(r)[1], OUT_END(r)));
const outPos = (r: Pt) => (t: number): Pt =>
  bez(OUT_START, outCtrl(r)[0], outCtrl(r)[1], OUT_END(r), t);

// alice -> bob, a direct point-to-point route (unicast), no hub; it arcs over
// the channel so it reads as a separate, dedicated lane.
const DIRECT_START: Pt = { x: ALICE.x + 50, y: ALICE.y - 16 };
const DIRECT_END: Pt = { x: PEERS[0]!.x - 50, y: PEERS[0]!.y + 14 };
const DIRECT_CTRL: [Pt, Pt] = [
  { x: lerp(DIRECT_START, DIRECT_END, 0.4).x, y: 430 },
  { x: lerp(DIRECT_START, DIRECT_END, 0.6).x, y: 360 },
];
const DIRECT_PATH = cubicPath(DIRECT_START, DIRECT_CTRL[0], DIRECT_CTRL[1], DIRECT_END);
const directPos = (t: number): Pt =>
  bez(DIRECT_START, DIRECT_CTRL[0], DIRECT_CTRL[1], DIRECT_END, t);

// --- helpers --------------------------------------------------------------------

// a soft arrival flash that rises as a beam nears its target, then decays.
const arrival = (frame: number, from: number, to: number): number =>
  fade(frame, to - (to - from) * 0.34, to) * (1 - fade(frame, to + 2, to + 24));

// emit pulse on the sender right after it fires.
const emitPulse = (frame: number, at: number): number =>
  frame >= at ? Math.max(0, 1 - fade(frame, at, at + 20)) : 0;

export const S3Modes: React.FC = () => {
  const frame = useCurrentFrame();
  const rootOpacity = loopEnvelope(frame, DURATION);

  // which beat are we in, for global dimming of the header while a beat runs.
  const inB1 = frame < B2[0];
  const inB2 = frame >= B2[0] && frame < B3[0];

  // ------------------------------------------------------------------ beat 1
  // multicast: alice -> pill -> fan to all three peers + ripple at pill.
  const m_send = [B1[0] + 8, B1[0] + 30] as const;
  const m_fan = [B1[0] + 34, B1[0] + 56] as const;
  const m_tIn = prog(frame, m_send[0], m_send[1]);
  const m_tOut = prog(frame, m_fan[0], m_fan[1]);
  const m_emit = emitPulse(frame, m_send[0]);
  const m_pillGlow =
    fade(frame, m_send[1] - 6, m_send[1] + 4) * (1 - fade(frame, B2[0] - 14, B2[0]));
  const m_flash = arrival(frame, m_fan[0], m_fan[1]);
  const m_inGlow =
    fade(frame, m_send[1] - 4, m_send[1]) * (1 - fade(frame, m_fan[0] + 6, m_fan[1]));
  const m_outGlow = m_flash;
  // beat fades out at its tail so it does not bleed into unicast.
  const m_vis = 1 - fade(frame, B2[0] - 12, B2[0]);

  // ------------------------------------------------------------------ beat 2
  // unicast: a single durable beam alice -> bob; the other peers dim.
  const u_send = [B2[0] + 12, B2[0] + 46] as const;
  const u_tDirect = prog(frame, u_send[0], u_send[1]);
  const u_emit = emitPulse(frame, u_send[0]);
  const u_flash = arrival(frame, u_send[0], u_send[1]);
  const u_glow =
    fade(frame, u_send[0] + 6, u_send[1]) * (1 - fade(frame, B3[0] - 16, B3[0]));
  const u_vis =
    fade(frame, B2[0] - 6, B2[0] + 6) * (1 - fade(frame, B3[0] - 12, B3[0]));
  // others (carol, dave) dim while the direct message is in flight / landed.
  const u_dimOthers = u_vis;

  // ------------------------------------------------------------------ beat 3
  // anycast: alice addresses a role; one FREE peer (carol) claims it.
  const a_send = [B3[0] + 10, B3[0] + 32] as const;
  const a_claim = [B3[0] + 36, B3[0] + 60] as const;
  const a_tIn = prog(frame, a_send[0], a_send[1]);
  const a_tClaim = prog(frame, a_claim[0], a_claim[1]);
  const a_emit = emitPulse(frame, a_send[0]);
  const a_pillGlow = fade(frame, a_send[1] - 6, a_send[1] + 4) * (1 - fade(frame, a_claim[0], a_claim[1]));
  const a_inGlow =
    fade(frame, a_send[1] - 4, a_send[1]) * (1 - fade(frame, a_claim[0], a_claim[1]));
  const a_claimFlash = arrival(frame, a_claim[0], a_claim[1]);
  const a_claimGlow = a_claimFlash;
  const a_vis = fade(frame, B3[0] - 6, B3[0] + 6);
  // probing breath at the pill between "sent" and "claimed".
  const a_probing = frame >= a_send[1] && frame < a_claim[0];
  const a_breath = a_probing
    ? 0.5 + 0.5 * Math.sin(((frame - a_send[1]) / 18) * Math.PI * 2)
    : 0;
  // carol flips idle->working once she claims; bob/dave stay dimmed.
  const a_carolWorking = frame >= a_claim[1];
  const a_dimOthers = a_vis * (a_probing || a_tClaim > 0 ? 1 : fade(frame, a_send[0], a_send[1]));

  // ----------------------------------------------------------- per-peer state
  // status + flash + dim folded across the three beats.
  const peerStatus: ("idle" | "working")[] = CAST.map((c, i) => {
    if (inB1) return c.status;
    if (inB2) return c.status; // unicast leaves presence unchanged
    // anycast: carol becomes working on claim; others keep their base status.
    if (i === CLAIMER) return a_carolWorking ? "working" : "idle";
    return c.status;
  });
  const peerFlash = CAST.map((_c, i) => {
    let f = 0;
    if (m_vis > 0.01) f = Math.max(f, m_flash * m_vis); // all flash in multicast
    if (i === 0) f = Math.max(f, u_flash * u_vis); // bob flashes in unicast
    if (i === CLAIMER) f = Math.max(f, a_claimFlash * a_vis); // carol in anycast
    return f;
  });
  const peerDim = CAST.map((_c, i) => {
    let d = 0;
    if (i !== 0) d = Math.max(d, u_dimOthers); // unicast: non-bob dim
    if (i !== CLAIMER) d = Math.max(d, a_dimOthers); // anycast: non-carol dim
    return d;
  });

  // ----------------------------------------------------------- wire structure
  // resting hairlines stay; glow per beat. In/out wires are the channel routes;
  // the direct wire is the unicast route.
  const wireGlow = [
    m_inGlow * m_vis, // IN_PATH (alice->pill) during multicast
    Math.max(m_outGlow * m_vis, a_inGlow * a_vis), // reuse for pill structure cue
  ];

  // ------------------------------------------------------------ captions
  const cap1 = fade(frame, B1[0] + 6, B1[0] + 20) * (1 - fade(frame, B2[0] - 12, B2[0]));
  const cap2 = fade(frame, B2[0] + 4, B2[0] + 18) * (1 - fade(frame, B3[0] - 12, B3[0]));
  const cap3 = fade(frame, B3[0] + 4, B3[0] + 18) * (1 - fade(frame, DURATION - 12, DURATION));

  // header dims slightly while a beat's bottom caption is up.
  const headerOp = 1 - 0.25 * Math.max(cap1, cap2, cap3);

  return (
    <CreamStage>
      <div style={{ position: "absolute", inset: 0, opacity: rootOpacity }}>
        {/* persistent header caption */}
        <Subtitle
          place="top"
          text="Three ways to address — one model."
          opacity={headerOp}
          offset={64}
          size={40}
        />

        {/* resting wires: channel routes (in + fan) always present, direct route
            only reads during unicast. */}
        <WireLines paths={[IN_PATH, ...OUT_PATHS]} glow={wireGlow} />
        <div style={{ opacity: u_vis }}>
          <WireLines paths={[DIRECT_PATH]} glow={[u_glow]} />
        </div>

        {/* multicast ripple at the pill */}
        <div style={{ opacity: m_vis }}>
          <Ripple at={PILL} p={prog(frame, m_fan[0] - 2, m_fan[0] + 30)} />
          <Ripple at={PILL} p={prog(frame, m_fan[0] + 10, m_fan[0] + 44)} />
        </div>

        {/* the cast: one shared space across all three beats */}
        <AgentNode
          at={ALICE}
          name="alice"
          role="planner"
          status="working"
          flash={Math.max(m_emit * m_vis, u_emit * u_vis, a_emit * a_vis)}
        />
        <ChannelPill at={PILL} label="#general" glow={Math.max(m_pillGlow * m_vis, a_pillGlow * a_vis)} />
        {CAST.map((c, i) => (
          <AgentNode
            key={c.name}
            at={PEERS[i]!}
            name={c.name}
            role={c.role}
            status={peerStatus[i]!}
            flash={peerFlash[i]!}
            dimmed={peerDim[i]!}
          />
        ))}

        {/* beat 1 — multicast beams: alice -> pill, then pill -> all peers */}
        <div style={{ opacity: m_vis }}>
          <BeamLine d={IN_PATH} pos={inPos} t={m_tIn} visible={m_tIn > 0 && m_tIn < 1} />
          {PEERS.map((r, i) => (
            <BeamLine
              key={`m${i}`}
              d={OUT_PATHS[i]!}
              pos={outPos(r)}
              t={m_tOut}
              visible={m_tOut > 0 && m_tOut < 1}
            />
          ))}
        </div>

        {/* beat 2 — unicast: a single direct beam alice -> bob */}
        <div style={{ opacity: u_vis }}>
          <BeamLine
            d={DIRECT_PATH}
            pos={directPos}
            t={u_tDirect}
            visible={u_tDirect > 0 && u_tDirect < 1}
          />
        </div>

        {/* beat 3 — anycast: alice -> pill (role), then one beam to carol */}
        <div style={{ opacity: a_vis }}>
          <BeamLine d={IN_PATH} pos={inPos} t={a_tIn} visible={a_tIn > 0 && a_tIn < 1} />
          {a_probing && <GoldDot at={PILL} breath={a_breath} />}
          <BeamLine
            d={OUT_PATHS[CLAIMER]!}
            pos={outPos(PEERS[CLAIMER]!)}
            t={a_tClaim}
            visible={a_tClaim > 0 && a_tClaim < 1}
          />
        </div>

        {/* anycast wire afterglow on the claimed route */}
        <div style={{ opacity: a_vis }}>
          <WireLines paths={[OUT_PATHS[CLAIMER]!]} glow={[a_claimGlow]} />
        </div>

        {/* bottom captions, one per beat, cross-faded */}
        <Subtitle text="multicast" sub="broadcast to a channel" opacity={cap1} />
        <Subtitle text="unicast" sub="message one, durably" opacity={cap2} />
        <Subtitle text="anycast" sub="any one of a role claims it" opacity={cap3} />
      </div>
    </CreamStage>
  );
};
