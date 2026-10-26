import React, { useEffect, useState } from "react";
import { AbsoluteFill, Easing, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame } from "remotion";
import { loadFont as loadDisplay } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadSans } from "@remotion/google-fonts/Geist";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";

// The forum booth's type: Bricolage Grotesque for display, Geist for text.
const DISPLAY = loadDisplay("normal", { weights: ["800"], subsets: ["latin"] }).fontFamily;
const SANS = loadSans("normal", { weights: ["500", "600"], subsets: ["latin"] }).fontFamily;
const MONO = loadMono("normal", { weights: ["600"], subsets: ["latin"] }).fontFamily;

const W = 1200;
const H = 676;
const FPS = 25;
// The beats below are written on a LOOP-step timeline; PACE stretches it into real frames.
const LOOP = 340;
const PACE = 1.2;
const FRAMES = Math.round(LOOP * PACE);
const NAVY = "#202B43";
const CREAM = "#FFFCEE";
const WHITE = "#FFFFFF";
const DIM = "#6B6F80";
const RULE = "rgba(32,43,67,.14)";
const BLUE = "#4D69E6";
const ORANGE = "#E38C6E";
const GREEN = "#5FA866";
const GOLD = "#E5B94E";

type Pt = [number, number];
type Art = {
  character: (o: Record<string, unknown>) => string;
  hand: (type: string, at: Pt, deg: number, s: number) => string;
  MARK_PATHS: string[];
  RING: { blue: string; yellow: string; orange: string };
};
declare global { interface Window { CotalArt: Art } }

