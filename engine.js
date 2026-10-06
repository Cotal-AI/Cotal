// Cotal booth demo, redesigned: the same engine API that ../demos.js drives (mesh, stage, run),
// drawn in the poster style: cream paper, navy outlines, the Cotal characters, envelopes for messages.
'use strict';
(() => {
  const A = window.CotalArt, NAVY = A.NAVY;
  // ---------- utils ----------
  const $ = (s, root = document) => root.querySelector(s);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const CANCELLED = Symbol('cancelled');
  // ?shot=1: no easing or CSS animation, for still screenshots of a moment
  const SHOT = new URLSearchParams(location.search).has('shot');
  const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
  const mix = (h1, h2, t) => { const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16), c = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t); return `rgb(${c(16)},${c(8)},${c(0)})`; };

  // Palette: the logo colours carry the three ways to send.
  const C = { bg: '#FFFCEE', fg: NAVY, dim: '#6B6F80', faint: '#B9B4A6', blue: '#4D69E6', green: '#5FA866', amber: '#E38C6E', waiting: '#E2B23E', red: '#E0625A', gold: '#E5B94E', line: NAVY };
  const KIND = { chat: '#4D69E6', dm: '#E38C6E', anycast: '#5FA866', sys: '#9A968A', gold: '#E5B94E', red: '#E0625A', green: '#5FA866' };
  const INK = { chat: '#3651C9', dm: '#B85A3A', anycast: '#3E7F48', sys: '#6B6F80', gold: '#9A7210', red: '#BE3E36', green: '#3E7F48' };
  const STATUS = { working: C.green, waiting: C.waiting, idle: '#CFCABD', offline: null };
  const VENDORS = Object.fromEntries(Object.entries(A.CHARS).map(([k, v]) => [k, { label: v.name, img: '../assets/' + ({ claude: 'claude-code.svg', opencode: 'opencode.svg', codex: 'codex.svg', hermes: 'hermes.png', pi: 'pi.svg' })[k] }]));
  const vendorOf = new Map();                // name → vendor, learned as agents appear
  const nameColor = (n) => A.charOf(vendorOf.get(n)).fill;

  // ---------- sound (off by default; M toggles) ----------
  const sfx = {
    on: false, ctx: null,
    ensure() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    tone(freq, dur = 0.09, type = 'sine', gain = 0.05) {
      if (!this.on) return; this.ensure(); if (!this.ctx) return;
      const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    kind(k) { this.tone({ chat: 660, dm: 520, anycast: 780, sys: 420, gold: 880 }[k] || 600); },
    press() { this.tone(300, 0.06, 'triangle', 0.06); },
    ok() { this.tone(880, 0.12); setTimeout(() => this.tone(1320, 0.16), 90); },
    bad() { this.tone(160, 0.3, 'sawtooth', 0.05); },
  };

  // ---------- the mesh: characters on paper, envelopes for messages ----------
  class Mesh {
    constructor(canvas, opts = {}) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.opts = opts;
      this.nodes = new Map(); this.edges = []; this.temp = []; this.pulses = []; this.alive = true; this.zoom = 1; this.zoomT = 1;
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas); this.resize();
      this.frame = (t) => { if (!this.alive) return; if (!this.paused) this.draw(t); requestAnimationFrame(this.frame); };
      requestAnimationFrame(this.frame);
    }
    dispose() { this.alive = false; this.ro.disconnect(); }
    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = this.cv.clientWidth, hh = this.cv.clientHeight; if (!w || !hh) return;
      this.w = w; this.h = hh; this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(hh * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.base = Math.min(w, hh); this.unit = this.base * (this.opts.scale || 1);
    }
    // Characters are taller than dots: keep a margin so names and badges stay inside the paper.
    px(n) { const z = this.zoom, mx = 0.05, my = 0.09; return { x: (mx + (1 - 2 * mx) * (0.5 + (n.x - 0.5) * z)) * this.w, y: (my + (1 - 2 * my) * (0.5 + (n.y - 0.5) * z)) * this.h }; }
    zoomTo(z) { this.zoomT = z; }
    add(n) {
      const node = { kind: 'agent', status: 'idle', alpha: 0, badge: null, glow: 0, scale: 0.3, size: 1, seed: Math.random() * 10, blinkAt: performance.now() + 1500 + Math.random() * 4000, ...n };
      node.tx = n.x; node.ty = n.y; if (n.from) { node.x = n.from.x; node.y = n.from.y; }
      if (n.vendor && n.label) vendorOf.set(n.label, n.vendor); if (n.vendor) vendorOf.set(n.id, n.vendor);
      this.nodes.set(n.id, node); return node;
    }
    remove(id) { const n = this.nodes.get(id); if (n) n.dying = true; }
    get(id) { return this.nodes.get(id); }
    has(id) { return this.nodes.has(id); }
    move(id, x, y) { const n = this.nodes.get(id); if (n) { n.tx = x; n.ty = y; } }
    status(id, s) { const n = this.nodes.get(id); if (n) { n.status = s; n.glow = 1; } }
    badge(id, text, color) { const n = this.nodes.get(id); if (n) { n.badge = text; n.badgeColor = color; } }
    recolor(id, color) { const n = this.nodes.get(id); if (n) { n.color = color; n.glow = 1; } }
    // A face: 'happy', 'surprised', 'sad', or null for neutral. With `ms` it relaxes back afterwards.
    mood(id, m, ms) {
      const n = this.nodes.get(id); if (!n) return;
      n.mood = m && m !== 'neutral' ? m : undefined; n.hit = n.hit || { color: C.faint, t0: performance.now() };
      clearTimeout(n.moodT); if (ms) n.moodT = setTimeout(() => { if (n.mood === m) n.mood = undefined; }, ms);
    }
    link(a, b, kind = 'member') { if (!this.edges.some((e) => e.a === a && e.b === b)) this.edges.push({ a, b, kind, glow: 0 }); }
    unlink(a, b) { this.edges = this.edges.filter((e) => !(e.a === a && e.b === b)); }
    clearEdges() { this.edges = []; }
    clear() { this.nodes.clear(); this.edges = []; this.temp = []; for (const p of this.pulses) if (!p.done) { p.done = true; p.res(); } this.pulses = []; }
    // An envelope in flight. It lands when its time is up, from the draw loop or, if no frame is drawn
    // (a hidden window, a busy machine), from a timer, so a demo never waits on rendering.
    pulse(from, to, kind = 'chat', opts = {}) {
      return new Promise((res) => {
        const p = { from, to, kind, t0: performance.now() + (opts.delay || 0), dur: opts.dur || 650, res, size: opts.size || 1, done: false };
        this.pulses.push(p);
        setTimeout(() => this.land(p), (opts.delay || 0) + p.dur + 40);
      });
    }
    land(p) {
      if (p.done) return; p.done = true; p.res();
      const b = this.nodes.get(p.to); if (!b) return;
      const col = KIND[p.kind] || C.blue; b.glow = 1; b.hit = { color: col, t0: performance.now() };
      const e = this.edges.find((e) => (e.a === p.from && e.b === p.to) || (e.a === p.to && e.b === p.from)); if (e) { e.glow = 1; e.kind = p.kind; }
    }
    dashed(a, b, kind, ms = 1500) { this.temp.push({ a, b, kind, until: performance.now() + ms, t0: performance.now() }); }
    ring(id, color) { const n = this.nodes.get(id); if (n) n.hit = { color, t0: performance.now() }; }
    // sizes, from the shorter side of the canvas
    charW(n) { return this.unit * 0.13 * n.size * n.scale * this.zoom; }
    hubR(n) { return this.unit * 0.05 * n.size * n.scale; }
    draw(now) {
      const { ctx, w, h: hh } = this; if (!w) return;
      ctx.clearRect(0, 0, w, hh);
      // time-based easing, so motion keeps its pace even if the machine drops frames
      const dt = Math.min(250, now - (this.last || now)); this.last = now;
      const ease = SHOT ? () => 1 : (k) => 1 - Math.pow(1 - k, dt / 16.7), fade = dt / 16.7;
      this.zoom = lerp(this.zoom, this.zoomT, ease(0.06));
      for (const [id, n] of this.nodes) {
        if (n.drift) { n.tx += Math.sin(now / 4000 + n.seed) * 0.00022 * fade; n.ty += Math.cos(now / 5200 + n.seed * 1.7) * 0.00022 * fade; }
        n.x = lerp(n.x, n.tx, ease(0.085)); n.y = lerp(n.y, n.ty, ease(0.085));
        if (n.dying) { n.alpha = lerp(n.alpha, 0, ease(0.14)); if (n.alpha < 0.02) this.nodes.delete(id); }
        else { n.alpha = lerp(n.alpha, 1, ease(0.07)); n.scale = lerp(n.scale, 1, ease(0.1)); }
        n.glow = Math.max(0, n.glow - 0.018 * fade);
      }
      this.fade = fade;
      // links: thin navy lines, coloured for a moment when a message passes
      for (const e of this.edges) {
        const a = this.nodes.get(e.a), b = this.nodes.get(e.b); if (!a || !b) continue;
        const pa = this.px(a), pb = this.px(b), alpha = Math.min(a.alpha, b.alpha);
        const off = a.status === 'offline' || b.status === 'offline';
        ctx.setLineDash(off ? [5, 7] : []); ctx.lineCap = 'round';
        ctx.lineWidth = 1.6 + e.glow * 2.4;
        ctx.strokeStyle = e.glow > 0.02 ? rgba(KIND[e.kind] || C.blue, alpha * (0.35 + 0.65 * e.glow)) : rgba(NAVY, alpha * (off ? 0.12 : 0.16));
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        e.glow = Math.max(0, e.glow - 0.014 * this.fade);
      }
      // candidate lines (direct messages, role lookups): dashed, marching
      this.temp = this.temp.filter((t) => t.until > now);
      for (const t of this.temp) {
        const a = this.nodes.get(t.a), b = this.nodes.get(t.b); if (!a || !b) continue;
        const pa = this.px(a), pb = this.px(b), life = (t.until - now) / (t.until - t.t0);
        ctx.setLineDash([7, 7]); ctx.lineDashOffset = -now / 25; ctx.lineWidth = 2.2;
        ctx.strokeStyle = rgba(KIND[t.kind] || C.blue, 0.3 + 0.6 * Math.min(1, life * 2));
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      // nodes: hubs and machines first, then the small crowd, then the named characters, front row last.
      // Names go on top of everything so a crowd never hides who is who.
      const layer = (n) => (n.kind !== 'agent' ? 0 : n.size < 0.8 ? 1 : 2);
      const order = [...this.nodes.values()].sort((a, b) => layer(a) - layer(b) || (layer(a) === 2 ? a.y - b.y : 0));
      for (const n of order) this.drawNode(n, now);
      for (const n of order) if (layer(n) === 2) this.drawName(n);
      this.flushBadges();
      // envelopes in flight
      const keep = [];
      for (const p of this.pulses) {
        if (p.done) continue;
        const a = this.nodes.get(p.from), b = this.nodes.get(p.to);
        if (!a || !b) { p.done = true; p.res(); continue; }
        const t = (now - p.t0) / p.dur; if (t < 0) { keep.push(p); continue; }
        const pa = this.px(a), pb = this.px(b), col = KIND[p.kind] || C.blue;
        if (t >= 1) { this.land(p); continue; }
        const k = easeInOut(t), x = lerp(pa.x, pb.x, k), y = lerp(pa.y, pb.y, k);
        for (let i = 3; i >= 1; i--) { const kk = easeInOut(Math.max(0, t - i * 0.05)); ctx.fillStyle = rgba(col, 0.45 - i * 0.11); ctx.beginPath(); ctx.arc(lerp(pa.x, pb.x, kk), lerp(pa.y, pb.y, kk), this.unit * 0.006 * p.size, 0, 6.283); ctx.fill(); }
        // the envelope leaves its sender small and shrinks into the receiver, so it never covers a name
        const grow = Math.min(1, t / 0.12, (1 - t) / 0.16);
        this.envelope(x, y, Math.atan2(pb.y - pa.y, pb.x - pa.x), col, p.size * (0.35 + 0.65 * grow));
        keep.push(p);
      }
      this.pulses = keep;
    }
    envelope(x, y, ang, col, size = 1) {
      const ctx = this.ctx, ew = this.unit * 0.034 * size, eh = ew * 0.66;
      const flip = Math.abs(ang) > Math.PI / 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(flip ? ang - Math.PI : ang); ctx.rotate(Math.sin(performance.now() / 120) * 0.08);
      ctx.fillStyle = rgba(NAVY, 0.9); ctx.beginPath(); ctx.roundRect(-ew / 2 + 2, -eh / 2 + 2, ew, eh, eh * 0.18); ctx.fill();
      ctx.fillStyle = col; ctx.strokeStyle = NAVY; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.roundRect(-ew / 2, -eh / 2, ew, eh, eh * 0.18); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-ew / 2 + 1.5, -eh / 2 + 1.5); ctx.lineTo(0, eh * 0.08); ctx.lineTo(ew / 2 - 1.5, -eh / 2 + 1.5); ctx.stroke();
      ctx.restore();
    }
    drawNode(n, now) {
      const ctx = this.ctx, { x, y } = this.px(n), u = this.unit;
      const font = Math.max(this.w < 520 ? 10 : 12, this.base * 0.025);
      ctx.save(); ctx.globalAlpha = n.alpha; ctx.textAlign = 'center';
      if (n.kind === 'label') {
        // a role, the address anycast sends to: a dashed group around the agents below it, named on its top edge
        const col = KIND[n.color] || C.dim, ink = INK[n.color] || C.dim;
        ctx.font = `600 ${font}px "Geist Mono", monospace`; ctx.textBaseline = 'middle';
        const text = 'any ' + n.label.replace(/s$/, ''), tw = ctx.measureText(text).width, pw = tw + font * 2.2, ph = font * 2.1;
        const members = [...this.nodes.values()].filter((m) => m.kind === 'agent' && !m.dying && m.y > n.y && Math.abs(m.x - n.x) < 0.25);
        let cy = y;
        if (members.length) {
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (const m of members) { const p = this.px(m), cw = this.charW(m); x0 = Math.min(x0, p.x - cw * 0.62); x1 = Math.max(x1, p.x + cw * 0.62); y0 = Math.min(y0, p.y - cw * 0.62); y1 = Math.max(y1, p.y + cw * 0.6 + font * 1.5); }
          const pad = font * 0.6; x0 -= pad; x1 += pad; y0 -= pad; y1 = Math.min(y1 + pad * 0.5, this.h - 4);
          ctx.fillStyle = rgba(col, 0.07); ctx.strokeStyle = rgba(ink, 0.55); ctx.lineWidth = 2; ctx.setLineDash([7, 6]);
          ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, font * 1.4); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
          cy = y0;
        }
        ctx.fillStyle = mix(C.bg, col, 0.22); ctx.strokeStyle = ink; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(x - pw / 2, cy - ph / 2, pw, ph, ph / 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = ink; ctx.fillText(text, x, cy + 0.5);
        if (n.badge) this.badgeChip(x + pw / 2 + font * 3.2, cy, n.badge, C.green);
      } else if (n.kind === 'channel') {
        this.drawHub(n, x, y, font, now);
      } else {
        const hitAge = n.hit ? now - n.hit.t0 : 1e9, pop = hitAge < 360 ? 1 + 0.12 * Math.sin(Math.PI * hitAge / 360) : 1;
        const cw = this.charW(n), bob = n.status === 'working' ? Math.sin(now / 210 + n.seed) * cw * 0.025 : 0;
        if (now > n.blinkAt + 140) n.blinkAt = now + 2200 + Math.random() * 3800;
        const blink = now > n.blinkAt && now < n.blinkAt + 140;
        // ground shadow, tinted by status
        const st = STATUS[n.status];
        ctx.fillStyle = st ? rgba(st, n.status === 'idle' ? 0.35 : 0.45 + 0.25 * n.glow) : rgba(NAVY, 0.08);
        ctx.beginPath(); ctx.ellipse(x, y + cw * 0.5, cw * 0.36, cw * 0.07, 0, 0, 6.283); ctx.fill();
        const look = n.status === 'working' ? 'down' : n.status === 'waiting' ? 'up' : null;
        A.drawChar(ctx, n.vendor, x, y + bob - cw * (pop - 1) * 0.5, cw * pop, { status: n.status, look, blink, mood: n.mood });
        // presence dot
        if (st) {
          const dr = Math.max(3.5, cw * 0.075), dx = x + cw * 0.36, dy = y - cw * 0.38 + bob;
          ctx.fillStyle = st; ctx.strokeStyle = NAVY; ctx.lineWidth = 1.6;
          const pul = n.status === 'working' ? 1 + 0.18 * Math.sin(now / 200 + n.seed) : 1;
          ctx.beginPath(); ctx.arc(dx, dy, dr * pul, 0, 6.283); ctx.fill(); ctx.stroke();
        }
        if (n.badge) this.badgeChip(x, y - cw * 0.66, n.badge, KIND[n.badgeColor] || C.amber);
        if (n.hit) this.hitRing(n, x, y, cw * 0.48, now);
      }
      ctx.restore();
    }
    drawName(n) {
      const ctx = this.ctx, { x, y } = this.px(n), font = Math.max(this.w < 520 ? 10 : 12, this.base * 0.025 * Math.min(1, 0.4 + 0.6 * (this.opts.scale || 1)));
      ctx.save(); ctx.globalAlpha = n.alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = `600 ${font}px "Geist", sans-serif`; ctx.lineJoin = 'round';
      ctx.strokeStyle = C.bg; ctx.lineWidth = font * 0.32; ctx.strokeText(n.label || n.id, x, y + this.charW(n) * 0.6);
      ctx.fillStyle = n.status === 'offline' ? C.dim : NAVY; ctx.fillText(n.label || n.id, x, y + this.charW(n) * 0.6);
      ctx.restore();
    }
    drawHub(n, x, y, font, now) {
      const ctx = this.ctx, r = this.hubR(n), sh = Math.max(2.5, r * 0.09);
      // machines are named for what they are; a hub turned grey ('sys') is paused, not a machine
      const machine = /^(laptop|server|cloud)$/.test(n.label || '');
      const fill = n.color === 'gold' ? '#F6DF8E' : n.color === 'red' ? '#F4BDB5' : n.color === 'sys' && !machine ? '#E6E1D3' : '#FFFFFF';
      ctx.lineWidth = 2.4; ctx.strokeStyle = NAVY;
      if (machine) {
        // a machine: a little screen on a stand
        ctx.font = `600 ${font}px "Geist Mono", monospace`;
        const bw = Math.max(r * 2.9, ctx.measureText(n.label).width + font * 1.8), bh = Math.max(r * 1.75, font * 2.3);
        ctx.fillStyle = NAVY; ctx.beginPath(); ctx.roundRect(x - bw / 2 + sh, y - bh / 2 + sh, bw, bh, r * 0.3); ctx.fill();
        ctx.fillStyle = fill; ctx.setLineDash(n.color === 'red' ? [6, 5] : []);
        ctx.beginPath(); ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, r * 0.3); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x - bw * 0.22, y + bh / 2 + r * 0.32); ctx.lineTo(x + bw * 0.22, y + bh / 2 + r * 0.32); ctx.moveTo(x, y + bh / 2); ctx.lineTo(x, y + bh / 2 + r * 0.32); ctx.stroke();
        ctx.textBaseline = 'middle'; ctx.fillStyle = n.color === 'red' ? '#9C3B33' : NAVY;
        ctx.fillText(n.label, x, y + 0.5);
        if (n.color === 'red') {
          // unplugged: a red sticker on the corner of the screen
          const cr = font * 0.62, cx = x + bw / 2, cy = y - bh / 2;
          ctx.fillStyle = C.red; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, cr, 0, 6.283); ctx.fill(); ctx.stroke();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; const q = cr * 0.4;
          ctx.beginPath(); ctx.moveTo(cx - q, cy - q); ctx.lineTo(cx + q, cy + q); ctx.moveTo(cx + q, cy - q); ctx.lineTo(cx - q, cy + q); ctx.stroke(); ctx.lineCap = 'butt';
        }
      } else {
        // a channel: a labelled pill, like a sticker
        const f = font * 1.18 * n.size, k = n.scale * (1 + 0.06 * n.glow), dot = !['gold', 'red', 'sys'].includes(n.color);
        ctx.font = `600 ${f}px "Geist Mono", monospace`;
        const pw = ctx.measureText(n.label).width + f * (dot ? 2.6 : 2), ph = f * 2.3, s3 = 3 / k;
        ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        ctx.fillStyle = NAVY; ctx.beginPath(); ctx.roundRect(-pw / 2 + s3, -ph / 2 + s3, pw, ph, ph / 2); ctx.fill();
        ctx.fillStyle = fill; ctx.lineWidth = 2.4 / k; ctx.beginPath(); ctx.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2); ctx.fill(); ctx.stroke();
        if (dot) { ctx.fillStyle = KIND.chat; ctx.beginPath(); ctx.arc(-pw / 2 + f * 0.95, 0, f * 0.3, 0, 6.283); ctx.fill(); }
        ctx.textBaseline = 'middle'; ctx.fillStyle = NAVY; ctx.fillText(n.label, dot ? f * 0.35 : 0, 0.5);
        ctx.restore();
        if (n.badge) this.badgeChip(x, y - ph * 1.2, n.badge, KIND[n.badgeColor] || C.amber);
        if (n.hit) this.hitRing(n, x, y, pw * k / 2, now);
        return;
      }
      if (n.badge) this.badgeChip(x, y - r * 1.7, n.badge, KIND[n.badgeColor] || C.amber);
      if (n.hit) this.hitRing(n, x, y, r, now);
    }
    hitRing(n, x, y, r0, now) {
      const ctx = this.ctx, age = now - n.hit.t0;
      if (age < 700) { const k = age / 700; ctx.lineWidth = 3 * (1 - k); ctx.strokeStyle = rgba(n.hit.color, 1 - k); ctx.beginPath(); ctx.arc(x, y, r0 + k * this.unit * 0.05, 0, 6.283); ctx.stroke(); }
      else n.hit = null;
    }
    // Badges are collected while nodes draw, then placed so none overlap: a badge that would sit on
    // another one moves up a row. Neighbouring seats in demo 4 rely on this.
    badgeChip(x, y, text, color) { (this.badges || (this.badges = [])).push({ x, y, text, color, alpha: this.ctx.globalAlpha }); }
    flushBadges() {
      const list = this.badges || []; this.badges = []; if (!list.length) return;
      const ctx = this.ctx, f = Math.max(this.w < 520 ? 9 : 11, this.base * 0.019), placed = [];
      ctx.font = `600 ${f}px "Geist Mono", monospace`;
      list.sort((a, b) => b.y - a.y || a.x - b.x);
      for (const b of list) {
        b.w = ctx.measureText(b.text).width + f * 2.3; b.h = f * 1.8;
        b.x = Math.max(b.w / 2 + 4, Math.min(this.w - b.w / 2 - 4, b.x));
        for (let i = 0; i < 6 && placed.some((o) => Math.abs(o.x - b.x) < (o.w + b.w) / 2 + 4 && Math.abs(o.y - b.y) < (o.h + b.h) / 2 + 3); i++) b.y -= b.h + 5;
        placed.push(b);
      }
      for (const b of placed) { ctx.save(); ctx.globalAlpha = b.alpha; this.drawBadge(b.x, b.y, b.text, b.color, f); ctx.restore(); }
    }
    drawBadge(x, y, text, color, f) {
      const ctx = this.ctx;
      ctx.font = `600 ${f}px "Geist Mono", monospace`;
      const tw = ctx.measureText(text).width, w = tw + f * 2.3, hh = f * 1.8;
      ctx.fillStyle = NAVY; ctx.beginPath(); ctx.roundRect(x - w / 2 + 2, y - hh / 2 + 2, w, hh, hh / 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = NAVY; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.roundRect(x - w / 2, y - hh / 2, w, hh, hh / 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x - w / 2 + f * 0.85, y, f * 0.32, 0, 6.283); ctx.fill();
      ctx.fillStyle = NAVY; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x - w / 2 + f * 1.5, y + 0.5); ctx.textAlign = 'center';
    }
  }

  // ---------- run control (unchanged contract) ----------
  class Run {
    constructor(auto) { this.auto = auto; this.cancelled = false; this.done = false; this.timers = new Set(); this.rejecters = new Set(); this.manualHooks = new Set(); }
    sleep(ms) { return new Promise((res, rej) => { if (this.cancelled) return rej(CANCELLED); const t = setTimeout(() => { this.timers.delete(t); this.rejecters.delete(rej); res(); }, ms); this.timers.add(t); this.rejecters.add(rej); }); }
    cancel() { this.cancelled = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); for (const r of this.rejecters) r(CANCELLED); this.rejecters.clear(); }
    external() { let resolve; const promise = new Promise((res, rej) => { if (this.cancelled) return rej(CANCELLED); resolve = (v) => { this.rejecters.delete(rej); res(v); }; this.rejecters.add(rej); }); return { promise, resolve }; }
    takeOver() { if (!this.auto) return; this.auto = false; for (const f of this.manualHooks) f(); this.manualHooks.clear(); }
    press(stage, items, { autoAfter = 2200, autoPick, keep = false } = {}) {
      return new Promise((res, rej) => {
        if (this.cancelled) return rej(CANCELLED);
        let autoT = null;
        const finish = (id) => { clearTimeout(autoT); this.rejecters.delete(rej); this.manualHooks.delete(hook); if (!keep) stage.actions([]); else stage.markPressed(id); res(id); };
        const hook = () => { clearTimeout(autoT); stage.clearAutofill(); };
        this.rejecters.add(rej); this.manualHooks.add(hook);
        stage.actions(items.map((it) => ({ ...it, onPress: () => finish(it.id) })));
        if (this.auto) { const id = autoPick || items[0].id; stage.autofill(id, autoAfter); autoT = setTimeout(() => { if (!this.cancelled && this.auto) { sfx.press(); finish(id); } }, autoAfter); }
      });
    }
  }

  // ---------- roster faces: the characters talk ----------
  class CharFace {
    constructor(host, vendor) {
      this.vendor = vendor; this.mood = 'neutral'; this.speaking = false;
      host.innerHTML = `<svg viewBox="-6 -6 116 116">${A.body(vendor)}</svg>`;
      this.svg = host.firstChild; this.blinkLoop();
    }
    set expr(e) { this.mood = ['happy', 'surprised', 'sad'].includes(e) ? e : 'neutral'; if (!this.speaking) this.setMouth(this.mood); }
    setMouth(m) { const g = this.svg.querySelector('.mouth'); if (g) g.outerHTML = `<g class="mouth">${({ neutral: '<path d="M40 66 Q50 75 60 66" fill="none" stroke="#202B43" stroke-width="2.6" stroke-linecap="round"/>', happy: '<path d="M38 63 Q50 81 62 63 Z" fill="#202B43" stroke="#202B43" stroke-width="2.2" stroke-linejoin="round"/>', surprised: '<ellipse cx="50" cy="69" rx="4.4" ry="5.4" fill="#202B43"/>', sad: '<path d="M41 72 Q50 64 59 72" fill="none" stroke="#202B43" stroke-width="2.6" stroke-linecap="round"/>', open: '<ellipse cx="50" cy="68" rx="6.5" ry="5" fill="#202B43"/>', mid: '<ellipse cx="50" cy="68" rx="5" ry="2.6" fill="#202B43"/>' })[m]}</g>`; }
    blinkLoop() { this.blinkT = setTimeout(() => { this.svg.classList.add('blink'); setTimeout(() => { this.svg.classList.remove('blink'); this.blinkLoop(); }, 140); }, 2200 + Math.random() * 2800); }
    speak(text, { cps = 24, onChar } = {}) {
      clearInterval(this.typeT); this.speaking = true; let i = 0;
      return new Promise((resolve) => {
        this.typeT = setInterval(() => {
          if (i >= text.length) { clearInterval(this.typeT); this.speaking = false; this.setMouth(this.mood); resolve(); return; }
          const ch = text[i++]; this.setMouth(/[aeiouAEIOU]/.test(ch) ? 'open' : /[\s.,!?]/.test(ch) ? this.mood : 'mid'); if (onChar) onChar(ch);
        }, 1000 / cps);
      });
    }
    dispose() { clearTimeout(this.blinkT); clearInterval(this.typeT); }
  }

  // ---------- the stage ----------
  const pane = (cls, title, inner) => `<div class="pane ${cls}">${title ? `<div class="ph">${title}</div>` : ''}${inner}</div>`;
  const TEMPLATES = {
    team: pane('roster-pane', '<i class="live"></i>Who is here', '<div class="roster"></div>') + pane('meshwrap', '', '<canvas class="mesh"></canvas>') + pane('feed', 'Activity', '<div class="lines"></div>'),
    modes: '<div class="toolbar"></div>' + pane('meshwrap', '', '<canvas class="mesh"></canvas>') + pane('feed', 'Activity', '<div class="lines"></div>'),
    topo: '<div class="toolbar"></div>' + pane('meshwrap', '', '<canvas class="mesh"></canvas><div class="counter"></div>'),
    lang: pane('code', '<span class="file">ship.cotal.js</span>', '<div class="lines"></div>') + pane('meshwrap', '', '<canvas class="mesh"></canvas><div class="hostbadge">host alive</div>') + pane('journal', 'Journal', '<div class="rows"></div>'),
  };

  class Stage {
    constructor(root, capbar) { this.root = root; this.capbar = capbar; this.faces = new Map(); this.mesh = null; }
    setup(kind) {
      this.teardown(); this.root.className = 'stage ' + kind; this.root.innerHTML = TEMPLATES[kind];
      this.mesh = new Mesh($('.mesh', this.root), { scale: ({ team: 1.3, modes: 1.05, topo: 0.9, lang: 0.8 })[kind] || 1 });
      this.caption('', ''); this.actions([]); this.stats([]);
    }
    teardown() { if (this.mesh) this.mesh.dispose(); this.mesh = null; if (this.codeRo) this.codeRo.disconnect(); for (const f of this.faces.values()) f.dispose(); this.faces.clear(); this.root.classList.remove('dead'); }
    caption(lead, detail, mode) {
      const c = $('.caption', this.capbar); c.classList.remove('swap'); void c.offsetWidth; c.classList.add('swap');
      const l = $('.lead', c); l.textContent = '';
      if (mode) l.append(h('span', 'mode ' + mode.cls, mode.text));
      l.append(document.createTextNode(lead));
      $('.detail', c).textContent = detail || '';
      $('.stats', this.capbar).style.display = 'none';
    }
    stats(list) {
      const s = $('.stats', this.capbar); s.textContent = ''; s.style.display = list.length ? 'flex' : 'none';
      for (const it of list) { const d = h('div', 'stat'); d.append(h('b', null, it.n), h('span', null, it.label)); s.append(d); }
    }
    button(it, extra = '') {
      const b = h('button', 'sbtn ' + extra + ' ' + (it.cls || '') + (it.primary ? ' primary' : '')); b.dataset.id = it.id;
      if (it.id === 'scale') { const c = h('i', 'crowd'); c.innerHTML = `<svg viewBox="-8 -8 240 124">${['pi', 'codex', 'claude'].map((v, k) => `<g transform="translate(${k * 54} ${k === 1 ? -4 : 6}) scale(${k === 1 ? 1 : 0.9})">${A.body(v)}</g>`).join('')}</svg>`; b.append(c); }
      else if (it.cls === 'chat' || it.cls === 'dm' || it.cls === 'any') b.append(h('i', 'env'));
      b.append(h('span', 'lbl', it.label)); if (it.key) b.append(h('span', 'k', it.key === 'Space' ? 'space' : it.key)); b.append(h('span', 'fill'));
      b.onclick = () => { sfx.press(); it.onPress && it.onPress(it.id); };
      return b;
    }
    actions(items) { const box = $('.actions', this.capbar); box.textContent = ''; for (const it of items) box.append(this.button(it)); this._actionItems = items; }
    pressPrimary() { const items = this._actionItems || []; const it = items.find((i) => i.primary) || items[0]; if (it && it.onPress) { sfx.press(); it.onPress(it.id); return true; } return false; }
    pressIndex(i) { const it = (this._actionItems || [])[i]; if (it && it.onPress) { sfx.press(); it.onPress(it.id); return true; } return false; }
    markPressed(id) { for (const b of this.capbar.querySelectorAll('.sbtn')) b.classList.toggle('on', b.dataset.id === id); }
    autofill(id, ms) { const b = this.capbar.querySelector(`.sbtn[data-id="${id}"]`); if (b) { b.style.setProperty('--auto', ms + 'ms'); b.classList.add('autofill'); } }
    clearAutofill() { for (const b of this.capbar.querySelectorAll('.sbtn.autofill')) b.classList.remove('autofill'); }
    toolbar(items, hint) {
      const t = $('.toolbar', this.root); if (!t) return; t.textContent = '';
      for (const it of items) t.append(this.button(it, 'tool'));
      if (hint) t.append(h('span', 'hint', hint));
      this._toolbarItems = items;
    }
    toolbarPress(i) { const it = (this._toolbarItems || [])[i]; if (it && it.onPress) { sfx.press(); it.onPress(it.id); return true; } return false; }
    toolbarMark(id) { for (const b of this.root.querySelectorAll('.toolbar .sbtn')) b.classList.toggle('on', b.dataset.id === id); }
    toolbarAutofill(id, ms) { const b = this.root.querySelector(`.toolbar .sbtn[data-id="${id}"]`); if (b) { b.classList.remove('autofill'); void b.offsetWidth; b.style.setProperty('--auto', ms + 'ms'); b.classList.add('autofill'); } }
    toolbarClearAutofill() { for (const b of this.root.querySelectorAll('.toolbar .sbtn.autofill')) b.classList.remove('autofill'); }
    counter(html) { const c = $('.counter', this.root); if (c) c.innerHTML = html; }
    feed({ from, to, kind = 'chat', text, sys }) {
      const box = $('.feed .lines', this.root); if (!box) return;
      const ln = h('div', 'ln' + (sys ? ' sys' : ''));
      if (sys) { const m = h('span', 'msg'); m.innerHTML = sys; ln.append(h('i', 'dot'), m); }
      else {
        const who = h('div', 'who'); const av = h('i', 'av'); av.innerHTML = `<svg viewBox="-6 -6 116 116">${A.body(vendorOf.get(from))}</svg>`; who.append(av, h('b', null, from));
        if (to) { who.append(h('span', 'arrow', '→')); who.append(h('span', 'to ' + kind, to)); }
        ln.append(who, h('div', 'msg', text));
      }
      box.append(ln); while (box.children.length > 7) box.firstChild.remove();
      sfx.kind(kind);
    }
    roster(agents) { for (const a of agents) this.rosterAdd(a, false); }
    rosterAdd(a, animate = true) {
      const box = $('.roster', this.root); if (!box) return;
      vendorOf.set(a.id, a.vendor);
      const card = h('div', 'agent idle'); card.id = 'ag-' + a.id;
      const face = h('div', 'face'); card.append(face);
      const meta = h('div', 'meta'), name = h('div', 'name');
      name.append(h('b', null, a.id), h('span', 'vend', VENDORS[a.vendor].label));
      meta.append(name, h('div', 'role', a.role), h('div', 'say'));
      card.append(meta, h('i', 'st idle')); box.append(card);
      this.faces.set(a.id, new CharFace(face, a.vendor));
      if (!animate) card.classList.add('in'); else requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
    }
    status(id, s) {
      if (this.mesh) this.mesh.status(id, s);
      const card = $('#ag-' + id, this.root); if (!card) return;
      card.className = 'agent in ' + s; $('.st', card).className = 'st ' + s;
      const f = this.faces.get(id); if (f) f.expr = s === 'waiting' ? 'surprised' : 'neutral';
    }
    think(id, text = 'thinking') { const card = $('#ag-' + id, this.root); if (!card) return; const say = $('.say', card); say.className = 'say think'; say.textContent = ''; say.append(h('span', null, text), h('span', 'cur', '…')); }
    async say(id, text, cps = 26) {
      const card = $('#ag-' + id, this.root); const f = this.faces.get(id); if (!card || !f) return;
      const say = $('.say', card); say.className = 'say talk'; say.textContent = ''; const cur = h('span', 'cur', '▍'); say.append(cur);
      await f.speak(text, { cps, onChar: (ch) => cur.before(document.createTextNode(ch)) });
      cur.remove();
    }
    mood(id, expr, ms) { const f = this.faces.get(id); if (f) f.expr = expr; if (this.mesh) this.mesh.mood(id, expr, ms); if (f && ms) setTimeout(() => { if (f.mood === expr) f.expr = 'neutral'; }, ms); }
    code(lines) {
      const box = $('.code .lines', this.root); if (!box) return; box.textContent = '';
      lines.forEach((src, i) => { const l = h('div', 'l'); l.dataset.i = i; l.append(h('span', 'n', String(i + 1))); const s = h('span', 's'); s.innerHTML = highlight(src); l.append(s); box.append(l); });
      this.fitCode(); document.fonts.ready.then(() => this.fitCode());
      if (!this.codeRo) this.codeRo = new ResizeObserver(() => this.fitCode());
      this.codeRo.disconnect(); this.codeRo.observe(box.parentElement);
    }
    fitCode() {
      const box = $('.code .lines', this.root); if (!box) return; box.style.fontSize = '';
      const base = parseFloat(getComputedStyle(box).fontSize);       // the size the stylesheet gives it
      const room = box.parentElement.clientHeight - box.offsetTop; let wide = box.clientWidth;
      for (const l of box.children) wide = Math.max(wide, l.scrollWidth);
      const k = Math.min(1, box.clientWidth / wide, PHONE.matches ? 1 : room / box.scrollHeight);
      // shrink to fit, but never below 11px: past that the pane scrolls with the highlighted line
      if (k < 1) box.style.fontSize = Math.max(11, base * k * 0.97) + 'px';
    }
    hl(i, cls = 'hl') {
      let on = null;
      for (const l of this.root.querySelectorAll('.code .l')) { l.classList.remove('hl', 'replay'); if (Number(l.dataset.i) === i) { l.classList.add(cls); on = l; } }
      const p = $('.code .lines', this.root);
      if (on && p && p.scrollHeight > p.clientHeight + 2) p.scrollTo({ top: on.offsetTop - p.clientHeight / 2 + on.offsetHeight / 2, behavior: 'smooth' });
    }
    codeDone(i) { const l = this.root.querySelector(`.code .l[data-i="${i}"]`); if (l) l.classList.add('done'); }
    codeReset() { for (const l of this.root.querySelectorAll('.code .l')) l.classList.remove('hl', 'replay', 'done'); }
    journal({ key, scope = '', status = 'pending', note = '' }) {
      const box = $('.journal .rows', this.root); if (!box) return;
      const r = h('div', 'jr ' + status); r.dataset.key = scope + key;
      r.append(h('span', 'i', ICON[status]));
      const k = h('span', 'k'); const br = [...(scope || '').matchAll(/\/b:([^/]+)/g)].map((m) => m[1]);
      if (br.length) k.append(h('span', 'branch', br.join(' · ')));
      k.append(document.createTextNode(key.replace(/#0$/, ''))); r.append(k);
      r.append(h('span', 's', note || (status === 'ok' ? '' : status))); box.append(r);
      while (box.children.length > 24) box.firstChild.remove();
      return r;
    }
    journalSet(fullKey, status, note) { const r = this.root.querySelector(`.jr[data-key="${CSS.escape(fullKey)}"]`); if (!r) return; r.className = 'jr ' + status; $('.i', r).textContent = ICON[status]; $('.s', r).textContent = note || (status === 'ok' ? '' : status); }
    journalFreeze(on) { for (const r of this.root.querySelectorAll('.jr')) r.classList.toggle('frozen', on); }
    journalClear() { const box = $('.journal .rows', this.root); if (box) box.textContent = ''; }
    host(alive, text) { const b = $('.hostbadge', this.root); if (!b) return; b.classList.toggle('dead', !alive); b.textContent = text || (alive ? 'host alive' : 'host dead'); this.root.classList.toggle('dead', !alive); }
  }
  const ICON = { pending: '◌', ok: '✓', replayed: '↺', dead: '✕', live: '●' };
  const highlight = (src) => src.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/("[^"]*")/g, '<span class="str">$1</span>')
    .replace(/\b(const|let|await|async|function|if|for|return)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(spawn|ask|checkpoint|turn|fanOut|parallel|log|notify|wait|race|sleep)(?=\()/g, '<span class="eff">$1</span>');

  // ---------- screen art ----------
  // The attract picture: the logo rings, three characters on them, the conversation from poster 1.
  function attractArt() {
    const s = 0.62, CEN = [243.78, 187.09], X0 = 185.197, Y0 = 128.504, cx = 50, cy = 60;
    const tx = cx - (CEN[0] - X0) * s, ty = cy - (CEN[1] - Y0) * s;
    const P = ([x, y]) => [tx + (x - X0) * s, ty + (y - Y0) * s];
    const [blue, yel, ora] = [[243.78, 166], [225.52, 197.63], [262.04, 197.63]].map(P), R = 28.83 * s;
    const onRing = (c, deg, w) => { const a = deg * Math.PI / 180; return [c[0] + (R + 1.2) * Math.cos(a), c[1] + (R + 1.2) * Math.sin(a)]; };
    const ringPt = (c, deg) => { const a = deg * Math.PI / 180; return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]; };
    const Wb = 16, Wy = 18.5, Wo = 17, kB = Wb / 116;
    const bc = [blue[0], blue[1] - R - Wb * 0.82 + Wb / 2], yc = onRing(yel, -170), oc = onRing(ora, -30);
    const rings = `<g transform="translate(${tx} ${ty}) scale(${s}) translate(${-X0} ${-Y0})">${A.MARK_PATHS.map((d, i) => `<path d="${d}" fill="${[A.RING.blue, A.RING.yellow, A.RING.orange][i]}"/>`).join('')}</g>`;
    const crew = [
      A.character({ vendor: 'claude', look: 'left', cx: bc[0], cy: bc[1], w: Wb, rot: 0, arms: [{ from: [22, 68], via: [4, 74], toAbs: ringPt(blue, -114), hand: 'fist', deg: 'auto' }, { from: [80, 58], via: [104, 58], to: [114, 30], hand: 'open', deg: 28 }] }),
      A.character({ vendor: 'opencode', look: 'upright', cx: yc[0], cy: yc[1], w: Wy, rot: -10, arms: [{ from: [8, 62], via: [-10, 72], to: [-14, 56], hand: 'thumb', deg: 4 }, { from: [92, 62], via: [122, 68], to: [98, 84], hand: 'fist', deg: 'auto', size: 0.9 }] }),
      A.character({ vendor: 'codex', look: 'upleft', cx: oc[0], cy: oc[1], w: Wo, rot: 9, arms: [{ from: [86, 54], via: [120, 54], to: [91, 33], hand: 'flat', deg: -68 }, { from: [14, 60], via: [-18, 68], to: [6, 84], hand: 'fist', deg: 'auto', size: 0.9 }] }),
    ];
    const svg = `<svg viewBox="0 0 100 100" class="art">${rings}${crew.map((c, i) => `<g class="bob b${i}">${c}</g>`).join('')}</svg>`;
    // bubble anchors in % of the box (the viewBox is 0..100)
    const bodyLeft = bc[0] - Wb / 2 + Wb * 0.2, top = bc[1] - Wb / 2;
    const bubbles = [
      { who: 'Claude Code', text: 'Can someone<br>review this?', style: `right:${100 - bodyLeft + 2}%;top:${top - 0.5}%`, tail: 'r' },
      { who: 'Codex', text: 'This fails on<br>empty input.', style: `left:${oc[0] - 5.4}%;bottom:${100 - (oc[1] - Wo / 2) + 0.6}%`, tail: 'b', t: '4.2cqw' },
      { who: 'OpenCode', text: 'Fixed.<br>Added a test.', style: `left:3.5%;bottom:${100 - (yc[1] - Wy / 2) + 0.6}%`, tail: 'b', t: `${yc[0] - 3.5 - 1.2}cqw` },
    ];
    return svg + bubbles.map((b, i) => `<div class="bub tail-${b.tail} q${i}" style="${b.style};${b.t ? '--t:' + b.t : ''}"><small>${b.who}</small>${b.text}</div>`).join('');
  }
  // Small pictures for the four demo cards.
  const cardArt = {
    team: () => `<svg viewBox="0 0 100 62">
      <rect x="35" y="6" width="30" height="11" rx="5.5" fill="#fff" stroke="${NAVY}" stroke-width="1.2"/><text x="50" y="13.6" text-anchor="middle" font-family="Geist Mono" font-weight="600" font-size="5.2" fill="${NAVY}">#general</text>
      <path d="M27 29 L43 17 M50 36 L50 17 M73 29 L57 17" stroke="${NAVY}" stroke-opacity=".25" stroke-width="1"/>
      ${A.character({ vendor: 'claude', look: 'right', cx: 24, cy: 40, w: 24, rot: -4 })}${A.character({ vendor: 'codex', look: 'left', cx: 76, cy: 41, w: 23, rot: 5 })}
      ${A.character({ vendor: 'opencode', look: 'up', cx: 50, cy: 46, w: 20, rot: -2, mood: 'happy' })}</svg>`,
    modes: () => `<svg viewBox="0 0 100 62">
      ${A.character({ vendor: 'opencode', look: 'right', cx: 15, cy: 34, w: 22 })}
      ${[[A.RING.blue, 14, '#general'], [A.RING.orange, 31, 'bob'], ['#5FA866', 48, 'any reviewer']].map(([c, y, t], i) => { const w = t.length * 2.8 + 7;
        return `<path d="M28 34 Q40 ${y} 52 ${y}" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="3 2.4"/>
        <g transform="translate(41 ${(34 + y) / 2 + (y - 34) * 0.18}) rotate(${(y - 34) * 0.6})"><rect x="-4.5" y="-3" width="9" height="6" rx="1.2" fill="${c}" stroke="${NAVY}" stroke-width=".9"/><path d="M-4 -2.6 L0 0.6 L4 -2.6" fill="none" stroke="${NAVY}" stroke-width=".8"/></g>
        <rect x="53" y="${y - 5}" width="${w}" height="10" rx="5" fill="${i === 2 ? '#DCEBD3' : '#fff'}" stroke="${i === 2 ? '#3E7F48' : NAVY}" stroke-width="1.1" ${i === 2 ? 'stroke-dasharray="2.4 1.8"' : ''}/><text x="${53 + w / 2}" y="${y + 1.7}" text-anchor="middle" font-family="Geist Mono" font-weight="600" font-size="4.6" fill="${i === 2 ? '#3E7F48' : NAVY}">${t}</text>`; }).join('')}</svg>`,
    topo: () => { const pts = [0, 1, 2, 3, 4, 5].map((i) => [50 + Math.cos(-1.57 + i * 1.047) * 30, 32 + Math.sin(-1.57 + i * 1.047) * 21]); const vs = ['claude', 'opencode', 'codex', 'hermes', 'pi', 'claude'];
      return `<svg viewBox="0 0 100 62">${pts.map((p, i) => `<line x1="${p[0]}" y1="${p[1]}" x2="${pts[(i + 2) % 6][0]}" y2="${pts[(i + 2) % 6][1]}" stroke="${NAVY}" stroke-opacity=".22" stroke-width="1" stroke-dasharray="2.4 2.4"/><line x1="${p[0]}" y1="${p[1]}" x2="50" y2="32" stroke="${NAVY}" stroke-opacity=".22" stroke-width="1"/>`).join('')}
        <rect x="39.6" y="27.6" width="22" height="9" rx="4.5" fill="${NAVY}"/><rect x="38.5" y="26.5" width="22" height="9" rx="4.5" fill="#fff" stroke="${NAVY}" stroke-width="1.1"/><text x="49.5" y="32.6" text-anchor="middle" font-family="Geist Mono" font-weight="600" font-size="4.4" fill="${NAVY}">#team</text>${pts.map((p, i) => A.character({ vendor: vs[i], cx: p[0], cy: p[1], w: 15, rot: (i % 2 ? 4 : -4) })).join('')}</svg>`; },
    lang: () => `<svg viewBox="0 0 100 62">
      <rect x="31.5" y="3.5" width="37" height="15" rx="3" fill="${NAVY}"/><rect x="30" y="2" width="37" height="15" rx="3" fill="#fff" stroke="${NAVY}" stroke-width="1.1"/>
      <text x="48.5" y="11.6" text-anchor="middle" font-family="Geist Mono" font-weight="600" font-size="5" fill="${NAVY}">fanOut(…)</text>
      ${[[18, 'laptop'], [50, 'server'], [82, 'cloud']].map(([x, t], i) => `<path d="M48.5 17 Q${(x + 48.5) / 2} 24 ${x} 33" fill="none" stroke="#E5B94E" stroke-width="1.3"/>
        <rect x="${x - 12.5}" y="44.5" width="26" height="13" rx="2.5" fill="${NAVY}"/><rect x="${x - 13.5}" y="43.5" width="26" height="13" rx="2.5" fill="${i === 0 ? '#F4BDB5' : '#fff'}" stroke="${NAVY}" stroke-width="1.1" ${i === 0 ? 'stroke-dasharray="2.4 2"' : ''}/>
        <text x="${x - 0.5}" y="51.6" text-anchor="middle" font-family="Geist Mono" font-weight="600" font-size="4.4" fill="${NAVY}">${t}</text>
        ${A.character({ vendor: ['opencode', 'claude', 'codex'][i], cx: x - 0.5, cy: 35, w: 14, look: i === 0 ? 'down' : null, rot: i === 0 ? -8 : 0 })}`).join('')}</svg>`,
  };
  const qrSvg = () => { const m = window.BOOTH_QR, n = m.length; let r = ''; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x] === '1') r += `M${x} ${y}h1v1h-1z`; return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${r}" fill="${NAVY}"/></svg>`; };

  // ---------- the app ----------
  const FS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="go" d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/><path class="back" d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';
  const PERSONAL = new URLSearchParams(location.search).has('qr') || matchMedia('(max-width: 760px), (max-height: 500px)').matches;
  const PHONE = matchMedia('(max-width: 760px) and (orientation: portrait)');


  const App = {
    screen: null, run: null, demoIndex: 0, swallowClick: 0, auto: false, autoNext: 0, lastInput: Date.now(), autoTimer: null,
    init() {
      this.stage = new Stage($('#stage'), $('#capbar'));
      document.body.classList.toggle('personal', PERSONAL); document.body.classList.toggle('shot', SHOT);
      for (const el of document.querySelectorAll('[data-mark]')) el.innerHTML = el.dataset.mark === 'colour' ? A.markColour() : A.mark('currentColor');
      for (const el of document.querySelectorAll('.qr')) el.innerHTML = qrSvg();
      $('#attract .art-box').innerHTML = attractArt();
      this.buildHome(); this.attractLoop();
      $('#demo .back').onclick = () => this.showHome();
      window.addEventListener('pointerdown', (e) => this.onInput(e), true);
      window.addEventListener('click', (e) => { if (Date.now() < this.swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);
      window.addEventListener('keydown', (e) => this.onKey(e), true);
      window.addEventListener('resize', () => { if (this.stage) this.stage.fitCode(); });
      window.addEventListener('mousemove', () => { this.lastInput = Date.now(); }, { passive: true });
      setInterval(() => this.tick(), 1000);
      $('#hud-help').onclick = (e) => { e.stopPropagation(); $('#help').classList.toggle('on'); };
      // the fullscreen buttons show only where the page can go fullscreen (not on an iPhone)
      const fsButtons = [...document.querySelectorAll('.fs')];
      for (const b of fsButtons) { if (!document.fullscreenEnabled) { b.remove(); continue; } b.innerHTML = FS_ICON; b.onclick = (e) => { e.stopPropagation(); this.fullscreen(); }; }
      document.addEventListener('fullscreenchange', () => { for (const b of fsButtons) b.classList.toggle('on', !!document.fullscreenElement); });
      // ?demo=1..4 opens a demo straight away (add &auto=0 to drive it by hand); ?screen=home opens the picker
      const q = new URLSearchParams(location.search);
      if (q.has('demo')) this.startDemo(Number(q.get('demo')) - 1, q.get('auto') !== '0');
      else if (q.get('screen') === 'home') this.showHome();
      else this.showAttract();
    },
    show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); this.screen = id; document.body.classList.toggle('auto', this.auto && id === 'demo'); },
    // The three bubbles from poster 1 appear in turn, then start again.
    attractLoop() {
      const box = $('#attract .art-box'); let i = 0;
      const step = () => { if (this.screen === 'attract') { const k = i % 5; for (let j = 0; j < 3; j++) box.querySelector('.q' + j).classList.toggle('on', j < k); } i++; };
      step(); setInterval(step, 1500);
    },
    showAttract() { this.stopRun(); this.show('attract'); this.autoTimer = Date.now(); },
    showHome() { this.stopRun(); this.auto = false; this.show('home'); },
    buildHome() {
      const grid = $('#home .cards'); grid.textContent = '';
      window.DEMOS.forEach((d, i) => {
        const c = h('button', 'card c' + i); c.onclick = () => this.startDemo(i, false);
        const art = h('div', 'card-art'); art.innerHTML = (cardArt[d.id] || cardArt.team)();
        const top = h('div', 'card-top'); top.append(h('span', 'num', String(i + 1)), h('span', 'secs', d.secs + ' s'));
        const tags = h('div', 'tags'); for (const t of d.tags) tags.append(h('span', 'tag ' + (t.cls || ''), t.text));
        const play = h('span', 'play'); play.append(h('span', null, 'Play'), h('i', null, '→'));
        c.append(art, top, h('h2', null, d.title), h('p', null, d.hook), tags, play);
        grid.append(c);
      });
    },
    async startDemo(i, auto) {
      this.stopRun();
      this.demoIndex = (i + window.DEMOS.length) % window.DEMOS.length; this.auto = auto;
      const demo = window.DEMOS[this.demoIndex];
      this.show('demo');
      $('#demo .title').textContent = demo.title;
      const dots = $('#demo .dots'); dots.textContent = ''; window.DEMOS.forEach((_, j) => dots.append(h('i', j === this.demoIndex ? 'on' : '')));
      const run = new Run(auto); this.run = run;
      this.stage.setup(demo.layout);
      try { await demo.run(this.stage, run, { C, KIND, VENDORS, sfx, pick, nameColor, next: () => this.startDemo(this.demoIndex + 1, false) }); }
      catch (e) { if (e !== CANCELLED) { console.error('demo error: ' + (e && e.stack || e)); this.stage.caption('Something went wrong in this demo.', String(e && e.message || e)); } }
      if (run.cancelled) return;
      run.done = true; this.lastInput = Date.now();
      this.stage.actions([
        { id: 'replay', label: 'Replay', key: 'R', onPress: () => this.startDemo(this.demoIndex, false) },
        { id: 'next', label: 'Next demo', key: '→', primary: true, onPress: () => this.startDemo(this.demoIndex + 1, false) },
        { id: 'home', label: 'All demos', key: 'Esc', cls: 'ghost', onPress: () => this.showHome() },
      ]);
      if (run.auto) { try { await run.sleep(7000); } catch { return; } if (!run.cancelled) { this.autoNext = this.demoIndex + 1; this.showAttract(); } }
    },
    stopRun() { if (this.run) { this.run.cancel(); this.run = null; } this.stage.teardown(); this.stage.actions([]); },
    onInput(e) {
      this.lastInput = Date.now();
      if (e.target.closest('#hud-help, .fs') || e.target.closest('#help')) return;
      if ($('#help').classList.contains('on')) { $('#help').classList.remove('on'); e.stopPropagation(); e.preventDefault(); return; }
      if (this.screen === 'attract') { e.stopPropagation(); e.preventDefault(); this.swallowClick = Date.now() + 700; this.showHome(); return; }
      if (this.screen === 'demo' && this.run && this.run.auto) { this.run.takeOver(); this.auto = false; document.body.classList.remove('auto'); }
    },
    onKey(e) {
      this.lastInput = Date.now(); const k = e.key;
      if (k === 'f' || k === 'F') { this.fullscreen(); return; }
      if (k === 'm' || k === 'M') { sfx.on = !sfx.on; sfx.ensure(); $('#hud-help').classList.toggle('on', sfx.on); return; }
      if (k === '?' || k === 'h' || k === 'H') { $('#help').classList.toggle('on'); return; }
      if ($('#help').classList.contains('on')) { $('#help').classList.remove('on'); return; }
      if (this.screen === 'attract') { this.showHome(); return; }
      if (this.screen === 'home') {
        const n = parseInt(k, 10); if (n >= 1 && n <= window.DEMOS.length) this.startDemo(n - 1, false);
        else if (k === 'Escape') this.showAttract(); else if (k === 'Enter' || k === ' ') this.startDemo(0, false);
        return;
      }
      if (this.screen === 'demo') {
        if (this.run && this.run.auto) { this.run.takeOver(); this.auto = false; document.body.classList.remove('auto'); }
        if (k === 'Escape') this.showHome();
        else if (k === 'r' || k === 'R') this.startDemo(this.demoIndex, false);
        else if (k === 'ArrowRight' || k === 'n' || k === 'N') this.startDemo(this.demoIndex + 1, false);
        else if (k === 'ArrowLeft' || k === 'p' || k === 'P') this.startDemo(this.demoIndex - 1, false);
        else if (k === ' ' || k === 'Enter') { e.preventDefault(); this.stage.pressPrimary(); }
        else { const n = parseInt(k, 10); if (n >= 1 && n <= 9) { if (!this.stage.toolbarPress(n - 1)) this.stage.pressIndex(n - 1); } }
      }
    },
    tick() {
      if (PERSONAL) return;
      const idle = (Date.now() - this.lastInput) / 1000;
      document.body.classList.toggle('nocursor', idle > 4);
      if (this.screen === 'home' && idle > 75) this.showAttract();
      else if (this.screen === 'demo' && this.run && !this.run.auto && idle > (this.run.done ? 45 : 120)) this.showAttract();
      else if (this.screen === 'attract') { const shown = (Date.now() - this.autoTimer) / 1000; if (idle > 30 && shown > (this.autoNext ? 8 : 25)) { const i = this.autoNext || 0; this.autoNext = 0; this.startDemo(i, true); } }
    },
    fullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); },
  };

  window.Booth = { App, Mesh, Run, Stage, CANCELLED, C, KIND, VENDORS, sfx, pick, nameColor, mulberry, PERSONAL, PHONE };
  window.addEventListener('DOMContentLoaded', () => App.init());
})();
