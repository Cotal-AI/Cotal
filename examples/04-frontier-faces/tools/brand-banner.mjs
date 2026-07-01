#!/usr/bin/env node
// brand-banner.mjs — the live-event signage strip for the terminal mesh wall.
// Three header layouts + a native pixel-image QR mode, all from one static matrix (../qr-cotal.mjs).
//
//   node tools/brand-banner.mjs --variant 1   # V1 "Card"  — wordmark left, QR card right (compact)
//   node tools/brand-banner.mjs --variant 2   # V2 "Bar"   — big wordmark + accent, small QR right
//   node tools/brand-banner.mjs --variant 3   # V3 "Hero"  — centered poster, chunky QR as the focus
//   node tools/brand-banner.mjs --image       # native pixel QR (Ghostty/kitty graphics, no tmux)
//   node tools/brand-banner.mjs --qr-color cyan|blue|white|magenta|#hex   # QR glow colour (default blue)
//   BANNER_VARIANT=2 QR_COLOR=cyan node tools/brand-banner.mjs
//
// The block QR is an inverted "glow" (bright pixels on the dark theme, no white card) — modern phones
// scan it; the browser wall keeps a dark-on-light QR as the bulletproof scan path.
// In a TTY it holds the pane open and re-renders on resize; piped, it renders once and exits.