// Decelerate into place, accelerate out of frame, never linear for travel.
const OUT = Easing.bezier(0.2, 0, 0, 1);
const DECEL = Easing.bezier(0.05, 0.7, 0.1, 1);
const ACCEL = Easing.bezier(0.3, 0, 1, 1);
const INOUT = Easing.bezier(0.45, 0, 0.55, 1);
const ramp = (f: number, a: number, b: number, easing: (t: number) => number = OUT) =>
  interpolate(f, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const springAt = (f: number, start: number, damping = 12, stiffness = 180, mass = 0.7) =>
  f < start ? 0 : spring({ frame: f - start, fps: FPS, config: { damping, stiffness, mass } });
const quad = (a: Pt, c: Pt, b: Pt, t: number): Pt => [
  (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
  (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1],
];
// Ambient periods divide LOOP, so the last frame flows into the first.
const wave = (f: number, period: number, phase = 0) => Math.sin((2 * Math.PI * f) / period + phase);
const scaleAbout = (cx: number, cy: number, s: number) => `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`;

// Every beat of the loop, in timeline steps (25 per second before PACE).
const T = {
  wordOut: 3, perchOff: 5, ringsOut: 7, windows: 18, h1: 22,
  note1Up: 36, cursorIn: 40, grab1: 46, drop1: 62,
  note2Up: 72, grab2: 78, drop2: 90,
  toSpace: 98, panel: 104, h2: 106,
  c1: 124, c2: 148, c3: 172, fixed: 196,
  ask: 204, h3: 208, card: 208, click: 226, cheer: 229,
  outro: 242, leap: 244, ringsIn: 250, blueDrop: 258, blueLand: 265, perch: [272, 275, 278], word: 283,
};

// ---------- the Cotal mark, laid out for the end card ----------
const MS = 300 / 117.165;
const MX = 230;
const MY = 226;
const X0 = 185.197;
const Y0 = 128.504;
const markPx = ([u, v]: Pt): Pt => [MX + (u - X0) * MS, MY + (v - Y0) * MS];
const RING_C: Pt[] = [[243.78, 166], [225.52, 197.63], [262.04, 197.63]];
const RING_PX = RING_C.map(markPx);
const R_OUT = 32.69 * MS;
const R_MID = 28.83 * MS;
const WORD_X = 560;

// ---------- the cast ----------
const VENDORS = ["claude", "opencode", "codex"] as const;
const NAMES = ["Claude Code", "OpenCode", "Codex"];
const HOSTS = ["laptop", "cloud VM", "laptop"];
// Where each body's left and right edges are, in its 116-unit box.
const SHOULDER: Pt[] = [[20, 80], [8, 92], [14, 86]];

type Spot = { x: number; g: number; w: number; rot: number };
type Arm = { from: Pt; via: Pt; to?: Pt; toAbs?: Pt; hand: string; deg: number | "auto"; size?: number; mirror?: boolean; grow: number };

// The perches from the forum poster: Claude Code on the top ring, OpenCode and Codex on the lower two.
const PERCH: Spot[] = (() => {
  const unit = MS / 0.62;
  const ws = [16, 18.5, 17].map((w) => w * unit * 1.2);
  const onRing = (c: Pt, deg: number): Pt => {
    const a = (deg * Math.PI) / 180, r = R_MID + 1.2 * unit;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  };
  const blue = RING_PX[0];
  const centres: Pt[] = [[blue[0], blue[1] - R_MID - ws[0] * 0.82 + ws[0] / 2], onRing(RING_PX[1], -170), onRing(RING_PX[2], -30)];
  return centres.map(([x, cy], i) => ({ x, g: cy + 44 * (ws[i] / 116), w: ws[i], rot: [0, -10, 9][i] }));
})();
const PERCH_LOOK: Pt[] = [[-2.6, 0], [2, -2], [-2, -2]];
const ringPoint = (c: Pt, deg: number): Pt => [c[0] + R_MID * Math.cos((deg * Math.PI) / 180), c[1] + R_MID * Math.sin((deg * Math.PI) / 180)];
const perchArms = (i: number, f: number, grow: number): Arm[] => ([
  [
    { from: [22, 68], via: [4, 74], toAbs: ringPoint(RING_PX[0], -114), hand: "fist", deg: "auto", grow },
    { from: [80, 58], via: [104, 58], to: [114, 30], hand: "open", deg: 28 + 14 * wave(f, 20), grow },
  ],
  [
    { from: [8, 62], via: [-10, 72], to: [-14, 56], hand: "thumb", deg: 4, grow },
    { from: [92, 62], via: [122, 68], to: [98, 84], hand: "fist", deg: "auto", size: 0.9, grow },
  ],
  [
    { from: [86, 54], via: [120, 54], to: [91, 33], hand: "flat", deg: -68, grow },
    { from: [14, 60], via: [-18, 68], to: [6, 84], hand: "fist", deg: "auto", size: 0.9, grow },
  ],
] as Arm[][])[i];

const WIN: Spot[] = [250, 600, 950].map((x) => ({ x, g: 462, w: 116, rot: 0 }));
const SPACE: Spot[] = [300, 600, 900].map((x) => ({ x, g: 478, w: 128, rot: 0 }));
const WY = 196;
const WH = 300;

// Gestures. Arms only appear when a character does something with its hands.
const holdUp = (i: number, grow: number): Arm => { const r = SHOULDER[i][1]; return { from: [r, 60], via: [r + 26, 64], to: [r + 32, 30], hand: "fist", deg: 12, grow }; };
const raiseHand = (i: number, grow: number, f: number): Arm => { const r = SHOULDER[i][1]; return { from: [r, 56], via: [r + 30, 50], to: [r + 34, 12], hand: "open", deg: 16 + 16 * wave(f, 10), grow }; };
const cheerArms = (i: number, grow: number): Arm[] => {
  const [l, r] = SHOULDER[i];
  return [
    { from: [r, 58], via: [r + 26, 50], to: [r + 36, 16], hand: "open", deg: 24, grow },
    { from: [l, 58], via: [l - 26, 50], to: [l - 36, 16], hand: "open", deg: -24, mirror: true, grow },
  ];
};
const thumbUp = (grow: number): Arm => ({ from: [8, 62], via: [-10, 72], to: [-14, 56], hand: "thumb", deg: 4, grow });

// Hops between spots. A jump with t0 === t1 moves the character off screen without a landing.
type Jump = { t0: number; t1: number; to: Spot; h: number; yEase?: (t: number) => number };
const JUMPS: Jump[][] = [0, 1, 2].map((i) => {
  const d = 2 * i;
  return [
    { t0: T.perchOff + 3 + d, t1: T.perchOff + 15 + d, to: WIN[i], h: 70 },
    { t0: T.toSpace + 4 + d, t1: T.toSpace + 15 + d, to: SPACE[i], h: 60 },
    { t0: T.cheer + d, t1: T.cheer + 10 + d, to: SPACE[i], h: 46 },
    { t0: T.leap + d, t1: T.leap + 7 + d, to: { ...SPACE[i], g: -150 }, h: 0, yEase: OUT },
    { t0: T.perch[i], t1: T.perch[i], to: { ...PERCH[i], g: -160 }, h: 0 },
    { t0: T.perch[i], t1: T.perch[i] + 7, to: PERCH[i], h: 0, yEase: ACCEL },
  ];
});

const BUMPS: number[][] = [[170], [T.drop1, 146, 192], [T.drop2, 149, 171]];
const BLINKS: number[][] = [[58, 118, 188, 300, 330], [44, 112, 178, 312], [66, 140, 222, 322]];
// While waiting on you: a slow sigh with closed eyes.
const SIGHS: number[][] = [[74], [48], [64]];
const TALK: Pt[][] = [[[T.c1, T.c1 + 12]], [[T.c2, T.c2 + 12], [T.fixed + 2, T.fixed + 10]], [[T.c3, T.c3 + 12], [T.ask + 2, T.ask + 12]]];
const MOODS: [number, string][][] = [
  [[0, "happy"], [T.perchOff + 14, "sad"], [T.toSpace + 15, "happy"], [T.c1, "neutral"], [170, "happy"], [T.ask, "neutral"], [T.cheer, "happy"]],
  [[0, "happy"], [T.perchOff + 16, "sad"], [T.drop1, "surprised"], [T.drop1 + 4, "sad"], [T.toSpace + 17, "happy"], [T.c1, "neutral"], [146, "surprised"], [150, "neutral"], [192, "surprised"], [T.fixed, "happy"], [T.ask, "neutral"], [T.cheer, "happy"]],
  [[0, "happy"], [T.perchOff + 18, "sad"], [T.drop2, "surprised"], [T.drop2 + 4, "sad"], [T.toSpace + 19, "happy"], [T.c1, "neutral"], [149, "surprised"], [153, "neutral"], [171, "surprised"], [175, "neutral"], [T.cheer, "happy"]],
];

function place(f: number, i: number) {
  let at = PERCH[i];
  let landed = -1;
  let sy = 1;
  for (const j of JUMPS[i]) {
    if (f >= j.t1) { at = j.to; if (j.t1 > j.t0) landed = j.t1; continue; }
    if (f >= j.t0) {
      const p = (f - j.t0) / (j.t1 - j.t0), e = INOUT(p);
      const floor = mix(at.g, j.to.g, j.yEase ? j.yEase(p) : p);
      return { x: mix(at.x, j.to.x, e), g: floor - 4 * j.h * p * (1 - p), floor, w: mix(at.w, j.to.w, e), rot: mix(at.rot, j.to.rot, e), sy: 1 + 0.12 * Math.abs(1 - 2 * p), air: true };
    }
    // Anticipation: crouch for four frames before taking off.
    if (j.h > 0 || j.yEase === OUT) sy *= mix(1, 0.86, ramp(f, j.t0 - 4, j.t0));
    break;
  }
  // Landing: squash on impact, then spring back past rest.
  if (landed >= 0 && f - landed < 24) {
    const t = f - landed;
    sy *= t < 2 ? mix(1.08, 0.8, t / 2) : mix(0.8, 1, spring({ frame: t - 2, fps: FPS, config: { damping: 9, stiffness: 240, mass: 0.6 } }));
  }
  return { x: at.x, g: at.g, floor: at.g, w: at.w, rot: at.rot, sy, air: false };
}

const moodAt = (i: number, f: number) => { let m = "neutral"; for (const [t, v] of MOODS[i]) if (f >= t) m = v; return m; };
const talking = (i: number, f: number) => TALK[i].some(([a, b]) => f >= a && f < b);
const headOf = (p: { x: number; g: number; w: number }): Pt => [p.x, p.g - 44 * (p.w / 116)];
const lookToward = (from: Pt, to: Pt): Pt => {
  const dx = to[0] - from[0], dy = to[1] - from[1], n = Math.hypot(dx, dy) || 1;
  return [(2.8 * dx) / n, (2.6 * dy) / n];
};
// The point just above a raised hand, where it holds a note or an envelope.
function handOf(i: number, f: number, grow = 1): Pt {
  const p = place(f, i), k = p.w / 116, cy = p.g - 44 * k, arm = holdUp(i, 1);
  const from: Pt = [p.x + (arm.from[0] - 52) * k, cy + (arm.from[1] - 52) * k];
  const to: Pt = [p.x + ((arm.to as Pt)[0] - 52) * k, cy + ((arm.to as Pt)[1] - 52) * k];
  return [mix(from[0], to[0], grow), mix(from[1], to[1], grow) - 20];
}

// ---------- what moves between the agents ----------
type Flight = { from: number; to: number; start: number; dur: number; col: string };
const POSTS = [T.c1, T.c2, T.c3];
const FLIGHTS: Flight[] = [
  { from: 0, to: 1, start: T.c1 + 8, dur: 14, col: BLUE },
  { from: 0, to: 2, start: T.c1 + 9, dur: 16, col: BLUE },
  { from: 1, to: 0, start: T.c2 + 8, dur: 14, col: BLUE },
  { from: 1, to: 2, start: T.c2 + 9, dur: 14, col: BLUE },
  { from: 2, to: 1, start: T.c3 + 8, dur: 12, col: ORANGE },
];
function flightPoint(fl: Flight, f: number): { at: Pt; t: number } | null {
  const t = (f - fl.start) / fl.dur;
  if (t < 0 || t > 1) return null;
  const a = handOf(fl.from, fl.start), b = headOf(place(fl.start + fl.dur, fl.to));
  const c: Pt = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 110 - Math.abs(b[0] - a[0]) * 0.12];
  return { at: quad(a, c, [b[0], b[1] - 8], INOUT(t)), t };
}

const NOTES = [
  { label: "findings", from: 0, to: 1, up: T.note1Up, grab: T.grab1, drop: T.drop1 },
  { label: "draft", from: 1, to: 2, up: T.note2Up, grab: T.grab2, drop: T.drop2 },
];
type NoteBeat = (typeof NOTES)[number];
const GRAB: Pt = [44, 12];
const above = (p: Pt): Pt => [p[0], p[1] - 46];
const heldNote = (n: NoteBeat, f: number) => handOf(n.from, Math.min(f, n.grab), springAt(Math.min(f, n.grab), n.up, 11));

// ---------- the cursor: you, relaying by hand ----------
type Leg = { t0: number; t1: number; to: Pt; arc?: number; ease?: (t: number) => number };
const minus = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const OFF: Pt = [1250, 720];
const CURSOR: Leg[] = [
  { t0: T.cursorIn, t1: T.grab1, to: minus(heldNote(NOTES[0], T.grab1), GRAB), ease: DECEL },
  { t0: T.grab1 + 2, t1: T.drop1, to: minus(above(headOf(WIN[1])), GRAB), arc: 110 },
  { t0: T.note2Up, t1: T.grab2, to: minus(heldNote(NOTES[1], T.grab2), GRAB), ease: OUT },
  { t0: T.grab2 + 2, t1: T.drop2, to: minus(above(headOf(WIN[2])), GRAB), arc: 100 },
  { t0: T.drop2 + 6, t1: T.toSpace + 4, to: OFF, ease: ACCEL },
  { t0: T.click - 10, t1: T.click, to: [1040, 614], ease: DECEL },
  { t0: T.click + 9, t1: T.click + 17, to: OFF, ease: ACCEL },
];
function cursorAt(f: number): { at: Pt; press: boolean } {
  let at = OFF;
  for (const l of CURSOR) {
    if (f >= l.t1) { at = l.to; continue; }
    if (f >= l.t0) {
      const c: Pt = [(at[0] + l.to[0]) / 2, Math.min(at[1], l.to[1]) - (l.arc ?? 0)];
      at = quad(at, c, l.to, (l.ease ?? INOUT)((f - l.t0) / (l.t1 - l.t0)));
    }
    break;
  }
  return { at, press: [T.grab1, T.grab2, T.click].some((t) => f >= t && f < t + 3) };
}
const noteAt = (n: NoteBeat, f: number): Pt => {
  if (f < n.grab + 2) return heldNote(n, f);
  const c = cursorAt(f).at;
  return [c[0] + GRAB[0], c[1] + GRAB[1]];
};

// ---------- poses ----------
function armsFor(i: number, f: number): Arm[] {
  const arms: Arm[] = [];
  const perched = T.perch[i] + 7;
  if (f < T.perchOff + 4) arms.push(...perchArms(i, f, 1 - ramp(f, T.perchOff, T.perchOff + 3, ACCEL)));
  else if (f >= perched) arms.push(...perchArms(i, f, springAt(f, perched, 10)));
  for (const n of NOTES) if (n.from === i) arms.push(holdUp(i, f < n.grab + 4 ? springAt(f, n.up, 11) : 1 - ramp(f, n.grab + 4, n.grab + 10, ACCEL)));
  const post = POSTS[i];
  arms.push(holdUp(i, f < post + 12 ? springAt(f, post + 2, 11) : 1 - ramp(f, post + 12, post + 18, ACCEL)));
  if (i === 1) arms.push(thumbUp(f < T.fixed + 18 ? springAt(f, T.fixed + 2, 11) : 1 - ramp(f, T.fixed + 18, T.fixed + 23, ACCEL)));
  if (i === 2) arms.push(raiseHand(i, f < T.click ? springAt(f, T.ask, 10) : 1 - ramp(f, T.click, T.click + 4, ACCEL), f));
  arms.push(...cheerArms(i, f < T.leap + 2 * i ? springAt(f, T.cheer - 1 + 2 * i, 10) : 1 - ramp(f, T.leap + 2 * i, T.leap + 2 * i + 3, ACCEL)));
  return arms.filter((a) => a.grow > 0.01);
}

function lookAt(i: number, f: number, p: { x: number; g: number; w: number }): Pt {
  const me = headOf(p);
  if (f < T.perchOff + 4 || f >= T.perch[i] + 4) return PERCH_LOOK[i];
  for (const fl of FLIGHTS) { const q = flightPoint(fl, f); if (q && (fl.to === i || fl.from === i)) return lookToward(me, q.at); }
  for (const fl of FLIGHTS) { const q = flightPoint(fl, f); if (q) return lookToward(me, q.at); }
  if (f >= T.cheer) return [0, -2.4];
  if (f >= T.ask) return i === 2 ? [1.8, 2] : lookToward(me, headOf(place(f, 2)));
  if (f >= T.c1) {
    const speaker = f >= T.fixed ? 1 : f >= T.c3 ? 2 : f >= T.c2 ? 1 : 0;
    return speaker === i ? [0, 0.8] : lookToward(me, headOf(place(f, speaker)));
  }
  if (f >= T.toSpace) return [0, 0];
  for (const n of NOTES) if (f >= n.up && f < n.drop + 2 && (n.from === i || n.to === i)) return lookToward(me, noteAt(n, f));
  return [0, 2.2];
}

type Pose = { i: number; x: number; g: number; w: number; rot: number; sx: number; sy: number; look: Pt; blink: boolean; brows: boolean; mood: string; arms: Arm[]; floor: number };
const BUSY: [number, number, number][] = [[0, T.h1, T.note1Up], [1, T.drop1 + 4, T.note2Up + 4], [2, T.drop2 + 4, T.toSpace], [1, 192, T.fixed]];

function poseOf(i: number, f: number): Pose {
  const p = place(f, i);
  let { g, rot } = p;
  if (!p.air) { g += 1.6 * wave(f, 68, i * 2.1); rot += 1.1 * wave(f, 85, i * 1.3); }
  // Working: a quick wobble, like typing.
  if (BUSY.some(([who, a, b]) => who === i && f >= a && f < b)) { rot += 2.2 * Math.sin(f * 1.7); g -= 2.5 * Math.abs(Math.sin(f * 0.85)); }
  let sy = p.sy;
  for (const b of BUMPS[i]) if (f >= b && f < b + 16) { const t = f - b; sy *= 1 - 0.13 * Math.exp(-t / 3.5) * Math.cos(t * 0.85); }
  // Stuck in their own windows: slumped, and sighing now and then.
  const glum = f >= JUMPS[i][0].t1 && f < JUMPS[i][1].t0;
  if (glum) sy *= 0.94;
  for (const s of SIGHS[i]) if (f >= s && f < s + 12) sy *= 1 - 0.07 * Math.sin((Math.PI * (f - s)) / 12);
  let mood = moodAt(i, f);
  if (talking(i, f) && Math.floor(f / 3) % 2) mood = "open";
  const blink = BLINKS[i].some((b) => f >= b && f < b + 2) || SIGHS[i].some((s) => f >= s + 3 && f < s + 9);
  return { i, x: p.x, g, w: p.w, rot, sx: 1 + (1 - sy) * 0.9, sy, look: lookAt(i, f, p), blink, brows: glum && mood === "sad", mood, arms: armsFor(i, f), floor: p.floor };
}

// The forum character, with arms drawn here so a glove can mirror and an arm can grow out of the body.
function drawCharacter(A: Art, p: Pose): string {
  const k = p.w / 116, cy = p.g - 44 * k, a = (p.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const P = (x: number, y: number): Pt => { const dx = (x - 52) * k, dy = (y - 52) * k; return [p.x + dx * cos - dy * sin, cy + dx * sin + dy * cos]; };
  let arms = "", hands = "";
  for (const m of p.arms) {
    const S = P(...m.from), C0 = P(...m.via), H0 = m.toAbs ?? P(...(m.to as Pt));
    const C: Pt = [mix(S[0], C0[0], m.grow), mix(S[1], C0[1], m.grow)];
    const Hh: Pt = [mix(S[0], H0[0], m.grow), mix(S[1], H0[1], m.grow)];
    arms += `<path d="M${S} Q${C} ${Hh}" fill="none" stroke="${NAVY}" stroke-width="${2.6 * k}" stroke-linecap="round"/>`;
    const deg = m.deg === "auto" ? (Math.atan2(Hh[0] - C[0], -(Hh[1] - C[1])) * 180) / Math.PI : m.deg + p.rot;
    const glove = A.hand(m.hand, Hh, m.mirror ? -deg : deg, k * 1.15 * (m.size ?? 1) * Math.min(m.grow, 1.15));
    hands += m.mirror ? `<g transform="translate(${Hh[0]} ${Hh[1]}) scale(-1 1) translate(${-Hh[0]} ${-Hh[1]})">${glove}</g>` : glove;
  }
  let body = A.character({ vendor: VENDORS[p.i], cx: p.x, cy, w: p.w, rot: p.rot, mood: p.mood });
  if (p.blink) body = body.replace(/<g class="eyes">[\s\S]*?<\/g>/, `<g class="eyes"><path d="M32 50 Q39 54 46 50 M54 50 Q61 54 68 50" fill="none" stroke="${NAVY}" stroke-width="2.6" stroke-linecap="round"/></g>`);
  else body = body.replace('cx="40" cy="52"', `cx="${40 + p.look[0]}" cy="${52 + p.look[1]}"`).replace('cx="62" cy="52"', `cx="${62 + p.look[0]}" cy="${52 + p.look[1]}"`);
  if (p.brows) body = body.replace('<g class="mouth">', `<path d="M30 36 L44 30.5 M56 30.5 L70 36" fill="none" stroke="${NAVY}" stroke-width="2.8" stroke-linecap="round"/><g class="mouth">`);
  return `<g transform="translate(${p.x} ${p.g}) scale(${p.sx} ${p.sy}) translate(${-p.x} ${-p.g})">${arms}${body}${hands}</g>`;
}

// ---------- drawing pieces ----------
function Envelope({ at, rot, col, s }: { at: Pt; rot: number; col: string; s: number }) {
  const w = 46 * s, h = 30 * s, r = h * 0.18;
  return <g transform={`translate(${at[0]} ${at[1]}) rotate(${rot})`}>
    <rect x={-w / 2 + 2.5} y={-h / 2 + 2.5} width={w} height={h} rx={r} fill={NAVY} opacity={0.9} />
    <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={r} fill={col} stroke={NAVY} strokeWidth={2.2} />
    <path d={`M${-w / 2 + 2.5} ${-h / 2 + 2.5} L0 ${h * 0.1} L${w / 2 - 2.5} ${-h / 2 + 2.5}`} fill="none" stroke={NAVY} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
  </g>;
}

function Note({ at, rot, s, label }: { at: Pt; rot: number; s: number; label: string }) {
  const w = label.length * 9.6 + 46;
  return <g transform={`translate(${at[0]} ${at[1]}) rotate(${rot}) scale(${s})`}>
    <rect x={-w / 2 + 3} y={-15} width={w} height={36} rx={9} fill={NAVY} />
    <rect x={-w / 2} y={-18} width={w} height={36} rx={9} fill={WHITE} stroke={NAVY} strokeWidth={2.2} />
    <path d={`M${-w / 2 + 12} -7 h12 M${-w / 2 + 12} 0 h12 M${-w / 2 + 12} 7 h8`} stroke={DIM} strokeWidth={2.2} strokeLinecap="round" />
    <text x={-w / 2 + 32} y={6} fontFamily={MONO} fontWeight={600} fontSize={16} fill={NAVY}>{label}</text>
  </g>;
}

function Cursor({ at, press }: { at: Pt; press: boolean }) {
  return <g transform={`translate(${at[0]} ${at[1]}) scale(${press ? 0.84 : 1})`}>
    <path d="M2 2 L2 30 L10 22.5 L16 35.5 L22.4 32.6 L16.2 19.8 L27 19 Z" fill={NAVY} />
    <path d="M0 0 L0 28 L8 20.5 L14 33.5 L20.4 30.6 L14.2 17.8 L25 17 Z" fill={WHITE} stroke={NAVY} strokeWidth={2.4} strokeLinejoin="round" />
  </g>;
}

function Sticker({ x, y, w, h, r = 20 }: { x: number; y: number; w: number; h: number; r?: number }) {
  return <>
    <rect x={x + 4} y={y + 4} width={w} height={h} rx={r} fill={NAVY} />
    <rect x={x} y={y} width={w} height={h} rx={r} fill={WHITE} stroke={NAVY} strokeWidth={2.5} />
  </>;
}

// Three separate apps, each waiting on you.
function Windows({ f }: { f: number }) {
  if (f < T.windows || f > T.toSpace + 10) return null;
  const out = ramp(f, T.toSpace, T.toSpace + 8, ACCEL);
  return <>{[0, 1, 2].map((i) => {
    const x = WIN[i].x, s = mix(0.86, 1, springAt(f, T.windows + 2 * i, 11)) * mix(1, 0.92, out);
    const op = ramp(f, T.windows + 2 * i, T.windows + 2 * i + 4) * (1 - out);
    const working = [f < 50, f >= T.drop1 && f < 86, f >= T.drop2][i];
    return <g key={i} transform={scaleAbout(x, WY + WH / 2, s)} opacity={op}>
      <Sticker x={x - 150} y={WY} w={300} h={WH} />
      <text x={x - 128} y={WY + 33} fontFamily={SANS} fontWeight={600} fontSize={19} fill={NAVY}>{NAMES[i]}</text>
      <rect x={x + 26} y={WY + 13} width={104} height={28} rx={14} fill={working ? "#E6F2E3" : "#FBF0D2"} stroke={NAVY} strokeWidth={1.8} />
      <circle cx={x + 42} cy={WY + 27} r={5} fill={working ? GREEN : GOLD} opacity={working ? 1 : 0.55 + 0.45 * wave(f, 10)} />
      <text x={x + 53} y={WY + 32} fontFamily={MONO} fontWeight={600} fontSize={14} fill={NAVY}>{working ? "working" : "waiting"}</text>
      <path d={`M${x - 150} ${WY + 54} H${x + 150}`} stroke={RULE} strokeWidth={2} />
    </g>;
  })}</>;
}

// One shared space, the channel on its top edge.
const PX = 60, PY = 192, PW = 1080, PH = 418;
function Space({ f }: { f: number }) {
  if (f < T.panel || f > T.outro + 10) return null;
  const out = ramp(f, T.outro, T.outro + 8, ACCEL);
  const s = mix(0.9, 1, springAt(f, T.panel, 12)) * mix(1, 0.94, out);
  const pill = springAt(f, T.panel + 6, 10);
  return <g opacity={ramp(f, T.panel, T.panel + 4) * (1 - out)} transform={scaleAbout(600, PY + PH / 2, s)}>
    <Sticker x={PX} y={PY} w={PW} h={PH} r={26} />
    <g transform={scaleAbout(600, PY, pill)}>
      <rect x={600 - 92 + 3} y={PY - 18 + 3} width={184} height={36} rx={18} fill={NAVY} />
      <rect x={600 - 92} y={PY - 18} width={184} height={36} rx={18} fill={WHITE} stroke={NAVY} strokeWidth={2.5} />
      <text x={600} y={PY + 6} textAnchor="middle" fontFamily={MONO} fontWeight={600} fontSize={17} fill={NAVY}>#launch-brief</text>
    </g>
    {[0, 1, 2].map((i) => {
      const t = ramp(f, T.panel + 10 + 3 * i, T.panel + 18 + 3 * i, DECEL);
      return <g key={i} opacity={t} transform={`translate(0 ${mix(10, 0, t)})`}>
        <text x={SPACE[i].x} y={528} textAnchor="middle" fontFamily={SANS} fontWeight={600} fontSize={21} fill={NAVY}>{NAMES[i]}</text>
        <text x={SPACE[i].x} y={554} textAnchor="middle" fontFamily={SANS} fontWeight={500} fontSize={16} fill={DIM}>{HOSTS[i]}</text>
      </g>;
    })}
  </g>;
}

// The rings: the lower two roll away and back, the top one jumps out and bounces back in.
function Rings({ f, A }: { f: number; A: Art }) {
  const cols = [A.RING.blue, A.RING.yellow, A.RING.orange];
  const dist = [0, -620, 900];
  const L = T.blueLand;
  const offs = [0, 1, 2].map((i) => {
    let dx = 0, dy = 0, sy = 1;
    if (i === 0) {
      if (f < T.ringsIn) {
        sy = mix(1, 0.84, ramp(f, T.ringsOut - 3, T.ringsOut));
        if (f >= T.ringsOut) { sy = 1.1; dy = -560 * ramp(f, T.ringsOut, T.ringsOut + 9, OUT); }
      } else if (f < L) { dy = -560 * (1 - ramp(f, T.blueDrop, L, ACCEL)); sy = f >= T.blueDrop ? 1.1 : 1; }
      else if (f < L + 2) sy = 0.78;
      else if (f < L + 7) { dy = -30 * ramp(f, L + 2, L + 7, OUT); sy = mix(0.78, 1.06, ramp(f, L + 2, L + 5)); }
      else if (f < L + 11) { dy = -30 * (1 - ramp(f, L + 7, L + 11, ACCEL)); sy = 1.04; }
      else sy = mix(0.9, 1, spring({ frame: f - L - 11, fps: FPS, config: { damping: 9, stiffness: 260, mass: 0.6 } }));
    } else {
      dx = f < T.ringsIn ? dist[i] * ramp(f, T.ringsOut + i - 1, T.ringsOut + i + 9, ACCEL) : dist[i] * (1 - springAt(f, T.ringsIn + i - 1, 14, 120, 0.8));
      if (f >= L && f < L + 8) dy = 6 * Math.sin((Math.PI * (f - L)) / 8);
    }
    return { dx, dy, deg: ((dx / R_OUT) * 180) / Math.PI, sx: 1 + (1 - sy) * 0.9, sy };
  });
  const burst = ramp(f, L, L + 7, OUT);
  return <>
    <g transform={`translate(${MX} ${MY}) scale(${MS}) translate(${-X0} ${-Y0})`}>
      {[1, 2, 0].map((i) => {
        const o = offs[i], [cx, cy] = RING_C[i], base = cy + 32.69;
        return <g key={i} transform={`translate(${o.dx / MS} ${o.dy / MS}) rotate(${o.deg} ${cx} ${cy}) translate(${cx} ${base}) scale(${o.sx} ${o.sy}) translate(${-cx} ${-base})`}>
          <path d={A.MARK_PATHS[i]} fill={cols[i]} />
        </g>;
      })}
    </g>
    {f >= L && f < L + 8 && [-1, 1].map((side) => {
      const [bx, by] = RING_PX[0], x = bx + side * 80, y = by + 46;
      return <g key={side} stroke={NAVY} strokeWidth={3.5} strokeLinecap="round" opacity={1 - burst * burst}>
        {[-40, 0, 40].map((a) => {
          const r = ((side > 0 ? a - 20 : 200 - a) * Math.PI) / 180, r0 = 8 + 22 * burst, r1 = r0 + 18 * (1 - burst) + 5;
          return <path key={a} d={`M${x + Math.cos(r) * r0} ${y + Math.sin(r) * r0} L${x + Math.cos(r) * r1} ${y + Math.sin(r) * r1}`} />;
        })}
      </g>;
    })}
  </>;
}

function Wordmark({ f }: { f: number }) {
  const t = f < T.ringsIn ? 1 - ramp(f, T.wordOut, T.wordOut + 8, ACCEL) : springAt(f, T.word, 13);
  if (t <= 0.001) return null;
  return <g clipPath="url(#word-clip)">
    <text x={WORD_X + mix(-150, 0, t)} y={430} fontFamily={DISPLAY} fontWeight={800} fontSize={196} letterSpacing="-0.04em" fill={NAVY} opacity={Math.min(1, t * 3)}>cotal</text>
  </g>;
}

function Headline({ f, start, end, title, sub }: { f: number; start: number; end: number; title: string; sub: string }) {
  if (f < start || f > end + 8) return null;
  const a = ramp(f, start, start + 9, DECEL), b = ramp(f, start + 3, start + 12, DECEL), out = ramp(f, end, end + 6, ACCEL);
  return <div style={{ position: "absolute", left: 0, top: 46, width: W, textAlign: "center", color: NAVY }}>
    <div style={{ font: `800 50px/1.05 ${DISPLAY}`, letterSpacing: "-0.03em", opacity: a * (1 - out), transform: `translateY(${mix(16, 0, a) - 12 * out}px)` }}>{title}</div>
    <div style={{ font: `500 23px/1.3 ${SANS}`, color: DIM, marginTop: 12, opacity: b * (1 - out), transform: `translateY(${mix(14, 0, b) - 10 * out}px)` }}>{sub}</div>
  </div>;
}

type Say = { who: number; text: string; start: number; end: number; lift?: number };
const SAYS: Say[] = [
  { who: 0, text: "Findings are in.", start: T.c1, end: T.c2 + 6 },
  { who: 1, text: "Draft is ready.", start: T.c2, end: T.c3 + 6 },
  { who: 2, text: "One fix, then it's good.", start: T.c3, end: T.fixed + 4 },
  { who: 1, text: "Fixed.", start: T.fixed + 2, end: T.ask + 8 },
  { who: 2, text: "Ready to ship?", start: T.ask + 2, end: T.click + 2, lift: 18 },
];
function Bubbles({ f }: { f: number }) {
  return <>{SAYS.map((s, n) => {
    if (f < s.start || f > s.end + 6) return null;
    const p = springAt(f, s.start, 11, 220, 0.6), out = ramp(f, s.end, s.end + 5, ACCEL);
    const head = headOf(place(f, s.who)), top = head[1] - 66 * (SPACE[s.who].w / 116) - (s.lift ?? 0);
    return <div key={n} style={{ position: "absolute", left: head[0], top, transform: `translate(-50%, -100%) translateY(${mix(14, 0, p)}px) scale(${mix(0.6, 1, p) * mix(1, 0.85, out)})`, transformOrigin: "50% 100%", opacity: Math.min(1, p * 4) * (1 - out) }}>
      <div style={{ position: "relative", background: WHITE, border: `2.5px solid ${NAVY}`, borderRadius: 18, padding: "9px 18px 11px", whiteSpace: "nowrap", color: NAVY }}>
        <div style={{ font: `500 14px/1 ${SANS}`, opacity: 0.6, marginBottom: 5 }}>{NAMES[s.who]}</div>
        <div style={{ font: `600 22px/1.15 ${SANS}` }}>{s.text}</div>
        <div style={{ position: "absolute", left: "50%", bottom: -9.5, width: 16, height: 16, background: WHITE, borderRight: `2.5px solid ${NAVY}`, borderBottom: `2.5px solid ${NAVY}`, transform: "translateX(-50%) rotate(45deg)" }} />
      </div>
    </div>;
  })}</>;
}

function DecisionCard({ f, A }: { f: number; A: Art }) {
  if (f < T.card || f > T.outro + 6) return null;
  const inn = springAt(f, T.card, 12), out = ramp(f, T.click + 12, T.click + 20, ACCEL);
  const approved = f >= T.click + 2, pressed = f >= T.click && f < T.click + 3;
  const pop = approved ? mix(1.08, 1, springAt(f, T.click + 2, 9)) : 1;
  const avatar = A.character({ vendor: "codex", cx: 30, cy: 30, w: 46, mood: approved ? "happy" : "neutral" });
  return <div style={{ position: "absolute", left: 655, top: 574, width: 470, height: 92, transform: `translateY(${mix(150, 0, inn) + 170 * out}px)`, color: NAVY }}>
    <div style={{ position: "absolute", inset: 0, transform: "translate(4px, 4px)", background: NAVY, borderRadius: 18 }} />
    <div style={{ position: "absolute", inset: 0, background: WHITE, border: `2.5px solid ${approved ? GREEN : NAVY}`, borderRadius: 18 }} />
    <svg style={{ position: "absolute", left: 14, top: 16 }} width={62} height={62} viewBox="0 0 62 62" dangerouslySetInnerHTML={{ __html: avatar }} />
    <div style={{ position: "absolute", left: 86, top: 20, font: `600 20px/1.1 ${SANS}` }}>Ship the launch brief?</div>
    <div style={{ position: "absolute", left: 86, top: 48, font: `500 16px/1.1 ${SANS}`, color: DIM }}>{approved ? "Approved. The team carries on." : "Codex is waiting for you."}</div>
    <div style={{ position: "absolute", left: 335, top: 26, width: 112, height: 40, transform: `translate(${pressed ? 3 : 0}px, ${pressed ? 3 : 0}px) scale(${pop})` }}>
      <div style={{ position: "absolute", inset: 0, transform: "translate(3px, 3px)", background: NAVY, borderRadius: 12, opacity: pressed ? 0 : 1 }} />
      <div style={{ position: "absolute", inset: 0, background: approved ? GREEN : BLUE, border: `2.5px solid ${NAVY}`, borderRadius: 12, color: WHITE, font: `600 17px/35px ${SANS}`, textAlign: "center" }}>{approved ? "Approved" : "Approve"}</div>
    </div>
  </div>;
}

export function ReadmeForumHero() {
  const f = useCurrentFrame() / PACE;
  const [handle] = useState(() => delayRender("Load the forum character artwork"));
  const [art, setArt] = useState<Art | null>(null);
  useEffect(() => {
    const script = document.createElement("script");
    script.src = staticFile("forum/characters.js");
    script.onload = () => { setArt(window.CotalArt); continueRender(handle); };
    script.onerror = () => { throw new Error("The forum character artwork did not load"); };
    document.head.appendChild(script);
    return () => script.remove();
  }, [handle]);
  if (!art) return <AbsoluteFill style={{ background: CREAM }} />;

  const poses = [0, 1, 2].map((i) => poseOf(i, f));
  const cursor = cursorAt(f);
  const showCursor = (f >= T.cursorIn && f < T.toSpace + 4) || (f >= T.click - 10 && f < T.click + 17);
  const drawNote = (n: NoteBeat) => {
    const into = ramp(f, n.drop, n.drop + 3, ACCEL);
    const swing = f >= n.grab + 2 && f < n.drop ? 8 * Math.sin((f - n.grab) * 0.7) * (1 - ramp(f, n.grab, n.drop)) : 0;
    return <Note key={n.label} at={noteAt(n, f)} rot={-4 + swing} s={mix(springAt(f, n.up + 4, 11), 0.2, into)} label={n.label} />;
  };
  const notes = NOTES.filter((n) => f >= n.up + 4 && f <= n.drop + 3);

  return <AbsoluteFill style={{ background: CREAM }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0 }}>
      <defs><clipPath id="word-clip"><rect x={WORD_X - 14} y={0} width={W} height={H} /></clipPath></defs>
      <Windows f={f} />
      <Space f={f} />
      <Rings f={f} A={art} />
      <Wordmark f={f} />
      {poses.map((p) => {
        const js = JUMPS[p.i];
        if (f < js[0].t1 - 2 || f >= js[3].t1) return null;
        const ground = f < js[1].t0 ? WIN[p.i].g : f < js[1].t1 ? p.floor : SPACE[p.i].g;
        const lift = Math.max(0, ground - p.g), k = p.w / 116;
        return <ellipse key={p.i} cx={p.x} cy={ground + 2} rx={Math.max(8, 40 * k - lift * 0.18)} ry={6 * k} fill={NAVY} opacity={Math.max(0, 0.12 - lift * 0.0008)} />;
      })}
      {notes.filter((n) => f < n.grab + 2).map(drawNote)}
      {POSTS.map((post, i) => f >= post + 4 && f < post + 8 ? <Envelope key={i} at={handOf(i, f, springAt(f, post + 2, 11))} rot={8} col={i === 2 ? ORANGE : BLUE} s={0.9 * springAt(f, post + 3, 13)} /> : null)}
      {[...poses].sort((a, b) => a.g - b.g).map((p) => <g key={p.i} dangerouslySetInnerHTML={{ __html: drawCharacter(art, p) }} />)}
      {notes.filter((n) => f >= n.grab + 2).map(drawNote)}
      {FLIGHTS.map((fl, n) => {
        const q = flightPoint(fl, f);
        if (!q) return null;
        const s = Math.min(1, 0.8 + q.t * 1.6) * (0.45 + 0.55 * Math.min(1, (1 - q.t) / 0.16));
        const trail = [3, 2, 1].map((m) => { const p = flightPoint(fl, f - m * 0.9); return p ? <circle key={m} cx={p.at[0]} cy={p.at[1]} r={4.5 - m} fill={fl.col} opacity={0.5 - m * 0.12} /> : null; });
        return <g key={n}>{trail}<Envelope at={q.at} rot={Math.sin(f * 0.9 + n) * 7 + (fl.to > fl.from ? 6 : -6)} col={fl.col} s={s} /></g>;
      })}
    </svg>
    <Headline f={f} start={T.h1} end={T.toSpace} title="Still copying context between agents?" sub="You relay every handoff and keep checking who is waiting." />
    <Headline f={f} start={T.h2} end={T.ask - 2} title="Cotal puts them in one shared space." sub="Claude Code, OpenCode and Codex hand off work directly." />
    <Headline f={f} start={T.h3} end={T.outro} title="Agents coordinate. You make the call." sub="They ask when a decision needs you." />
    <Bubbles f={f} />
    <DecisionCard f={f} A={art} />
    {showCursor && <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0 }}><Cursor at={cursor.at} press={cursor.press} /></svg>}
  </AbsoluteFill>;
}

export const README_HERO = { durationInFrames: FRAMES, fps: FPS, width: W, height: H };
