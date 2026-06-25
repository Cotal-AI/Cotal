// <cotal-face> — animated pixel-art avatar as a framework-agnostic custom element.
//
// One shared engine (32x32 truecolor canvas, blink, head-bob, expression overlays,
// viseme lip-sync) + a per-persona data pack (rows/colors/glow/mouths/expr/eyes/lines).
// Same engine as the terminal face (../face-term.mjs); both draw their personas from
// ../personas.mjs (one source of truth — add a persona once, it shows up everywhere).
//
// Load as a module (the userscript bundle inlines it for Tampermonkey):
//   <script type="module" src="cotal-face.js"></script>
//   <cotal-face persona="ray"></cotal-face>
//   const f = document.querySelector('cotal-face');
//   f.expr = 'happy';                 // neutral|happy|sad|angry|surprised
//   await f.speak('hello world');     // types + lip-syncs, returns when done
//   f.pushTokens(chunk);              // feed a live LLM stream (mouth follows text)
//   f.setActivity('thinking');        // idle|thinking|working|speaking|waiting|done|error
import { PERSONAS } from '../personas.mjs';

(function () {
  const GRID = 32, SZ = 10, PX = GRID * SZ; // 320x320, 10px/cell
  const BG = '#0b001b';
  const CRT_FILTER =
    'drop-shadow(1px 0 0 rgba(226,58,106,.35)) drop-shadow(-1px 0 0 rgba(83,235,228,.35))';

  // text char -> viseme (mouth shape), lifted from the source faces
  function vis(ch) {
    ch = ch.toLowerCase();
    if (" .,!?'-".includes(ch)) return 'X';
    if ('mbp'.includes(ch)) return 'A';
    if ('fvu'.includes(ch)) return 'F';
    if ('ow'.includes(ch)) return 'E';
    if ('a'.includes(ch)) return 'D';
    if ('ei'.includes(ch)) return 'B';
    return Math.random() < 0.5 ? 'B' : 'C';
  }

  // activity -> expression + caption behaviour
  const ACTIVITY = {
    idle: { expr: 'neutral', caption: '' },
    thinking: { expr: 'neutral', caption: 'thinking', dots: true },
    working: { expr: 'neutral', caption: 'working' },
    speaking: { expr: 'happy', caption: null },
    waiting: { expr: 'happy', caption: 'your turn ›' },
    done: { expr: 'happy', caption: 'done' },
    error: { expr: 'angry', caption: 'error' },
  };

  class CotalFace extends HTMLElement {
    static get observedAttributes() { return ['persona', 'expr', 'caption', 'crt']; }

    connectedCallback() {
      if (this._wired) return;
      this._wired = true;
      this.state = { expr: 'neutral', viseme: null, blink: false, crt: this.getAttribute('crt') !== 'off', speaking: false };
      this._buildDom();
      this._loadPersona(this.getAttribute('persona') || 'neon');
      if (this.hasAttribute('expr')) this.state.expr = this.getAttribute('expr');
      if (this.hasAttribute('caption')) this._caption(this.getAttribute('caption'));
      this._drawTimer = setInterval(() => this._draw(), 80);
      this._blinkLoop();
    }

    disconnectedCallback() {
      clearInterval(this._drawTimer);
      clearTimeout(this._blinkTimer);
      clearInterval(this._typeTimer);
      clearInterval(this._dotsTimer);
      clearTimeout(this._streamIdle);
    }

    attributeChangedCallback(name, _old, val) {
      if (!this._wired) return;
      if (name === 'persona') this._loadPersona(val || 'neon');
      else if (name === 'expr') this.state.expr = val || 'neutral';
      else if (name === 'caption') this._caption(val || '');
      else if (name === 'crt') this._setCrt(val !== 'off');
    }

    // ---- public API ----------------------------------------------------------
    get expr() { return this.state.expr; }
    set expr(v) { this.state.expr = v in this.p.expr ? v : 'neutral'; }

    get persona() { return this._personaName; }
    set persona(v) { this._loadPersona(v); }

    /** @param {string} v */
    set caption(v) { this._caption(v); }

    setActivity(kind, detail) {
      const a = ACTIVITY[kind] || ACTIVITY.idle;
      this.state.expr = a.expr;
      this._stopDots();
      if (a.dots) this._dotsCaption(detail || a.caption);
      else if (a.caption !== null) this._caption(detail || a.caption);
      if (kind !== 'speaking') this.stopSpeaking();
    }

    // type a full string with lip-sync; resolves when finished
    speak(text, opts = {}) {
      const cps = opts.cps || 14; // chars/sec (~70ms)
      this.stopSpeaking();
      this._stopDots();
      this.state.speaking = true;
      this._caption('');
      let i = 0;
      return new Promise((resolve) => {
        this._typeTimer = setInterval(() => {
          if (i >= text.length) {
            clearInterval(this._typeTimer);
            this.state.viseme = null;
            setTimeout(() => { this.state.speaking = false; resolve(); }, 250);
            return;
          }
          const ch = text[i++];
          this._captionEl.append(document.createTextNode(ch));
          this.state.viseme = vis(ch);
        }, 1000 / cps);
      });
    }

    // feed a live token stream; mouth follows the latest chars, auto-idles when it stops
    pushTokens(chunk) {
      this._stopDots();
      this.state.speaking = true;
      for (const ch of chunk) {
        this._captionEl.append(document.createTextNode(ch));
        this.state.viseme = vis(ch);
      }
      // keep the live ticker bounded so a long streamed reply can't reflow the layout
      const cap = this._captionEl;
      if (cap.textContent.length > 180) cap.textContent = '…' + cap.textContent.slice(-179);
      clearTimeout(this._streamIdle);
      this._streamIdle = setTimeout(() => { this.state.speaking = false; this.state.viseme = null; }, 320);
    }

    stopSpeaking() {
      clearInterval(this._typeTimer);
      clearTimeout(this._streamIdle);
      this.state.speaking = false;
      this.state.viseme = null;
    }

    // speak a random canned line for the current persona (demo helper)
    speakLine() { return this.speak(this.p.lines[(this._li = ((this._li || 0) + 1)) % this.p.lines.length]); }

    // ---- internals ------------------------------------------------------------
    _buildDom() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
<style>
  :host { display: inline-block; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .term { background:#0b001b; border-radius:10px; overflow:hidden; width: var(--cf-width, 320px); }
  .bar { display:flex; align-items:center; gap:6px; padding:8px 12px; background:#08173d; }
  .dot { width:10px; height:10px; border-radius:50%; }
  .title { font-size:12px; color:rgba(83,235,228,.8); margin-left:8px; }
  .screen { position:relative; display:flex; justify-content:center; padding:14px 0 6px; }
  canvas { width:100%; height:auto; display:block; image-rendering:pixelated; filter:${CRT_FILTER}; }
  .scan { position:absolute; inset:0; pointer-events:none;
          background:repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 1px,transparent 1px 3px); }
  .out { padding:6px 14px 12px; font-size:var(--cf-caption-size,13px); color:#53ebe4; min-height:34px; line-height:1.3; display:var(--cf-caption-display,block); }
  .cur { animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  :host([chrome="off"]) .bar { display:none; }
</style>
<div class="term">
  <div class="bar">
    <span class="dot" style="background:#e13a6a"></span>
    <span class="dot" style="background:#e46a87"></span>
    <span class="dot" style="background:#53ebe4"></span>
    <span class="title"></span>
  </div>
  <div class="screen">
    <canvas width="${PX}" height="${PX}"></canvas>
    <div class="scan"></div>
  </div>
  <div class="out">&#10095; <span class="cap"></span><span class="cur">&#9646;</span></div>
</div>`;
      this._cv = root.querySelector('canvas');
      this._ctx = this._cv.getContext('2d');
      this._scan = root.querySelector('.scan');
      this._titleEl = root.querySelector('.title');
      this._captionEl = root.querySelector('.cap');
      this._setCrt(this.state.crt);
    }

    _loadPersona(name) {
      const p = PERSONAS[name];
      if (!p) throw new Error(`cotal-face: unknown persona "${name}" (have: ${Object.keys(PERSONAS).join(', ')})`);
      this.p = p;
      this._personaName = name;
      // pre-pad rows to a 32-wide grid of color keys
      this._grid = p.rows.map((r) => r.padEnd(GRID, '.'));
      if (this.state && !(this.state.expr in p.expr)) this.state.expr = 'neutral';
      if (this._titleEl) this._titleEl.textContent = `${p.label} — 32×32`;
    }

    _setCrt(on) {
      this.state.crt = on;
      if (!this._scan) return;
      this._scan.style.display = on ? 'block' : 'none';
      this._cv.style.filter = on ? CRT_FILTER : 'none';
    }

    _caption(text) { this._captionEl.textContent = text; }

    _dotsCaption(base) {
      let n = 0;
      const tick = () => this._caption(base + '.'.repeat(n = (n + 1) % 4));
      tick();
      this._dotsTimer = setInterval(tick, 400);
    }
    _stopDots() { clearInterval(this._dotsTimer); this._dotsTimer = null; }

    _blinkLoop() {
      this._blinkTimer = setTimeout(() => {
        this.state.blink = true;
        setTimeout(() => { this.state.blink = false; this._blinkLoop(); }, 140);
      }, 2200 + Math.random() * 2800);
    }

    _draw() {
      const p = this.p, st = this.state, ctx = this._ctx;
      const t = Date.now();
      const bob = Math.sin(t / 950) > 0.55 ? 1 : 0;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, PX, PX);
      const solid = [], emissive = [];
      const put = ([r, c, k]) => (p.glow[k] ? emissive : solid).push([r, c, k]);
      for (let r = 0; r < GRID; r++) {
        const row = this._grid[r];
        for (let c = 0; c < GRID; c++) {
          const k = row[c];
          if (k && k !== '.') put([r, c, k]);
        }
      }
      const e = p.expr[st.expr] || p.expr.neutral;
      const mouth = (st.speaking && st.viseme) ? p.mouths[st.viseme] : p.mouths[e.mouth];
      [...e.brows, ...mouth, ...p.eyes(e.eyes, st.blink)].forEach(put);
      solid.forEach(([r, c, k]) => { ctx.fillStyle = p.colors[k]; ctx.fillRect(c * SZ, (r + bob) * SZ, SZ, SZ); });
      ctx.save();
      emissive.forEach(([r, c, k]) => {
        ctx.fillStyle = p.colors[k]; ctx.shadowColor = p.colors[k]; ctx.shadowBlur = p.glow[k];
        ctx.fillRect(c * SZ, (r + bob) * SZ, SZ, SZ);
      });
      ctx.restore();
    }
  }

  customElements.define('cotal-face', CotalFace);
  window.CotalFace = CotalFace;
  window.COTAL_FACE_PERSONAS = PERSONAS;
})();