import { MATRIX, COTAL_URL } from '../qr-cotal.mjs';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const VARIANT = Number(opt('--variant', process.env.BANNER_VARIANT || '1')) || 1;
const WANT_IMAGE = has('--image');
const URL_SHORT = COTAL_URL.replace(/^https?:\/\//, '');

// QR pixel colour (inverted "glow" style draws the data modules in this colour on the dark theme)
const QR_PALETTE = { cyan: [83, 235, 228], blue: [88, 166, 255], white: [255, 255, 255], magenta: [241, 165, 189] };
function resolveColor(s) {
  s = (s || 'blue').toLowerCase();
  if (QR_PALETTE[s]) return QR_PALETTE[s];
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : QR_PALETTE.cyan;
}
const QR_RGB = resolveColor(opt('--qr-color', process.env.QR_COLOR));

// ── colour ────────────────────────────────────────────────────────────────────
const TC = process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';
const BRAND = [88, 166, 255], CYAN = [83, 235, 228], MAG = [241, 165, 189], GREY = [120, 130, 150];
const R = '\x1b[0m';
const col = ([r, g, b], s, bold = false) =>
  TC ? `\x1b[${bold ? '1;' : ''}38;2;${r};${g};${b}m${s}${R}` : `\x1b[${bold ? '1;' : ''}34m${s}${R}`;
const brand = (s) => col(BRAND, s, true), cyan = (s) => col(CYAN, s), mag = (s) => col(MAG, s);
const grey = (s) => col(GREY, s);

// visible length / pad, ignoring ANSI so coloured strings align by what you can see
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const padV = (s, w) => s + ' '.repeat(Math.max(0, w - vlen(s)));
const cols = () => process.stdout.columns || 120;
const centre = (s, w = cols()) => ' '.repeat(Math.max(0, Math.floor((w - vlen(s)) / 2))) + s;

// ── QR renderer — inverted "glow" (qrterminal half-block technique) ─────────────
// Two module-rows per text row via █ ▀ ▄ (space). Inverted: the DARK data modules are the *drawn*
// pixels (in QR_RGB), and the light/quiet modules are left as the pane's own dark background — so
// the code glows in one bright colour with no white card. Note this is an inverted QR (bright on
// dark): modern phones auto-invert it, but the browser wall keeps the reliable dark-on-light scan.
const N = MATRIX.length;
function qrTerminal(qz = 2) {
  const S = N + 2 * qz;
  const on = (y, x) => y >= qz && y < qz + N && x >= qz && x < qz + N && MATRIX[y - qz][x - qz] === '1';
  const fg = TC ? `\x1b[38;2;${QR_RGB[0]};${QR_RGB[1]};${QR_RGB[2]}m` : '\x1b[96m';
  const out = [];
  for (let r = 0; r < Math.ceil(S / 2); r++) {
    let l = fg;
    for (let x = 0; x < S; x++) {
      const t = on(2 * r, x), b = 2 * r + 1 < S ? on(2 * r + 1, x) : false; // pad bottom = off (dark bg)
      l += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    out.push(l + R);
  }
  return out; // width S, height ceil(S/2)
}

// ── block wordmark "COTAL" (5 rows) ─────────────────────────────────────────────
const FONT = {
  C: ['█████', '█    ', '█    ', '█    ', '█████'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  A: ['█████', '█   █', '█████', '█   █', '█   █'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
};
function wordmark(word = 'COTAL') {
  const rows = ['', '', '', '', ''];
  for (const ch of word) { const g = FONT[ch]; for (let i = 0; i < 5; i++) rows[i] += (rows[i] ? ' ' : '') + g[i]; }
  return rows; // uncoloured; colour at print time
}

// stack a left text block beside a right block of pre-coloured lines, vertically centred
function beside(left, right, gap = 4) {
  const h = Math.max(left.length, right.length), lw = Math.max(...left.map(vlen), 0);
  const lt = Math.floor((h - left.length) / 2), rt = Math.floor((h - right.length) / 2), out = [];
  for (let i = 0; i < h; i++) {
    const l = i - lt >= 0 && i - lt < left.length ? left[i - lt] : '';
    const r = i - rt >= 0 && i - rt < right.length ? right[i - rt] : '';
    out.push(padV(l, lw) + ' '.repeat(gap) + r);
  }
  return out;
}

// ── variants ────────────────────────────────────────────────────────────────────
function vCard() {
  const wm = wordmark().map(brand);
  const left = [...wm, '', cyan('  the web for agents'), '', brand('  ▶ Scan to try it live'), grey('  → ' + URL_SHORT)];
  return beside(left, qrTerminal(2), 5).map((l) => centre(l));
}

function vBar() {
  const wm = wordmark().map(brand);
  const rule = mag('▔'.repeat(Math.max(...wm.map(vlen))));
  const left = [...wm, rule, cyan('the web for agents — a live multi-agent mesh')];
  const qr = qrTerminal(2);
  const tag = ['', '', grey('scan'), brand('↗ ' + URL_SHORT)];
  const right = beside(tag, qr, 2);
  // justify: wordmark hard-left, QR hard-right, air in between
  const h = Math.max(left.length, right.length), lt = Math.floor((h - left.length) / 2), rt = Math.floor((h - right.length) / 2);
  const lw = Math.max(...left.map(vlen)), rw = Math.max(...right.map(vlen)), w = Math.min(cols() - 2, Math.max(72, lw + rw + 8));
  const out = [];
  for (let i = 0; i < h; i++) {
    const l = i - lt >= 0 && i - lt < left.length ? left[i - lt] : '';
    const r = i - rt >= 0 && i - rt < right.length ? right[i - rt] : '';
    out.push(' ' + padV(l, w - rw) + r);
  }
  return out;
}

function vHero() {
  const top = brand('●') + ' ' + col(BRAND, 'Cotal', true) + grey('  ·  ') + cyan('the web for agents');
  const qr = qrTerminal(4);
  const cap = grey('Scan to open ') + brand(URL_SHORT) + grey(' on your phone');
  return [centre(top), '', ...qr.map((l) => centre(l)), '', centre(cap)];
}

// ── native pixel-image QR (Kitty graphics protocol) ─────────────────────────────
function pngQR(scale = 8, qz = 4) {
  const dim = (N + 2 * qz) * scale, px = Buffer.alloc(dim * dim, 255);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (MATRIX[y][x] === '1')
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px[((y + qz) * scale + dy) * dim + (x + qz) * scale + dx] = 0;
  const tab = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = tab[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const cd = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(cd)); return Buffer.concat([L, cd, cr]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(dim, 0); ih.writeUInt32BE(dim, 4); ih[8] = 8;
  const raw = Buffer.alloc((dim + 1) * dim); for (let y = 0; y < dim; y++) px.copy(raw, y * (dim + 1) + 1, y * dim, y * dim + dim);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const KITTY = !process.env.TMUX && (process.env.TERM_PROGRAM === 'ghostty' ||
  process.env.GHOSTTY_RESOURCES_DIR || process.env.KITTY_WINDOW_ID || /kitty/i.test(process.env.TERM || ''));
function renderImage() {
  const b64 = pngQR().toString('base64'), parts = [];
  for (let i = 0; i < b64.length; i += 4096) parts.push(b64.slice(i, i + 4096));
  let img = '';
  parts.forEach((c, i) => { const ctrl = i === 0 ? `f=100,a=T,c=15,r=15,m=${i === parts.length - 1 ? 0 : 1}` : `m=${i === parts.length - 1 ? 0 : 1}`; img += `\x1b_G${ctrl};${c}\x1b\\`; });
  const wm = wordmark().map((l) => '  ' + brand(l)).join('\n');
  process.stdout.write(`\n${wm}\n\n  ${cyan('the web for agents')}     ${grey('scan to open ')}${brand(URL_SHORT)}\n\n  ${img}\n`);
}

// ── drive ───────────────────────────────────────────────────────────────────────
const useImage = WANT_IMAGE && KITTY;
if (WANT_IMAGE && !KITTY)
  process.stderr.write('brand-banner: --image needs Kitty graphics (Ghostty/kitty) outside tmux — falling back to blocks\n');
const VARIANTS = [vCard, vBar, vHero];

function render() {
  process.stdout.write('\x1b[2J\x1b[H');
  if (useImage) { renderImage(); return; }
  process.stdout.write('\n' + (VARIANTS[VARIANT - 1] || vCard)().join('\n') + '\n');
}

render();
if (process.stdout.isTTY) { process.stdout.on('resize', render); process.stdin.resume(); }
else process.exit(0);
