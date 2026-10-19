// Unicast: alice addresses bob directly. The same cast is present (carol free,
// dave busy); bob is busy, so the message parks durably in his inbox and
// delivers the moment he frees up. Unicast is point-to-point, so there is no
// shared hub at center: the inbox lives on the direct route to bob, its owner.
// Loops seamlessly at UNICAST_DURATION.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Beam,
  Card,
  CARD_TYPE,
  Dot,
  fade,
  GOLD,
  INK,
  Labels,
  lerp,
  MODE_ALICE,
  MODE_PEERS,
  NODE_R,
  prog,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

// The inbox's half-size (the slot is INBOX_R*2 on a side).
const INBOX_R = 36;
// How far a wire end stops short of the box it meets.
const WIRE_GAP = 3;

// Where the straight route from `p` toward `to` leaves the square of half-size `r`
// centered on `p`, plus the gap, so the wire ends meet the box edges wherever the
// cast puts alice and bob.
function leave(p: Pt, to: Pt, r: number): Pt {
  return lerp(p, to, (r + WIRE_GAP) / Math.max(Math.abs(to.x - p.x), Math.abs(to.y - p.y)));
}

const T = {
  sendStart: 14,
  sendEnd: 48,
  bobFrees: 78,
  deliverStart: 86,
  deliverEnd: 116,
  flashEnd: 140,
  bobBack: 152,
};

export const UNICAST_DURATION = 168;

export const ModeUnicast: React.FC = () => {
  const frame = useCurrentFrame();
  // bob is the addressee, picked by name so reordering the shared cast cannot move
  // the delivery to another peer; the others are present but unaddressed. Checked
  // here, not at import: Root imports every card, so a module-scope throw would
  // also refuse the cards that never address bob.
  const bob = MODE_PEERS.find((p) => p.name === "bob");
  if (!bob) throw new Error("the unicast card's addressee bob is not in MODE_PEERS");
  // the inbox sits on the alice -> bob route, midway
  const inbox = lerp(MODE_ALICE.at, bob.at, 0.5);
  const seg1: [Pt, Pt] = [leave(MODE_ALICE.at, bob.at, NODE_R), leave(inbox, MODE_ALICE.at, INBOX_R)];
  const seg2: [Pt, Pt] = [leave(inbox, bob.at, INBOX_R), leave(bob.at, MODE_ALICE.at, NODE_R)];
  const path1 = wirePath(seg1[0], lerp(...seg1, 0.4), lerp(...seg1, 0.6), seg1[1]);
  const path2 = wirePath(seg2[0], lerp(...seg2, 0.4), lerp(...seg2, 0.6), seg2[1]);

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.deliverStart, T.deliverEnd);

  const parked = frame >= T.sendEnd && frame < T.deliverStart;
  const breath = parked ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 26) * Math.PI * 2) : 0;

  const bobStatus: "idle" | "working" =
    frame < T.bobFrees ? "working" : frame < T.bobBack ? "idle" : "working";
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;
  const deliverFlash =
    frame >= T.deliverEnd ? Math.max(0, 1 - fade(frame, T.deliverEnd, T.flashEnd)) : 0;
  // a quiet ripple of life when bob frees up, so the state change registers
  const freeFlash =
    frame >= T.bobFrees ? 0.4 * Math.max(0, 1 - fade(frame, T.bobFrees, T.bobFrees + 16)) : 0;

  // wire afterglow: seg1 gold while it holds, seg2 gold as it delivers
  const glow1 = fade(frame, T.sendEnd - 4, T.sendEnd) * (1 - fade(frame, T.deliverStart, T.deliverEnd));
  const glow2 = deliverFlash;

  return (
    <Card>
      <Wires paths={[path1, path2]} glow={[glow1, glow2]} />

      <AgentNode {...MODE_ALICE} flash={emit} type={CARD_TYPE} />
      <AgentNode {...bob} status={bobStatus} flash={Math.max(deliverFlash, freeFlash)} type={CARD_TYPE} />
      {MODE_PEERS.filter((p) => p !== bob).map((p) => (
        <AgentNode key={p.name} {...p} type={CARD_TYPE} />
      ))}

      {/* durable inbox: a rounded slot matching the node language; gold while it holds */}
      <div
        style={{
          position: "absolute",
          left: inbox.x - INBOX_R,
          top: inbox.y - INBOX_R,
          width: INBOX_R * 2,
          height: INBOX_R * 2,
          borderRadius: 20,
          border: `1.5px solid ${parked ? GOLD : INK.ring}`,
          background: INK.fill,
          boxShadow: parked
            ? `0 0 18px 1px rgba(199,154,74,${0.12 + 0.1 * breath})`
            : "0 1px 2px rgba(40,34,20,0.05)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: inbox.x - 70 * CARD_TYPE,
          top: inbox.y + 48,
          width: 140 * CARD_TYPE,
          textAlign: "center",
          fontSize: 20 * CARD_TYPE,
          color: INK.dim,
          letterSpacing: 0.3 * CARD_TYPE,
        }}
      >
        inbox
      </div>

      {parked ? (
        <Dot at={inbox} breath={breath} />
      ) : (
        <>
          <Beam d={path1} pos={(t) => lerp(...seg1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
          <Beam d={path2} pos={(t) => lerp(...seg2, t)} t={t2} visible={t2 > 0 && t2 < 1} />
        </>
      )}

      <Labels mode="unicast" caption="deliver to one, durably" subject={`cotal.demo.inst.${bob.name}`} type={CARD_TYPE} />
    </Card>
  );
};
