// Cotal booth demo engine: the constellation canvas, the stage panels, run control with
// cancellation, keyboard/touch input, the idle attract loop and optional sound.
// Demos live in demos.js and drive this through `stage` and `run`.
'use strict';
(() => {
  // ---------- utils ----------
  const $ = (s, root = document) => root.querySelector(s);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const CANCELLED = Symbol('cancelled');
  const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];

  const C = { bg: '#0d1117', fg: '#e6edf3', dim: '#8b949e', faint: '#6e7681', blue: '#58a6ff', green: '#3fb950', amber: '#d29922', waiting: '#e3b341', red: '#f85149', gold: '#e9c46a', line: '#5b6b82' };
  const STATUS = { working: C.green, waiting: C.waiting, idle: C.faint, offline: C.faint };
  const KIND = { chat: C.blue, dm: C.amber, anycast: C.green, sys: C.dim, gold: C.gold };
  const VENDORS = {
    claude: { label: 'Claude Code', img: 'assets/claude-code.svg' },
    opencode: { label: 'OpenCode', img: 'assets/opencode.svg' },
    codex: { label: 'Codex', img: 'assets/codex.svg' },
    hermes: { label: 'Hermes', img: 'assets/hermes.png' },
    pi: { label: 'pi', img: 'assets/pi.svg' },
  };
  const vendorImg = {};
  for (const [k, v] of Object.entries(VENDORS)) { const im = new Image(); im.src = v.img; vendorImg[k] = im; }
  const NAME_COLORS = ['#60a5fa', '#fb923c', '#ec4899', '#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#f87171', '#2dd4bf'];
  const nameColors = new Map();
  const nameColor = (n) => { if (!nameColors.has(n)) nameColors.set(n, NAME_COLORS[nameColors.size % NAME_COLORS.length]); return nameColors.get(n); };

  // ---------- sound (off by default; M toggles) ----------
  const sfx = {
    on: false, ctx: null,
    ensure() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; } } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    tone(freq, dur = 0.09, type = 'sine', gain = 0.05) {
      if (!this.on) return; this.ensure(); if (!this.ctx) return;
      const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    kind(k) { this.tone({ chat: 660, dm: 520, anycast: 780, sys: 420, gold: 880 }[k] || 600); },
    press() { this.tone(300, 0.06, 'triangle', 0.06); },
    ok() { this.tone(880, 0.12); setTimeout(() => this.tone(1320, 0.16), 90); },
    bad() { this.tone(160, 0.3, 'sawtooth', 0.05); },
  };

  // ---------- the constellation ----------
  class Mesh {
    constructor(canvas, opts = {}) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.opts = opts;
      this.nodes = new Map(); this.edges = []; this.temp = []; this.pulses = []; this.alive = true;
      const rand = mulberry(opts.seed || 7);
      this.stars = Array.from({ length: 170 }, () => ({ x: rand(), y: rand(), r: 0.5 + rand() * 1.4, p: rand() * 6.28 }));
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
      this.resize();
      this.frame = (t) => { if (!this.alive) return; if (!this.paused) this.draw(t); requestAnimationFrame(this.frame); };
      requestAnimationFrame(this.frame);
    }
    dispose() { this.alive = false; this.ro.disconnect(); }
    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = this.cv.clientWidth, hh = this.cv.clientHeight; if (!w || !hh) return;
      this.w = w; this.h = hh; this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(hh * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.unit = Math.min(w, hh) * (this.opts.scale || 1);
    }
    px(n) { return { x: n.x * this.w, y: n.y * this.h }; }
    add(n) {
      const node = { kind: 'agent', status: 'idle', alpha: 0, badge: null, glow: 0, scale: 0.3, size: 1, ...n };
      node.tx = n.x; node.ty = n.y;
      if (n.from) { node.x = n.from.x; node.y = n.from.y; }
      this.nodes.set(n.id, node); return node;
    }
    remove(id) { const n = this.nodes.get(id); if (n) n.dying = true; }
    get(id) { return this.nodes.get(id); }
    has(id) { return this.nodes.has(id); }
    move(id, x, y) { const n = this.nodes.get(id); if (n) { n.tx = x; n.ty = y; } }
    status(id, s) { const n = this.nodes.get(id); if (n) { n.status = s; n.glow = 1; } }
    badge(id, text) { const n = this.nodes.get(id); if (n) n.badge = text; }
    link(a, b, kind = 'member') { if (!this.edges.some((e) => e.a === a && e.b === b)) this.edges.push({ a, b, kind, glow: 0 }); }
    unlink(a, b) { this.edges = this.edges.filter((e) => !(e.a === a && e.b === b)); }
    clearEdges() { this.edges = []; }
    clear() { this.nodes.clear(); this.edges = []; this.temp = []; for (const p of this.pulses) p.res(); this.pulses = []; }
    // A travelling message dot; resolves when it arrives.
    pulse(from, to, kind = 'chat', opts = {}) {
      return new Promise((res) => {
        this.pulses.push({ from, to, kind, t0: performance.now() + (opts.delay || 0), dur: opts.dur || 650, res, size: opts.size || 1 });
      });
    }
    dashed(a, b, kind, ms = 1500) { this.temp.push({ a, b, kind, until: performance.now() + ms, t0: performance.now() }); }
    ring(id, color) { const n = this.nodes.get(id); if (n) n.hit = { color, t0: performance.now() }; }
    draw(now) {
      const { ctx, w, h: hh } = this; if (!w) return;
      ctx.clearRect(0, 0, w, hh);
      for (const s of this.stars) {
        const a = 0.18 + 0.2 * Math.sin(now / 1500 + s.p);
        ctx.fillStyle = `rgba(200,214,235,${a})`; ctx.beginPath(); ctx.arc(s.x * w, s.y * hh, s.r, 0, 6.283); ctx.fill();
      }
      for (const [id, n] of this.nodes) {
        if (n.drift) { n.tx += Math.sin(now / 4000 + n.seed) * 0.00025; n.ty += Math.cos(now / 5200 + n.seed * 1.7) * 0.00025; }
        n.x = lerp(n.x, n.tx, 0.085); n.y = lerp(n.y, n.ty, 0.085);
        if (n.dying) { n.alpha = lerp(n.alpha, 0, 0.14); if (n.alpha < 0.02) this.nodes.delete(id); }
        else { n.alpha = lerp(n.alpha, 1, 0.07); n.scale = lerp(n.scale, 1, 0.1); }
        n.glow = Math.max(0, n.glow - 0.018);
      }
      // membership edges
      for (const e of this.edges) {
        const a = this.nodes.get(e.a), b = this.nodes.get(e.b); if (!a || !b) continue;
        const pa = this.px(a), pb = this.px(b); const alpha = Math.min(a.alpha, b.alpha);
        const off = a.status === 'offline' || b.status === 'offline';
        ctx.setLineDash(off ? [4, 6] : []); ctx.lineWidth = 1 + e.glow * 1.6;
        ctx.strokeStyle = e.glow > 0.02 ? rgba(KIND[e.kind] || C.blue, alpha * (0.3 + 0.7 * e.glow)) : rgba(C.line, alpha * (off ? 0.22 : 0.42));
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        e.glow = Math.max(0, e.glow - 0.014);
      }
      // temporary dashed lines (dm / anycast candidates)
      this.temp = this.temp.filter((t) => t.until > now);
      for (const t of this.temp) {
        const a = this.nodes.get(t.a), b = this.nodes.get(t.b); if (!a || !b) continue;
        const pa = this.px(a), pb = this.px(b); const life = (t.until - now) / (t.until - t.t0);
        ctx.setLineDash([6, 6]); ctx.lineDashOffset = -now / 25; ctx.lineWidth = 1.4;
        ctx.strokeStyle = rgba(KIND[t.kind], 0.25 + 0.55 * Math.min(1, life * 2));
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      // pulses
      const keep = [];
      for (const p of this.pulses) {
        const a = this.nodes.get(p.from), b = this.nodes.get(p.to);
        if (!a || !b) { p.res(); continue; }
        const t = (now - p.t0) / p.dur;
        if (t < 0) { keep.push(p); continue; }
        const pa = this.px(a), pb = this.px(b), col = KIND[p.kind] || C.blue;
        if (t >= 1) {
          p.res(); b.glow = 1; b.hit = { color: col, t0: now };
          const e = this.edges.find((e) => (e.a === p.from && e.b === p.to) || (e.a === p.to && e.b === p.from)); if (e) { e.glow = 1; e.kind = p.kind; }
          continue;
        }
        const k = easeInOut(t);
        ctx.strokeStyle = rgba(col, 0.18); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        for (let i = 3; i >= 0; i--) {
          const kk = easeInOut(Math.max(0, t - i * 0.045));
          const x = lerp(pa.x, pb.x, kk), y = lerp(pa.y, pb.y, kk);
          ctx.fillStyle = rgba(col, i === 0 ? 1 : 0.35 - i * 0.08); ctx.shadowColor = col; ctx.shadowBlur = i === 0 ? 16 : 0;
          ctx.beginPath(); ctx.arc(x, y, (i === 0 ? 4.5 : 3) * p.size, 0, 6.283); ctx.fill();
        }
        ctx.shadowBlur = 0; keep.push(p);
      }
      this.pulses = keep;
      // nodes
      const u = this.unit;
      const font = Math.max(13, u * 0.021);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (const n of this.nodes.values()) {
        const { x, y } = this.px(n); ctx.globalAlpha = n.alpha;
        if (n.kind === 'label') {
          ctx.font = `500 ${font}px "JetBrains Mono", monospace`; ctx.fillStyle = rgba(KIND[n.color] || C.dim, 0.9); ctx.fillText(n.label, x, y);
          if (n.badge) { this.drawBadge(x + ctx.measureText(n.label).width / 2 + 10, y + font * 0.6, n.badge, C.green); }
          ctx.globalAlpha = 1; continue;
        }
        if (n.kind === 'channel') {
          const r = u * 0.04 * n.scale * n.size, cc = KIND[n.color] || C.blue;
          ctx.shadowColor = cc; ctx.shadowBlur = 16 + 26 * n.glow;
          ctx.fillStyle = n.color === 'gold' ? '#2a2417' : '#10203a'; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
          ctx.shadowBlur = 0; ctx.lineWidth = 2; ctx.strokeStyle = rgba(cc, 0.75 + 0.25 * n.glow); ctx.stroke();
          ctx.fillStyle = rgba(cc, 0.5 + 0.5 * n.glow); ctx.beginPath(); ctx.arc(x, y, r * 0.22, 0, 6.283); ctx.fill();
          ctx.font = `600 ${font}px "JetBrains Mono", monospace`; ctx.fillStyle = '#c9d1d9'; ctx.fillText(n.label, x, y + r + 6);
        } else {
          const r = u * 0.027 * n.scale * n.size; const col = STATUS[n.status] || C.faint;
          if (n.status === 'offline') {
            ctx.setLineDash([3, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(C.faint, 0.8);
            ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
          } else {
            ctx.shadowColor = col; ctx.shadowBlur = n.status === 'idle' ? 0 : 10 + 24 * n.glow;
            ctx.fillStyle = n.status === 'idle' ? rgba(C.faint, 0.55) : '#131a26'; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
            ctx.shadowBlur = 0; ctx.lineWidth = 2.2; ctx.strokeStyle = rgba(col, 0.95); ctx.stroke();
            if (n.status !== 'idle') {
              const pul = n.status === 'working' ? 0.75 + 0.25 * Math.sin(now / 220) : 1;
              ctx.fillStyle = rgba(col, pul); ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, 6.283); ctx.fill();
            }
          }
          if (n.vendor && vendorImg[n.vendor] && vendorImg[n.vendor].complete && vendorImg[n.vendor].naturalWidth && n.size >= 0.8) {
            const br = r * 0.56, bx = x + r * 0.78, by = y - r * 0.78;
            ctx.fillStyle = '#0d1117'; ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.283); ctx.fill();
            ctx.lineWidth = 1; ctx.strokeStyle = rgba(C.line, 0.8); ctx.stroke();
            ctx.save(); ctx.beginPath(); ctx.arc(bx, by, br - 1.5, 0, 6.283); ctx.clip();
            const s = (br - 1.5) * 2 * 0.78; ctx.drawImage(vendorImg[n.vendor], bx - s / 2, by - s / 2, s, s); ctx.restore();
          }
          if (n.size >= 0.8 || n.label) {
            ctx.font = `500 ${font * (n.size < 0.8 ? 0.8 : 1)}px "JetBrains Mono", monospace`; ctx.fillStyle = n.size < 0.8 ? rgba('#c9d1d9', 0.6) : '#c9d1d9';
            if (n.size >= 0.8) ctx.fillText(n.label || n.id, x, y + r + 5);
          }
          if (n.badge) this.drawBadge(x - r * 0.9, y - r * 1.15, n.badge, C.amber);
        }
        if (n.hit) {
          const age = now - n.hit.t0;
          if (age < 750) { const k = age / 750; ctx.lineWidth = 2 * (1 - k); ctx.strokeStyle = rgba(n.hit.color, 1 - k); ctx.beginPath(); ctx.arc(x, y, u * 0.027 * n.size + k * u * 0.06, 0, 6.283); ctx.stroke(); }
          else n.hit = null;
        }
        ctx.globalAlpha = 1;
      }
    }
    drawBadge(x, y, text, color) {
      const ctx = this.ctx, f = Math.max(11, this.unit * 0.015);
      ctx.font = `600 ${f}px "JetBrains Mono", monospace`;
      const w = ctx.measureText(text).width + f * 1.1, hh = f * 1.6;
      ctx.fillStyle = rgba(color, 0.18); ctx.strokeStyle = rgba(color, 0.9); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - hh / 2, w, hh, hh / 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5); ctx.textBaseline = 'top';
    }
  }

  // ---------- run control ----------
  class Run {
    constructor(auto) { this.auto = auto; this.cancelled = false; this.done = false; this.timers = new Set(); this.rejecters = new Set(); this.manualHooks = new Set(); }
    sleep(ms) {
      return new Promise((res, rej) => {
        if (this.cancelled) return rej(CANCELLED);
        const t = setTimeout(() => { this.timers.delete(t); this.rejecters.delete(rej); res(); }, ms);
        this.timers.add(t); this.rejecters.add(rej);
      });
    }
    cancel() {
      this.cancelled = true;
      for (const t of this.timers) clearTimeout(t); this.timers.clear();
      for (const r of this.rejecters) r(CANCELLED); this.rejecters.clear();
    }
    // A promise a demo resolves from outside (a toolbar press); cancelling the run rejects it.
    external() {
      let resolve;
      const promise = new Promise((res, rej) => {
        if (this.cancelled) return rej(CANCELLED);
        resolve = (v) => { this.rejecters.delete(rej); res(v); }; this.rejecters.add(rej);
      });
      return { promise, resolve };
    }
    // A visitor interacted with an auto-running demo: hand control to them.
    takeOver() { if (!this.auto) return; this.auto = false; for (const f of this.manualHooks) f(); this.manualHooks.clear(); }
    // Show buttons; resolve with the pressed id. In auto mode, press `autoPick` (or the first) after `autoAfter` ms.
    press(stage, items, { autoAfter = 2200, autoPick, keep = false } = {}) {
      return new Promise((res, rej) => {
        if (this.cancelled) return rej(CANCELLED);
        let autoT = null;
        const finish = (id) => {
          clearTimeout(autoT); this.rejecters.delete(rej); this.manualHooks.delete(hook);
          if (!keep) stage.actions([]); else stage.markPressed(id);
          res(id);
        };
        const hook = () => { clearTimeout(autoT); stage.clearAutofill(); };
        this.rejecters.add(rej); this.manualHooks.add(hook);
        stage.actions(items.map((it) => ({ ...it, onPress: () => finish(it.id) })));
        if (this.auto) {
          const id = autoPick || items[0].id;
          stage.autofill(id, autoAfter);
          autoT = setTimeout(() => { if (!this.cancelled && this.auto) { sfx.press(); finish(id); } }, autoAfter);
        }
      });
    }
  }

  // ---------- the stage (panels around the canvas) ----------
  const TEMPLATES = {
    team: `<div class="pane roster-pane"><div class="ph"><span class="live"></span>roster</div><div class="roster"></div></div>
           <div class="pane meshwrap"><canvas class="mesh"></canvas></div>
           <div class="pane feed"><div class="ph">activity</div><div class="lines"></div></div>`,
    modes: `<div class="toolbar"></div>
            <div class="pane meshwrap"><canvas class="mesh"></canvas></div>
            <div class="pane feed"><div class="ph">activity</div><div class="lines"></div></div>`,
    topo: `<div class="toolbar"></div>
           <div class="pane meshwrap"><canvas class="mesh"></canvas><div class="counter"></div></div>`,
    lang: `<div class="pane code"><div class="ph">ship.cotal.js</div><div class="lines"></div></div>
           <div class="pane meshwrap"><canvas class="mesh"></canvas><div class="hostbadge">host alive</div></div>
           <div class="pane journal"><div class="ph">journal</div><div class="rows"></div></div>`,
  };

  class Stage {
    constructor(root, capbar) { this.root = root; this.capbar = capbar; this.faces = new Map(); this.mesh = null; this.clock = 0; }
    setup(kind) {
      this.teardown();
      this.root.className = 'stage ' + kind; this.root.innerHTML = TEMPLATES[kind];
      this.mesh = new Mesh($('.mesh', this.root), { seed: kind.length * 13, scale: kind === 'lang' ? 1.55 : 1 });
      this.caption('', ''); this.actions([]); this.stats([]);
      this.clock = Date.now();
    }
    teardown() {
      if (this.mesh) this.mesh.dispose(); this.mesh = null;
      for (const f of this.faces.values()) f.dispose(); this.faces.clear();
      this.root.classList.remove('dead');
    }
    // caption bar
    caption(lead, detail, mode) {
      const c = $('.caption', this.capbar); c.classList.remove('swap'); void c.offsetWidth; c.classList.add('swap');
      const l = $('.lead', c); l.textContent = '';
      if (mode) { const m = h('span', 'mode ' + mode.cls, mode.text); l.append(m); }
      l.append(document.createTextNode(lead));
      $('.detail', c).textContent = detail || '';
      $('.stats', c).style.display = 'none';
    }
    stats(list) {
      const s = $('.stats', this.capbar); s.textContent = ''; s.style.display = list.length ? 'flex' : 'none';
      for (const it of list) { const d = h('div', 'stat'); d.append(h('b', null, it.n), h('span', null, it.label)); s.append(d); }
    }
    actions(items) {
      const box = $('.actions', this.capbar); box.textContent = '';
      for (const it of items) {
        const b = h('button', 'btn ' + (it.cls || '') + (it.primary ? ' primary' : '')); b.dataset.id = it.id;
        b.append(document.createTextNode(it.label));
        if (it.key) b.append(h('span', 'k', it.key));
        b.append(h('span', 'fill'));
        b.onclick = () => { sfx.press(); it.onPress && it.onPress(it.id); };
        box.append(b);
      }
      this._actionItems = items;
    }
    pressPrimary() {
      const items = this._actionItems || []; const it = items.find((i) => i.primary) || items[0];
      if (it && it.onPress) { sfx.press(); it.onPress(it.id); return true; } return false;
    }
    pressIndex(i) { const it = (this._actionItems || [])[i]; if (it && it.onPress) { sfx.press(); it.onPress(it.id); return true; } return false; }
    markPressed(id) { for (const b of this.capbar.querySelectorAll('.btn')) b.classList.toggle('on', b.dataset.id === id); }
    autofill(id, ms) { const b = this.capbar.querySelector(`.btn[data-id="${id}"]`); if (b) { b.style.setProperty('--auto', ms + 'ms'); b.classList.add('autofill'); } }
    clearAutofill() { for (const b of this.capbar.querySelectorAll('.btn.autofill')) b.classList.remove('autofill'); }
    // persistent toolbar (modes / topologies); items: {id,label,key,cls,onPress}
    toolbar(items, hint) {
      const t = $('.toolbar', this.root); if (!t) return; t.textContent = '';
      for (const it of items) {
        const b = h('button', 'btn ' + (it.cls || '')); b.dataset.id = it.id;
        b.append(document.createTextNode(it.label)); if (it.key) b.append(h('span', 'k', it.key)); b.append(h('span', 'fill'));
        b.onclick = () => { sfx.press(); it.onPress && it.onPress(it.id); };
        t.append(b);
      }
      if (hint) t.append(h('span', 'hint', hint));
      this._toolbarItems = items;
    }
    toolbarPress(i) { const it = (this._toolbarItems || [])[i]; if (it && it.onPress) { sfx.press(); it.onPress(it.id); return true; } return false; }
    toolbarMark(id) { for (const b of this.root.querySelectorAll('.toolbar .btn')) b.classList.toggle('on', b.dataset.id === id); }
    toolbarAutofill(id, ms) { const b = this.root.querySelector(`.toolbar .btn[data-id="${id}"]`); if (b) { b.classList.remove('autofill'); void b.offsetWidth; b.style.setProperty('--auto', ms + 'ms'); b.classList.add('autofill'); } }
    toolbarClearAutofill() { for (const b of this.root.querySelectorAll('.toolbar .btn.autofill')) b.classList.remove('autofill'); }
    counter(html) { const c = $('.counter', this.root); if (c) c.innerHTML = html; }
    // feed
    feed({ from, to, kind = 'chat', text, sys }) {
      const box = $('.feed .lines', this.root); if (!box) return;
      const ln = h('div', 'ln' + (sys ? ' sys' : ''));
      if (sys) { const m = h('span', 'msg'); m.innerHTML = sys; ln.append(m); }
      else {
        const who = h('span', 'who'); const f = h('b', null, from); f.style.color = nameColor(from); who.append(f);
        if (to) { who.append(h('span', 'arrow', '→')); who.append(h('span', 'to ' + kind, to)); }
        ln.append(who, h('span', 'msg', text));
      }
      box.append(ln); while (box.children.length > 9) box.firstChild.remove();
      sfx.kind(kind);
    }
    // roster with faces
    roster(agents) {
      const box = $('.roster', this.root); if (!box) return;
      for (const a of agents) this.rosterAdd(a, false);
    }
    rosterAdd(a, animate = true) {
      const box = $('.roster', this.root); if (!box) return;
      const card = h('div', 'agent idle'); card.id = 'ag-' + a.id;
      const cv = document.createElement('canvas'); card.append(cv);
      const meta = h('div', 'meta');
      const name = h('div', 'name'); name.append(h('i', 'st idle'));
      const nm = h('b', null, a.id); nm.style.color = nameColor(a.id); name.append(nm);
      const im = new Image(); im.src = VENDORS[a.vendor].img; im.title = VENDORS[a.vendor].label; im.className = 'vendor'; name.append(im);
      const say = h('div', 'say');
      meta.append(name, h('div', 'role', a.role), say); card.append(meta); box.append(card);
      this.faces.set(a.id, new window.Face(cv, a.persona));
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
      if (!animate) card.classList.add('in');
    }
    status(id, s) {
      if (this.mesh) this.mesh.status(id, s);
      const card = $('#ag-' + id, this.root); if (!card) return;
      card.className = 'agent in ' + s; $('.st', card).className = 'st ' + s;
      const f = this.faces.get(id); if (f) f.expr = s === 'working' ? 'neutral' : s === 'waiting' ? 'surprised' : 'neutral';
    }
    think(id, text = 'thinking') {
      const card = $('#ag-' + id, this.root); if (!card) return;
      const say = $('.say', card); say.textContent = ''; const span = h('span', null, text); const dots = h('span', 'cur', '…'); say.append(span, dots);
    }
    async say(id, text, cps = 26) {
      const card = $('#ag-' + id, this.root); const f = this.faces.get(id); if (!card || !f) return;
      const say = $('.say', card); say.textContent = ''; const cur = h('span', 'cur', '▮'); say.append(cur);
      await f.speak(text, { cps, onChar: (ch) => cur.before(document.createTextNode(ch)) });
      cur.remove();
    }
    mood(id, expr) { const f = this.faces.get(id); if (f) f.expr = expr; }
    // lang panels
    code(lines) {
      const box = $('.code .lines', this.root); if (!box) return; box.textContent = '';
      lines.forEach((src, i) => {
        const l = h('div', 'l'); l.dataset.i = i; l.append(h('span', 'n', String(i + 1)));
        const s = h('span', 's'); s.innerHTML = highlight(src); l.append(s); box.append(l);
      });
    }
    hl(i, cls = 'hl') { for (const l of this.root.querySelectorAll('.code .l')) { l.classList.remove('hl', 'replay'); if (Number(l.dataset.i) === i) l.classList.add(cls); } }
    codeDone(i) { const l = this.root.querySelector(`.code .l[data-i="${i}"]`); if (l) l.classList.add('done'); }
    codeReset() { for (const l of this.root.querySelectorAll('.code .l')) l.classList.remove('hl', 'replay', 'done'); }
    journal({ key, scope = '', status = 'pending', note = '' }) {
      const box = $('.journal .rows', this.root); if (!box) return;
      const r = h('div', 'jr ' + status); r.dataset.key = scope + key;
      r.append(h('span', 'i', ICON[status]));
      const k = h('span', 'k'); const br = /\/b:([^/]+)\//.exec(scope || '');
      if (br) k.append(h('span', 'branch', br[1]));
      k.append(document.createTextNode(key.replace(/#0$/, ''))); r.append(k);
      r.append(h('span', 's', note || (status === 'ok' ? '' : status))); box.append(r);
      while (box.children.length > 12) box.firstChild.remove();
      return r;
    }
    journalSet(fullKey, status, note) {
      const r = this.root.querySelector(`.jr[data-key="${CSS.escape(fullKey)}"]`); if (!r) return;
      r.className = 'jr ' + status; $('.i', r).textContent = ICON[status]; $('.s', r).textContent = note || (status === 'ok' ? '' : status);
    }
    journalFreeze(on) { for (const r of this.root.querySelectorAll('.jr')) r.classList.toggle('frozen', on); }
    journalClear() { const box = $('.journal .rows', this.root); if (box) box.textContent = ''; }
    host(alive) { const b = $('.hostbadge', this.root); if (!b) return; b.classList.toggle('dead', !alive); b.textContent = alive ? 'host alive' : 'host dead'; this.root.classList.toggle('dead', !alive); }
  }
  const ICON = { pending: '◌', ok: '✓', replayed: '⟲', dead: '✕', live: '●' };
  const highlight = (src) => src
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/("[^"]*")/g, '<span class="str">$1</span>')
    .replace(/\b(const|await|async|if|return)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(spawn|ask|checkpoint|turn|fanOut|log|notify|wait|race|sleep)(?=\()/g, '<span class="eff">$1</span>');

  // ---------- the app ----------
  const App = {
    screen: null, run: null, demoIndex: 0, auto: false, autoNext: 0, lastInput: Date.now(), attractMesh: null, autoTimer: null,
    init() {
      this.stage = new Stage($('#stage'), $('#capbar'));
      this.buildHome(); this.buildAttract(); this.drawQr();
      const touch = (e) => this.onInput(e);
      window.addEventListener('pointerdown', touch, true);
      window.addEventListener('keydown', (e) => this.onKey(e), true);
      window.addEventListener('mousemove', () => { this.lastInput = Date.now(); }, { passive: true });
      setInterval(() => this.tick(), 1000);
      $('#hud-help').onclick = (e) => { e.stopPropagation(); $('#help').classList.toggle('on'); };
      this.showAttract();
    },
    // -- screens
    show(id) {
      for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id);
      this.screen = id; document.body.classList.toggle('auto', this.auto && id === 'demo');
      if (this.attractMesh) this.attractMesh.paused = id === 'demo';
    },
    buildAttract() {
      this.attractMesh = new Mesh($('#bg'), { seed: 42 });
      const M = this.attractMesh, rand = mulberry(11);
      const vendors = Object.keys(VENDORS);
      const chans = [['#review', 0.18, 0.3], ['#research', 0.82, 0.7]];
      for (const [id, x, y] of chans) M.add({ id, kind: 'channel', label: id, x, y, drift: true, seed: rand() * 10 });
      const names = ['planner', 'builder', 'reviewer', 'security', 'scout', 'ops', 'merger', 'analyst', 'guide', 'editor'];
      names.forEach((n, i) => {
        const ang = ((i + 0.5) / names.length) * 6.283 + (rand() - 0.5) * 0.25; const rr = 0.34 + rand() * 0.1;
        M.add({ id: n, label: n, x: 0.5 + Math.cos(ang) * rr * 1.2, y: 0.5 + Math.sin(ang) * rr * 1.15, vendor: vendors[i % vendors.length], status: pick(['idle', 'working', 'idle', 'idle', 'waiting'], rand), drift: true, seed: rand() * 10, size: 0.95 });
        M.link(n, chans[i % 2][0]); if (rand() < 0.4) M.link(n, chans[(i + 1) % 2][0]);
      });
      setInterval(() => {
        if (this.screen !== 'attract' && this.screen !== 'home') return;
        const agents = [...M.nodes.values()].filter((n) => n.kind === 'agent');
        const a = pick(agents); const r = Math.random();
        if (r < 0.5) { const e = M.edges.filter((e) => e.a === a.id); if (e.length) { const ch = pick(e).b; M.pulse(a.id, ch, 'chat').then(() => { for (const m of M.edges.filter((x) => x.b === ch && x.a !== a.id).slice(0, 4)) M.pulse(ch, m.a, 'chat', { dur: 500 }); }); } }
        else if (r < 0.8) { const b = pick(agents); if (b !== a) { M.dashed(a.id, b.id, 'dm', 900); M.pulse(a.id, b.id, 'dm'); } }
        else { const b = pick(agents); if (b !== a) { M.pulse(a.id, b.id, 'anycast'); M.status(b.id, 'working'); setTimeout(() => M.status(b.id, 'idle'), 2500); } }
        if (Math.random() < 0.15) { const b = pick(agents); M.status(b.id, pick(['idle', 'working', 'waiting'])); }
      }, 650);
    },
    showAttract() { this.stopRun(); this.show('attract'); this.autoTimer = Date.now(); },
    showHome() { this.stopRun(); this.auto = false; this.show('home'); },
    buildHome() {
      const grid = $('#home .cards'); grid.textContent = '';
      window.DEMOS.forEach((d, i) => {
        const c = h('button', 'card'); c.onclick = () => this.startDemo(i, false);
        const num = h('div', 'num'); num.append(h('span', 'k', String(i + 1)));
        c.append(num, h('h2', null, d.title), h('p', null, d.hook));
        c.append(h('div', 'play', 'Play ▶'));
        grid.append(c);
      });
    },
    drawQr() {
      const m = window.COTAL_QR; const cv = $('#qr'); const n = m.length; cv.width = n; cv.height = n; const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, n, n); ctx.fillStyle = '#000';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x] === '1') ctx.fillRect(x, y, 1, 1);
    },
    // -- demos
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
    // -- input
    onInput(e) {
      this.lastInput = Date.now();
      if (e.target.closest('.hud') || e.target.closest('#help')) return;
      if ($('#help').classList.contains('on')) { $('#help').classList.remove('on'); e.stopPropagation(); e.preventDefault(); return; }
      if (this.screen === 'attract') { e.stopPropagation(); e.preventDefault(); this.showHome(); return; }
      if (this.screen === 'demo' && this.run && this.run.auto) { this.run.takeOver(); this.auto = false; document.body.classList.remove('auto'); }
    },
    onKey(e) {
      this.lastInput = Date.now();
      const k = e.key;
      if (k === 'f' || k === 'F') { this.fullscreen(); return; }
      if (k === 'm' || k === 'M') { this.toggleSound(); return; }
      if (k === '?' || k === 'h' || k === 'H') { $('#help').classList.toggle('on'); return; }
      if ($('#help').classList.contains('on')) { $('#help').classList.remove('on'); return; }
      if (this.screen === 'attract') { this.showHome(); return; }
      if (this.screen === 'home') {
        const n = parseInt(k, 10); if (n >= 1 && n <= window.DEMOS.length) this.startDemo(n - 1, false);
        else if (k === 'Escape') this.showAttract();
        else if (k === 'Enter' || k === ' ') this.startDemo(0, false);
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
      const idle = (Date.now() - this.lastInput) / 1000;
      document.body.classList.toggle('nocursor', idle > 4);
      if (this.screen === 'home' && idle > 75) this.showAttract();
      else if (this.screen === 'demo' && this.run && !this.run.auto && idle > (this.run.done ? 45 : 120)) this.showAttract();
      else if (this.screen === 'attract') {
        const shown = (Date.now() - this.autoTimer) / 1000;
        if (idle > 30 && shown > (this.autoNext ? 8 : 25)) { const i = this.autoNext || 0; this.autoNext = 0; this.startDemo(i, true); }
      }
    },
    toggleSound() { sfx.on = !sfx.on; sfx.ensure(); $('#hud-help').classList.toggle('on', sfx.on); },
    fullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); },
  };

  window.Booth = { App, Mesh, Run, Stage, CANCELLED, C, KIND, VENDORS, sfx, pick, nameColor, mulberry };
  window.addEventListener('DOMContentLoaded', () => App.init());
})();
