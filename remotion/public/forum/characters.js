// The Cotal characters and marks, shared by the redesign: SVG strings for the screens and cards,
// and a canvas painter for the live mesh. Same drawing as the posters and stickers.
'use strict';
(() => {
  const NAVY = '#202B43', CREAM = '#FFFCEE';
  const RING = { blue: '#4D69E6', yellow: '#E5C776', orange: '#E38C6E' };

  // One character per vendor. The first three match the posters.
  const CHARS = {
    claude: { kind: 'pill', fill: '#4663E7', shade: '#354CBD', name: 'Claude Code' },
    opencode: { kind: 'cloud', fill: '#F4C758', shade: '#D3A640', name: 'OpenCode' },
    codex: { kind: 'square', fill: '#F17858', shade: '#CF5F43', name: 'Codex' },
    hermes: { kind: 'dome', fill: '#BCD4BB', shade: '#90A599', name: 'Hermes' },
    pi: { kind: 'round', fill: '#B9A9DA', shade: '#8E86B0', name: 'pi' },
  };
  // Any other model (gemini in demo 4) is a guest: a teal circle.
  const charOf = (vendor) => CHARS[vendor] || { kind: 'round', fill: '#8FD0C8', shade: '#64A79F', name: '' };

  // Bodies in a 116-unit box centred on (52, 52).
  const SHAPES = {
    square: '<rect x="12" y="14" width="76" height="74" rx="20" transform="rotate(-6 50 50)"/>',
    pill: '<rect x="18" y="4" width="64" height="92" rx="32" transform="rotate(-4 50 50)"/>',
    cloud: '<circle cx="50" cy="54" r="32"/><circle cx="26" cy="36" r="17"/><circle cx="50" cy="24" r="18"/><circle cx="74" cy="36" r="17"/><circle cx="80" cy="60" r="16"/><circle cx="20" cy="60" r="16"/><circle cx="34" cy="80" r="16"/><circle cx="66" cy="80" r="16"/>',
    dome: '<path d="M14 94 V52 C14 32.1 30.1 16 50 16 C69.9 16 86 32.1 86 52 V94 Z"/>',
    round: '<circle cx="50" cy="52" r="40"/>',
  };
  const LOOK = { left: [-2.6, 0], right: [2.6, 0], up: [0, -3], down: [0, 2.6], upleft: [-2, -2], upright: [2, -2], downleft: [-2, 2], downright: [2, 2] };
  const MOUTH = {
    neutral: '<path class="m" d="M40 66 Q50 75 60 66" fill="none" stroke="#202B43" stroke-width="2.6" stroke-linecap="round"/>',
    happy: '<path class="m" d="M38 63 Q50 81 62 63 Z" fill="#202B43" stroke="#202B43" stroke-width="2.2" stroke-linejoin="round"/>',
    surprised: '<ellipse class="m" cx="50" cy="69" rx="4.4" ry="5.4" fill="#202B43"/>',
    open: '<ellipse class="m" cx="50" cy="68" rx="6" ry="4.6" fill="#202B43"/>',
    sad: '<path class="m" d="M41 72 Q50 64 59 72" fill="none" stroke="#202B43" stroke-width="2.6" stroke-linecap="round"/>',
  };

  function body(vendor, { look, mood = 'neutral' } = {}) {
    const c = charOf(vendor), [dx, dy] = LOOK[look] || [0, 0];
    return `<g fill="${c.shade}" transform="translate(5 5)">${SHAPES[c.kind]}</g>
      <g fill="${c.fill}" stroke="${c.kind === 'cloud' ? 'none' : NAVY}" stroke-width="2.6">${SHAPES[c.kind]}</g>
      <g class="eyes"><ellipse cx="39" cy="49" rx="8.5" ry="11" fill="#fff" stroke="${NAVY}" stroke-width="2.2"/>
      <ellipse cx="61" cy="49" rx="8.5" ry="11" fill="#fff" stroke="${NAVY}" stroke-width="2.2"/>
      <circle cx="${40 + dx}" cy="${52 + dy}" r="4.6" fill="${NAVY}"/><circle cx="${62 + dx}" cy="${52 + dy}" r="4.6" fill="${NAVY}"/></g>
      <g class="mouth">${MOUTH[mood] || MOUTH.neutral}</g>`;
  }

  // White gloves: every part drawn fat in navy, then white on top, so the parts merge into one outline.
  const GLOVE = {
    open: { parts: '<ellipse cx="0" cy="-9" rx="7.6" ry="7.4"/><rect x="-2.5" y="-11" width="5" height="11.5" rx="2.5" transform="translate(-4.6 -11) rotate(-16)"/><rect x="-2.5" y="-12" width="5" height="12.5" rx="2.5" transform="translate(0 -12.5)"/><rect x="-2.5" y="-11" width="5" height="11.5" rx="2.5" transform="translate(4.6 -11) rotate(16)"/><rect x="-2.5" y="-9.5" width="5" height="10" rx="2.5" transform="translate(-6.2 -6.5) rotate(-62)"/>', lines: '' },
    thumb: { parts: '<rect x="-7.4" y="-16" width="14.8" height="14" rx="5"/><rect x="-6.6" y="-27" width="5.4" height="14" rx="2.7"/>', lines: 'M-0.6 -12 H5.6 M-0.6 -8 H5.6' },
    flat: { parts: '<rect x="-6" y="-23" width="12" height="22" rx="6"/><rect x="-2.5" y="-9" width="5" height="9.5" rx="2.5" transform="translate(-5.4 -6.5) rotate(-38)"/>', lines: 'M-2 -23 V-17 M2 -23 V-17' },
    fist: { parts: '<rect x="-7" y="-13" width="14" height="12.4" rx="4.8"/>', lines: 'M-2.3 -13 V-9 M2.3 -13 V-9' },
  };
  function hand(type, [x, y], deg, s) {
    const g = GLOVE[type], sw = 2.3;
    return `<g transform="translate(${x} ${y}) rotate(${deg}) scale(${s})" stroke-linejoin="round">
      <g fill="${NAVY}" stroke="${NAVY}" stroke-width="${sw * 2}">${g.parts}</g><g fill="#fff">${g.parts}</g>
      ${g.lines ? `<path d="${g.lines}" fill="none" stroke="${NAVY}" stroke-width="${sw * 0.85}" stroke-linecap="round"/>` : ''}
      <rect x="-5.6" y="-2.6" width="11.2" height="5.2" rx="2.4" fill="#fff" stroke="${NAVY}" stroke-width="${sw}"/></g>`;
  }
  function shoe([x, y], dir) {
    const X = (d) => x + dir * d * 1.35, Y = (d) => y + d * 1.35;
    return `<path d="M${X(-6)} ${Y(5.5)} C${X(-6)} ${Y(-1.5)} ${X(4)} ${Y(-2.5)} ${X(11)} ${Y(2.5)} Q${X(12.5)} ${Y(5.5)} ${X(9)} ${Y(5.5)} Z"/>`;
  }
  // A whole character: o = { vendor, cx, cy, w, rot, look, mood, arms:[{from,via,to|toAbs,hand,deg|'auto',size}], legs:[{from,to,dir,bend}] }
  function character(o) {
    const k = o.w / 116, a = (o.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const P = (x, y) => { const dx = (x - 52) * k, dy = (y - 52) * k; return [o.cx + dx * cos - dy * sin, o.cy + dx * sin + dy * cos]; };
    let arms = '', hands = '';
    for (const m of o.arms || []) {
      const S = P(...m.from), C = P(...m.via), H = m.toAbs || P(...m.to);
      arms += `<path d="M${S} Q${C} ${H}" fill="none" stroke="${o.limb || NAVY}" stroke-width="${2.6 * k}" stroke-linecap="round"/>`;
      const deg = m.deg === 'auto' ? Math.atan2(H[0] - C[0], -(H[1] - C[1])) * 180 / Math.PI : m.deg + (o.rot || 0);
      hands += hand(m.hand, H, deg, k * 1.15 * (m.size || 1));
    }
    const legs = (o.legs || []).map((l) => `<path d="M${l.from} Q${(l.from[0] + l.to[0]) / 2 + (l.bend || 0)} ${(l.from[1] + l.to[1]) / 2} ${l.to}" fill="none" stroke="${o.limb || NAVY}" stroke-width="2.6" stroke-linecap="round"/>`).join('');
    const shoes = (o.legs || []).map((l) => shoe(l.to, l.dir)).join('');
    return `${arms}<g class="char" transform="translate(${o.cx} ${o.cy}) rotate(${o.rot || 0}) scale(${k}) translate(-52 -52)">${legs}<g fill="${o.limb || NAVY}">${shoes}</g>${body(o.vendor, o)}</g>${hands}`;
  }

  // The Cotal mark, from the Penpot file.
  const MARK_PATHS = [
    'M218.82,166C218.82,173.79,222.39,180.74,227.98,185.32C227.05,187.91,226.4,190.64,226.08,193.48C217.06,187.66,211.09,177.53,211.09,166C211.09,147.94,225.73,133.31,243.78,133.31C261.3,133.31,275.6,147.09,276.43,164.4C273.9,163.3,271.21,162.48,268.42,161.99C266.5,150.11,256.2,141.04,243.78,141.04C230,141.04,218.82,152.21,218.82,166M240.62,198.54C240.61,198.24,240.6,197.93,240.6,197.63C240.6,195.27,240.98,193,241.69,190.87C242.38,190.92,243.08,190.95,243.78,190.95C253.76,190.95,262.37,185.09,266.36,176.63C268.96,177.16,271.38,178.16,273.54,179.53C268.4,190.83,257.01,198.69,243.78,198.69C242.72,198.69,241.67,198.64,240.63,198.54',
    'M258.17,199.22C257.34,216.54,243.04,230.32,225.52,230.32C207.46,230.32,192.83,215.69,192.83,197.63C192.83,186.1,198.79,175.97,207.81,170.15C208.13,172.98,208.78,175.71,209.72,178.3C204.13,182.88,200.56,189.84,200.56,197.63C200.56,211.41,211.73,222.59,225.52,222.59C237.93,222.59,248.23,213.52,250.15,201.64C252.94,201.15,255.63,200.33,258.16,199.23M223.43,172.76C222.72,170.64,222.34,168.36,222.34,166C222.34,165.7,222.34,165.4,222.36,165.1C223.39,164.99,224.45,164.94,225.52,164.94C238.74,164.94,250.13,172.79,255.28,184.09C253.12,185.47,250.7,186.47,248.1,187C244.12,178.54,235.5,172.68,225.52,172.68C224.82,172.68,224.12,172.7,223.44,172.76',
    'M237.09,197.63C237.09,202.92,238.73,207.83,241.54,211.86C239.83,213.8,237.76,215.43,235.45,216.64C231.61,211.29,229.35,204.72,229.35,197.63C229.35,190.54,231.61,183.98,235.44,178.63C237.76,179.83,239.83,181.46,241.55,183.39C238.73,187.43,237.09,192.34,237.09,197.63M253.19,174.29C251.39,172.15,249.34,170.23,247.09,168.55C251.57,166.25,256.65,164.94,262.04,164.94C280.1,164.94,294.73,179.58,294.73,197.63C294.73,215.69,280.1,230.32,262.04,230.32C256.66,230.32,251.57,229.02,247.09,226.71C249.34,225.04,251.39,223.11,253.19,220.98C255.94,222.02,258.92,222.59,262.04,222.59C275.83,222.59,287,211.41,287,197.63C287,183.85,275.83,172.68,262.04,172.68C258.93,172.68,255.94,173.25,253.19,174.29',
  ];
  const MARK_VIEWBOX = '185.197 128.504 117.165 117.165';
  const mark = (fill) => `<svg viewBox="${MARK_VIEWBOX}" aria-hidden="true">${MARK_PATHS.map((d, i) => `<path d="${d}" fill="${Array.isArray(fill) ? fill[i] : fill}"/>`).join('')}</svg>`;
  const markColour = () => mark([RING.blue, RING.yellow, RING.orange]);

  // ---------- canvas painter for the mesh ----------
  const p2 = {
    dome: new Path2D('M14 94 V52 C14 32.1 30.1 16 50 16 C69.9 16 86 32.1 86 52 V94 Z'),
    neutral: new Path2D('M40 66 Q50 75 60 66'),
    happy: new Path2D('M38 63 Q50 81 62 63 Z'),
    flat: new Path2D('M42 69 L58 69'),
    sad: new Path2D('M41 72 Q50 64 59 72'),
  };
  function shapePath(ctx, kind) {
    ctx.beginPath();
    if (kind === 'square') { ctx.save(); ctx.translate(50, 50); ctx.rotate(-6 * Math.PI / 180); ctx.roundRect(-38, -36, 76, 74, 20); ctx.restore(); }
    else if (kind === 'pill') { ctx.save(); ctx.translate(50, 50); ctx.rotate(-4 * Math.PI / 180); ctx.roundRect(-32, -46, 64, 92, 32); ctx.restore(); }
    else if (kind === 'round') ctx.arc(50, 52, 40, 0, 6.283);
    else if (kind === 'cloud') for (const [x, y, r] of [[50, 54, 32], [26, 36, 17], [50, 24, 18], [74, 36, 17], [80, 60, 16], [20, 60, 16], [34, 80, 16], [66, 80, 16]]) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.283); }
  }
  // Draw a character centred on (x, y), `size` px wide for the 116-unit box.
  function drawChar(ctx, vendor, x, y, size, o = {}) {
    const c = charOf(vendor), k = size / 116;
    ctx.save(); ctx.translate(x, y); ctx.rotate((o.rot || 0) * Math.PI / 180); ctx.scale(k, k); ctx.translate(-52, -52);
    if (o.alpha != null) ctx.globalAlpha *= o.alpha;
    const fill = (col) => { ctx.fillStyle = col; if (c.kind === 'dome') ctx.fill(p2.dome); else { shapePath(ctx, c.kind); ctx.fill(); } };
    const offline = o.status === 'offline';
    ctx.save(); ctx.translate(5, 5); fill(offline ? '#CFCABD' : c.shade); ctx.restore();
    fill(offline ? '#E6E1D3' : c.fill);
    if (c.kind !== 'cloud') {
      ctx.lineWidth = 2.6; ctx.strokeStyle = NAVY; ctx.setLineDash(offline ? [6, 5] : []);
      if (c.kind === 'dome') ctx.stroke(p2.dome); else { shapePath(ctx, c.kind); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    // eyes
    const [dx, dy] = LOOK[o.look] || [0, 0];
    ctx.lineWidth = 2.2; ctx.strokeStyle = NAVY; ctx.lineCap = 'round';
    if (offline || o.blink) {
      ctx.beginPath(); ctx.moveTo(32, 50); ctx.quadraticCurveTo(39, 54, 46, 50); ctx.moveTo(54, 50); ctx.quadraticCurveTo(61, 54, 68, 50); ctx.lineWidth = 2.6; ctx.stroke();
    } else {
      for (const ex of [39, 61]) { ctx.beginPath(); ctx.ellipse(ex, 49, 8.5, 11, 0, 0, 6.283); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = NAVY; for (const ex of [40, 62]) { ctx.beginPath(); ctx.arc(ex + dx, 52 + dy, 4.6, 0, 6.283); ctx.fill(); }
    }
    // mouth
    ctx.lineWidth = 2.6; ctx.strokeStyle = NAVY; ctx.fillStyle = NAVY;
    const mood = offline ? 'flat' : o.mood || 'neutral';
    if (mood === 'happy') { ctx.fill(p2.happy); ctx.lineJoin = 'round'; ctx.stroke(p2.happy); }
    else if (mood === 'surprised' || mood === 'open') { ctx.beginPath(); ctx.ellipse(50, 69, mood === 'open' ? 6 : 4.4, mood === 'open' ? 4.6 : 5.4, 0, 0, 6.283); ctx.fill(); }
    else ctx.stroke(mood === 'flat' ? p2.flat : mood === 'sad' ? p2.sad : p2.neutral);
    ctx.restore();
  }

  window.CotalArt = { NAVY, CREAM, RING, CHARS, charOf, SHAPES, body, hand, shoe, character, mark, markColour, MARK_PATHS, MARK_VIEWBOX, drawChar };
})();
