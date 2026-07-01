// face-template.mjs — the reference face. Copy this to design a new persona.
//
//   node tools/render-png.mjs --file tools/face-template.mjs --out /tmp/face.png --scale 8
//
// It is a plain, neutral head that exercises every convention a persona needs (see FACE-DESIGN.md):
//   - 32×32 grid, ~zones: brows r10-11, eyes r12-13, nose r14-16, mouth r18-20, collar r26-31.
//   - skin ramp P(light) / S(mid) / s(shadow); pupil E; catchlight W; lips R/m; brow/hair b,h.
//   - the cotal glow ribbon: L (cyan) down the left, M (magenta) down the right of the collar.
//   - the canonical eye: 2-wide iris on r12 + catchlight(outer)/lid-shadow(inner) on r13;
//     surprised just raises the brows + opens the mouth (eyes stay open); `blink` = shadow line.
//
// To make a new face: copy this file, repaint `rows`/`colors` (tools/img2rows.mjs roughs in a base
// from a reference image), keep the eyes()/expr/mouths shape, then add it to personas.mjs.

import { rng } from '../personas.mjs';

export const entry = {
  label: 'template',
  rows: [
    '',
    '............hhhhhhh',
    '..........hhhhhhhhhhh',
    '.........hhhhhhhhhhhhh',
    '........hhhhhhhhhhhhhhh',
    '........hhsSSPPPPPSSshh',
    '........hsSSPPPPPPPSSsh',
    '.........sSSSPPPPPSSSs',
    '.........sSSPPPPPPPSSs',
    '.........sSSSSSSSSSSSs',
    '.........sSSSSSSSSSSSs',
    '.........sSSSSSSSSSSSs',
    '.........sSSSSSSSSSSSs',
    '.........sSSSSSSSSSSSs',
    '.........sSSSSSSSSSSSs',
    '.........sSSSSsSsSSSSs',
    '..........sSSSsSsSSSs',
    '..........sSSSSSSSSSs',
    '..........sSSSSSSSSSs',
    '..........sSSSSSSSSSs',
    '...........sSSSSSSSs',
    '...........sSSSSSSSs',
    '............sSSSSSs',
    '.............sSSSs',
    '.............sSSSs',
    '.............sSSSs',
    '...........TTsSSsTT',
    '.......LTTTTTTTTTTTTTTTTM',
    '......LTTTTTTTTTTTTTTTTTTM',
    '.....LTTTTTTTTTTTTTTTTTTTTM',
    '....LTTTTTTTTTTTTTTTTTTTTTTM',
    '...LTTTTTTTTTTTTTTTTTTTTTTTTM',
  ],
  colors: {
    h: '#2f2118', b: '#1d130c',           // hair, brow
    P: '#f1c9a5', S: '#d99a6c', s: '#a86b44', // skin: light / mid / shadow
    E: '#2a1a12', W: '#f6f1e6', w: '#d8c4a8', // pupil, catchlight (bright / soft)
    R: '#c2574e', m: '#6e2a24',            // lip, lip-shadow
    T: '#2c2336', t: '#1a1426',            // collar / clothing
    L: '#53ebe4', M: '#e13a6a',            // cotal glow accents (cyan / magenta)
  },
  glow: { L: 8, M: 6 },
  mouths: {
    X: rng(19, 14, 17, 'R'), A: rng(19, 13, 18, 'R'),
    B: [...rng(18, 13, 18, 'R'), ...rng(19, 13, 18, 'W')],
    C: [...rng(18, 14, 17, 'R'), [19, 13, 'R'], ...rng(19, 14, 17, 'm'), [19, 18, 'R'], ...rng(20, 14, 17, 'R')],
    D: [...rng(18, 13, 18, 'R'), [19, 13, 'R'], ...rng(19, 14, 17, 'm'), [19, 18, 'R'], ...rng(20, 14, 17, 'R')],
    E: [...rng(18, 15, 16, 'R'), [19, 14, 'R'], ...rng(19, 15, 16, 'm'), [19, 17, 'R'], ...rng(20, 15, 16, 'R')],
    F: [...rng(19, 14, 17, 'm'), ...rng(20, 15, 16, 'W')],
    smile: [[18, 13, 'R'], [18, 18, 'R'], ...rng(19, 14, 17, 'R')],
    frown: [...rng(19, 14, 17, 'R'), [20, 13, 'R'], [20, 18, 'R']],
    grit: [...rng(18, 13, 18, 'R'), ...rng(19, 13, 18, 'W'), ...rng(20, 13, 18, 'R')],
  },
  expr: {
    neutral:   { brows: [...rng(10, 11, 14, 'b'), ...rng(10, 17, 20, 'b')], eyes: 'open',  mouth: 'X' },
    happy:     { brows: [...rng(10, 11, 14, 'b'), ...rng(10, 17, 20, 'b')], eyes: 'open',  mouth: 'smile' },
    sad:       { brows: [[9, 13, 'b'], [10, 11, 'b'], [10, 12, 'b'], [9, 18, 'b'], [10, 19, 'b'], [10, 20, 'b']], eyes: 'open', mouth: 'frown' },
    angry:     { brows: [[9, 11, 'b'], [9, 12, 'b'], [10, 13, 'b'], [10, 14, 'b'], [10, 17, 'b'], [10, 18, 'b'], [9, 19, 'b'], [9, 20, 'b']], eyes: 'open', mouth: 'grit' },
    surprised: { brows: [...rng(9, 11, 14, 'b'), ...rng(9, 17, 20, 'b')], eyes: 'open', mouth: 'E' },
  },
  eyes(_style, blink) {
    if (blink) return [[13, 12, 's'], [13, 13, 's'], [13, 18, 's'], [13, 19, 's']];
    // canonical eye: 2-wide iris on r12, catchlight(outer)+lid-shadow(inner) on r13.
    return [[12, 12, 'E'], [12, 13, 'E'], [13, 12, 'W'], [13, 13, 's'], [12, 18, 'E'], [12, 19, 'E'], [13, 18, 's'], [13, 19, 'W']];
  },
  lines: ['this is the reference face.', 'copy me to start a new persona.', 'thirty-two by thirty-two, one ribbon of glow.'],
};
