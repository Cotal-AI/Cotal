#!/usr/bin/env node
// img2rows.mjs — downscale a reference image onto the 32×32 persona grid and quantize it,
// emitting ASCII rows + a palette: the raw base a pixel artist hand-cleans into a persona.
//
//   node img2rows.mjs --in reference.png --w 24 --h 30 [--colors 12] [--x0 4] [--y0 0]
//
// Uses sips (macOS) to crop/resize to w×h, then parses the BMP and bins colors by frequency.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const IN = flag('in', null);
const W = parseInt(flag('w', '24'), 10), H = parseInt(flag('h', '30'), 10);
const NCOLORS = parseInt(flag('colors', '12'), 10);
const X0 = parseInt(flag('x0', String(Math.floor((32 - W) / 2))), 10), Y0 = parseInt(flag('y0', '0'), 10);
if (!IN) { console.error('usage: node img2rows.mjs --in <img> [--w 24 --h 30 --colors 12 --x0 4 --y0 0]'); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'i2r-'));
const bmp = join(tmp, 'r.bmp');
execFileSync('sips', ['-z', String(H), String(W), '-s', 'format', 'bmp', IN, '--out', bmp], { stdio: 'ignore' });
const buf = readFileSync(bmp);
rmSync(tmp, { recursive: true, force: true });

const off = buf.readUInt32LE(10), w = buf.readInt32LE(18), h = Math.abs(buf.readInt32LE(22));
const bpp = buf.readUInt16LE(28), rowSz = Math.ceil((w * bpp / 8) / 4) * 4, topDown = buf.readInt32LE(22) < 0;
const px = (x, y) => {
  const ry = topDown ? y : h - 1 - y;
  const o = off + ry * rowSz + x * (bpp / 8);
  return [buf[o + 2], buf[o + 1], buf[o]]; // RGB
};

// frequency-bin to NCOLORS: coarse-bucket, take top buckets, then map each pixel to nearest
const bucket = ([r, g, b]) => `${r >> 4}.${g >> 4}.${b >> 4}`;
const counts = new Map();
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const k = bucket(px(x, y));
  counts.set(k, (counts.get(k) || 0) + 1);
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, NCOLORS)
  .map(([k]) => k.split('.').map((v) => (parseInt(v, 10) << 4) + 8));
const dist2 = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
const nearest = (c) => top.reduce((bi, t, i) => dist2(c, t) < dist2(c, top[bi]) ? i : bi, 0);

const KEYS = 'ABCDEFGHIJKLMNOP'.slice(0, top.length);
const grid = Array.from({ length: 32 }, () => new Array(32).fill('.'));
for (let y = 0; y < h && Y0 + y < 32; y++) for (let x = 0; x < w && X0 + x < 32; x++) {
  grid[Y0 + y][X0 + x] = KEYS[nearest(px(x, y))];
}

console.log('// palette (frequency-ordered):');
top.forEach((c, i) => console.log(`//   ${KEYS[i]}: '#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}'`));
console.log('// rows:');
grid.forEach((r) => console.log("'" + r.join('').replace(/\.+$/, '') + "',"));
