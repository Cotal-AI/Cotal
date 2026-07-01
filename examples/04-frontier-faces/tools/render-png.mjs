#!/usr/bin/env node
// render-png.mjs — render a persona (draft) to a PNG contact sheet for visual review.
//
//   node render-png.mjs --file draft.mjs --out /tmp/face.png [--scale 8]
//
// The draft module must `export const entry = {...}` (a personas.mjs-style entry: rows, colors,
// glow, mouths, expr, eyes(style,blink), ...). Renders 7 states left→right:
//   neutral · happy · sad · angry · surprised · viseme-D (talking) · blink
// Pure JS BMP writer (no deps), converted to PNG via macOS `sips`.

import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const GRID = 32, BG = '#0b001b';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FILE = flag('file', null), OUT = flag('out', null), SCALE = parseInt(flag('scale', '8'), 10);
if (!FILE || !OUT) { console.error('usage: node render-png.mjs --file <draft.mjs> --out <out.png> [--scale 8]'); process.exit(1); }

const mod = await import('file://' + resolve(FILE));
const p = mod.entry || (mod.PERSONAS && mod.PERSONAS[flag('persona', '')]);
if (!p) { console.error('draft must `export const entry = {...}` (or pass --persona with a PERSONAS export)'); process.exit(1); }

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BGC = hex(BG);

function compose(expr, { blink = false, viseme = null } = {}) {
  const g = Array.from({ length: GRID }, () => new Array(GRID).fill(null));
  const put = ([r, c, k]) => { if (r >= 0 && r < GRID && c >= 0 && c < GRID) g[r][c] = k; };
  for (let r = 0; r < GRID; r++) {
    const row = (p.rows[r] || '').padEnd(GRID, '.');
    for (let c = 0; c < GRID; c++) if (row[c] && row[c] !== '.') put([r, c, row[c]]);
  }
  const e = p.expr[expr] || p.expr.neutral;
  const mouth = viseme ? p.mouths[viseme] : p.mouths[e.mouth];
  [...e.brows, ...mouth, ...p.eyes(e.eyes, blink)].forEach(put);
  return g;
}

const STATES = [
  ['neutral', {}], ['happy', {}], ['sad', {}], ['angry', {}], ['surprised', {}],
  ['neutral', { viseme: 'D' }], ['neutral', { blink: true }],
];
const GAP = 2; // grid cells between faces
const W = (GRID * STATES.length + GAP * (STATES.length - 1)) * SCALE;
const H = GRID * SCALE;

// paint into an RGB buffer
const img = Buffer.alloc(W * H * 3);
function px(x, y, [r, g, b]) { const o = (y * W + x) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b; }
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, BGC);
STATES.forEach(([expr, opts], si) => {
  const g = compose(expr, opts);
  const x0 = si * (GRID + GAP) * SCALE;
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    const k = g[r][c];
    const col = k ? hex(p.colors[k] || '#ff00ff') : BGC; // unknown keys scream magenta
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) px(x0 + c * SCALE + dx, r * SCALE + dy, col);
  }
});

// minimal BMP (24-bit, bottom-up, rows padded to 4 bytes)
const rowSize = Math.ceil((W * 3) / 4) * 4;
const dataSize = rowSize * H;
const bmp = Buffer.alloc(54 + dataSize);
bmp.write('BM'); bmp.writeUInt32LE(54 + dataSize, 2); bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(W, 18); bmp.writeInt32LE(H, 22);
bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(dataSize, 34);
for (let y = 0; y < H; y++) {
  const src = (H - 1 - y) * W * 3, dst = 54 + y * rowSize;
  for (let x = 0; x < W; x++) { // RGB -> BGR
    bmp[dst + x * 3] = img[src + x * 3 + 2];
    bmp[dst + x * 3 + 1] = img[src + x * 3 + 1];
    bmp[dst + x * 3 + 2] = img[src + x * 3];
  }
}
const tmpBmp = OUT.replace(/\.png$/i, '') + '.tmp.bmp';
writeFileSync(tmpBmp, bmp);
execFileSync('sips', ['-s', 'format', 'png', tmpBmp, '--out', OUT], { stdio: 'ignore' });
unlinkSync(tmpBmp);
console.log(`${OUT}  (${W}x${H})  states L->R: neutral | happy | sad | angry | surprised | talking(viseme D) | blink`);
