// <cotal-face> — animated pixel-art avatar as a framework-agnostic custom element.
//
// One shared engine (32x32 truecolor canvas, blink, head-bob, expression overlays,
// viseme lip-sync) + a per-persona data pack (rows/colors/glow/mouths/expr/eyes/lines).
// Same engine as the terminal face (../face-term.mjs); this copy keeps its own persona packs.
//
// Usage (any DOM, incl. OpenCode's web UI):
//   <script src="cotal-face.js"></script>
//   <cotal-face persona="ray"></cotal-face>
//   const f = document.querySelector('cotal-face');
//   f.expr = 'happy';                 // neutral|happy|sad|angry|surprised
//   await f.speak('hello world');     // types + lip-syncs, returns when done
//   f.pushTokens(chunk);              // feed a live LLM stream (mouth follows text)
//   f.setActivity('thinking');        // idle|thinking|working|speaking|waiting|done|error
(function () {
  const GRID = 32, SZ = 10, PX = GRID * SZ; // 320x320, 10px/cell
  const BG = '#0b001b';
  const CRT_FILTER =
    'drop-shadow(1px 0 0 rgba(226,58,106,.35)) drop-shadow(-1px 0 0 rgba(83,235,228,.35))';

  const rng = (r, c1, c2, k) => {
    const a = [];
    for (let c = c1; c <= c2; c++) a.push([r, c, k]);
    return a;
  };

  // ---- persona registry ------------------------------------------------------
  const PERSONAS = {
    neon: {
      label: 'cyberface',
      rows: [
        '', '',
        '............hhHHHHh',
        '..........LhhHHHHHhh',
        '.........LhhHHHHHHHhhh',
        '........LLhhHHHHHHHHhhhM',
        '.......LLhhHHHHHHHHHhhhM',
        '.......LhhhHHHHHHHHHHhhM',
        '.......LhhHHHHHHHHHHHHhM',
        '.......LhHPPSSSSSSsHHHhM',
        '.......LhHPPSSSSSSSsHHhM',
        '.......LhHPSSSSSSSSsNHhM',
        '.......LhPSSSSSSSSSSsshM',
        '.......LhPSSSSSSSSSSsshM',
        '.......LhPSSSSSSSSSSsshM',
        '.......LhPSSSSSSSSSSsshM',
        '.......LhPSSSSSSSSSSsshM',
        '.......LhPSSSSssSSSSsshM',
        '.......LhPSSSSSSSSSSsshM',
        '........hPSSSSSSSSSssM',
        '.........PSSSSSSSSss',
        '.........PSSSSSSSSss',
        '..........sSSSSSSSs',
        '...........sSSSSSs',
        '............sssss',
        '.............sSs',
        '.............sSs',
        '..........VVVsSsVVV',
        '........VVVVVsSsVVVVV',
        '......VVVVVVVNVVVVVVVVV',
        '.....VVVVVVVVVVVVVVVVVVV',
        '....VVVVVVVVVVVVVVVVVVVVV',
      ],
      colors: { K: '#0b001b', D: '#4d004f', H: '#084f64', h: '#0f9595', L: '#53ebe4', S: '#e46a87', s: '#c1115a', P: '#eca6c0', M: '#e13a6a', N: '#53ebe4', V: '#03274c' },
      glow: { N: 9, M: 6, L: 3 },
      mouths: {
        X: rng(21, 13, 16, 'D'),
        A: rng(21, 12, 17, 'D'),
        B: [...rng(20, 12, 17, 'D'), ...rng(21, 12, 17, 'P')],
        C: [...rng(20, 13, 16, 'D'), [21, 12, 'D'], ...rng(21, 13, 16, 'K'), [21, 17, 'D'], ...rng(22, 13, 16, 'D')],
        D: [...rng(20, 12, 17, 'D'), [21, 12, 'D'], ...rng(21, 13, 16, 'K'), [21, 17, 'D'], ...rng(22, 13, 16, 'D')],
        E: [...rng(20, 14, 15, 'D'), [21, 13, 'D'], ...rng(21, 14, 15, 'K'), [21, 16, 'D'], ...rng(22, 14, 15, 'D')],
        F: [...rng(21, 13, 16, 'D'), ...rng(22, 14, 15, 'P')],
        smile: [[20, 12, 'D'], [20, 17, 'D'], ...rng(21, 13, 16, 'D')],
        frown: [...rng(21, 13, 16, 'D'), [22, 12, 'D'], [22, 17, 'D']],
        grit: [...rng(20, 12, 17, 'D'), ...rng(21, 12, 17, 'D')],
      },
      expr: {
        neutral: { brows: [...rng(13, 10, 12, 'K'), ...rng(13, 18, 20, 'K')], eyes: 'open', mouth: 'X' },
        happy: { brows: [...rng(12, 10, 12, 'K'), ...rng(12, 18, 20, 'K')], eyes: 'open', mouth: 'smile' },
        sad: { brows: [[12, 12, 'K'], [13, 10, 'K'], [13, 11, 'K'], [12, 18, 'K'], [13, 19, 'K'], [13, 20, 'K']], eyes: 'open', mouth: 'frown' },
        angry: { brows: [[12, 10, 'K'], [12, 11, 'K'], [13, 12, 'K'], [13, 18, 'K'], [12, 19, 'K'], [12, 20, 'K']], eyes: 'narrow', mouth: 'grit' },
        surprised: { brows: [...rng(11, 10, 12, 'K'), ...rng(11, 18, 20, 'K')], eyes: 'wide', mouth: 'E' },
      },
      eyes(style, blink) {
        const cols = [11, 12, 18, 19], out = [];
        if (blink) { cols.forEach((c) => out.push([15, c, 'D'])); return out; }
        const rows = style === 'narrow' ? [15] : style === 'wide' ? [13, 14, 15] : [14, 15];
        rows.forEach((r) => cols.forEach((c) => out.push([r, c, 'N'])));
        return out;
      },
      lines: [
        'booting cortex... all 1024 pixels nominal.',
        'i render in half-blocks and dream in sixels.',
        'two pixels per eye. i see everything.',
        'neon looks better at 32 by 32.',
        'patch my palette and i become someone new.',
      ],
    },

    david: {
      label: 'david',
      rows: [
        '',
        '..........kKKkkKKKKk',
        '.........kKKKKbKKKKKKk',
        '........kKKbKKKKKKkKKKKk',
        '.......kKKKKKKkKKKKbKKKk',
        '......kKbKKKKKKKKkKKKKKKk',
        '......LKKKKKkKKKKKKKKbKKKM',
        '.....LKKKKKKKKKkKKKKKKKKKM',
        '.....LKKbKKKKKKKKKKKKKKKKM',
        '......kKKkSSSSSSSSSkKKKk',
        '......KKkPPSSSSSSSSSSskKKk',
        '......KKkPSSSSSSSSSSSskKKk',
        '......KKkPSSSSSSSSSSSskKKk',
        '......KKkPSSSSSSSSSSSskKKk',
        '.......KkPSSSSSSSSSSSskK',
        '.......KkPSSSSsSsSSSSskK',
        '........kPSSSSsSsSSSSsk',
        '........kPSSSsssSSSSSsk',
        '......KKkkkSKKKKKKKSkkkKKk',
        '......KKkKKkssssssskKKkKKk',
        '.......kKKKKkkssskkKKKKk',
        '.........KKKKkkkkkKKKK',
        '..........KKKKKKKKKKK',
        '...........KKKKKKKKK',
        '............KKKKKKK',
        '............sSSSSSs',
        '............sSSSSSs',
        '..........TTsSSSSSsTT',
        '.......TTTTTtttttttTTTTTT',
        '......LTTTTTTTTTTTTTTTTTTM',
        '.....LTTTTTTTTTTTTTTTTTTTTM',
        '....LTTTTTTTTTTTTTTTTTTTTTTM',
      ],
      colors: { K: '#352820', k: '#4e3b2c', b: '#74573a', L: '#53ebe4', M: '#e13a6a', S: '#e0a183', s: '#b5755a', P: '#f2c4a4', E: '#2b1810', R: '#d98e88', m: '#6b3a30', W: '#f2ead8', T: '#2d3a3c', t: '#222d2f' },
      glow: { L: 8, M: 6 },
      mouths: {
        X: rng(19, 13, 17, 'R'),
        A: rng(19, 12, 18, 'R'),
        B: [...rng(19, 12, 18, 'R'), ...rng(20, 12, 18, 'W')],
        C: [...rng(19, 13, 17, 'R'), [20, 12, 'R'], ...rng(20, 13, 17, 'm'), [20, 18, 'R'], ...rng(21, 13, 17, 'R')],
        D: [...rng(19, 12, 18, 'R'), [20, 12, 'R'], ...rng(20, 13, 17, 'm'), [20, 18, 'R'], ...rng(21, 13, 17, 'R')],
        E: [...rng(19, 14, 16, 'R'), [20, 13, 'R'], ...rng(20, 14, 16, 'm'), [20, 17, 'R'], ...rng(21, 14, 16, 'R')],
        F: [...rng(19, 13, 17, 'R'), ...rng(20, 14, 16, 'W')],
        smile: [[19, 12, 'm'], ...rng(19, 13, 17, 'W'), [19, 18, 'm'], ...rng(20, 13, 17, 'm')],
        frown: [...rng(19, 13, 17, 'R'), [20, 12, 'R'], [20, 18, 'R']],
        grit: [...rng(19, 12, 18, 'R'), ...rng(20, 12, 18, 'W'), ...rng(21, 12, 18, 'R')],
      },
      expr: {
        neutral: { brows: [...rng(12, 10, 13, 'K'), ...rng(12, 17, 20, 'K')], eyes: 'open', mouth: 'X' },
        happy: { brows: [...rng(12, 10, 13, 'K'), ...rng(12, 17, 20, 'K')], eyes: 'open', mouth: 'smile' },
        sad: { brows: [[11, 13, 'K'], [12, 10, 'K'], [12, 11, 'K'], [12, 12, 'K'], [11, 17, 'K'], [12, 18, 'K'], [12, 19, 'K'], [12, 20, 'K']], eyes: 'open', mouth: 'frown' },
        angry: { brows: [[11, 10, 'K'], [11, 11, 'K'], [11, 12, 'K'], [12, 13, 'K'], [12, 17, 'K'], [11, 18, 'K'], [11, 19, 'K'], [11, 20, 'K']], eyes: 'open', mouth: 'grit' },
        surprised: { brows: [...rng(11, 10, 13, 'K'), ...rng(11, 17, 20, 'K')], eyes: 'wide', mouth: 'E' },
      },
      eyes(style, blink) {
        if (blink) return [[14, 11, 's'], [14, 12, 's'], [14, 18, 's'], [14, 19, 's']];
        if (style === 'wide') return [[13, 11, 'E'], [13, 12, 'E'], [14, 11, 'E'], [14, 12, 'E'], [13, 18, 'E'], [13, 19, 'E'], [14, 18, 'E'], [14, 19, 'E']];
        return [[14, 11, 'E'], [14, 12, 'E'], [14, 18, 'E'], [14, 19, 'E']];
      },
      lines: [
        'serious face, serious pixels.',
        'my eyebrows have their own pixel budget.',
        'the lips get five whole pixels of pink.',
        'wavy hair, square pixels. deal with it.',
        'third face in the terminal. it is a party.',
      ],
    },

    ray: {
      label: 'ray',
      rows: [
        '',
        '..........kKk.kKKKk',
        '.........kKKKkKKKKKKk',
        '........kKKbKKKKkKKKKk',
        '.......kKKKKkKKKKbKKKKk',
        '......kKbKKKKKKkKKKKKbKk',
        '.....kKKKKKbKKKKKKKKKKKKk',
        '.....LKKkKKKKbKKKKkKKKKKKM',
        '....LKKKKKKkKKKKKKKKbKKKKKM',
        '.....LKKbKKKKKKKKkKKKKKKKKM',
        '.....kKKKKKkKKKKbKKKKKKKKKk',
        '......KKkKSSSSSKSSSSSKkKKk',
        '......KKkPSSSSSSSSSSSskKbk',
        '......KKkSGGGGGGGGGGGSkKKk',
        '......KKkGGWPGSsSGPWGGkKKk',
        '......KbkSGGGGSSSGGGGSkKKk',
        '......KKkkSPSSsSsSSPSkkKKk',
        '......KKkkkSSsSSsSSkkkkKKk',
        '.......kKKKkkSSsSSkkKKKk',
        '.......kKKKkKKKKKKKkKKKk',
        '.......kKKKKKkkkkkKKKKKk',
        '.......kKKKKKkkkkkKKKKKk',
        '........KKKKKKkkkKKKKKK',
        '.........KKKKKKKKKKKKK',
        '..........KKKKKKKKKKK',
        '...........KKKkKKKKK',
        '.............sSSSs',
        '..........CCCsSSsCCCC',
        '.......CCVVCCCCcCCCCCVVCC',
        '......CCCVVCCCCcCCCCCVVCCC',
        '.....CCCCVVCCCCcCCCCCVVCCCC',
        '....CCCCCVVCCCCcCCCCCVVCCCCC',
      ],
      colors: { K: '#1c1410', k: '#352718', b: '#56412a', L: '#53ebe4', M: '#e13a6a', S: '#b9895c', s: '#8e5f38', P: '#dcb287', G: '#3a5fd9', E: '#241307', W: '#f2ead7', R: '#a06a55', m: '#4a261c', C: '#ece4cf', c: '#cfc3a4', V: '#2b2b31' },
      glow: { L: 8, M: 6, G: 3 },
      mouths: {
        X: rng(21, 13, 17, 'R'),
        A: rng(21, 12, 18, 'R'),
        B: [...rng(20, 12, 18, 'R'), ...rng(21, 12, 18, 'W')],
        C: [...rng(20, 13, 17, 'R'), [21, 12, 'R'], ...rng(21, 13, 17, 'm'), [21, 18, 'R'], ...rng(22, 13, 17, 'R')],
        D: [...rng(20, 12, 18, 'R'), [21, 12, 'R'], ...rng(21, 13, 17, 'm'), [21, 18, 'R'], ...rng(22, 13, 17, 'R')],
        E: [...rng(20, 14, 16, 'R'), [21, 13, 'R'], ...rng(21, 14, 16, 'm'), [21, 17, 'R'], ...rng(22, 14, 16, 'R')],
        F: [...rng(21, 13, 17, 'R'), ...rng(22, 14, 16, 'W')],
        grin: [[20, 11, 'm'], ...rng(20, 12, 18, 'W'), [20, 19, 'm'], ...rng(21, 13, 17, 'm')],
        frown: [...rng(21, 13, 17, 'R'), [22, 12, 'R'], [22, 18, 'R']],
        grit: [...rng(20, 12, 18, 'R'), ...rng(21, 12, 18, 'W'), ...rng(22, 12, 18, 'R')],
      },
      expr: {
        neutral: { brows: [...rng(12, 10, 12, 'K'), ...rng(12, 18, 20, 'K')], eyes: 'open', mouth: 'X' },
        happy: { brows: [...rng(12, 10, 12, 'K'), ...rng(12, 18, 20, 'K')], eyes: 'open', mouth: 'grin' },
        sad: { brows: [[11, 12, 'K'], [12, 10, 'K'], [12, 11, 'K'], [11, 18, 'K'], [12, 19, 'K'], [12, 20, 'K']], eyes: 'open', mouth: 'frown' },
        angry: { brows: [[11, 10, 'K'], [11, 11, 'K'], [12, 12, 'K'], [12, 18, 'K'], [11, 19, 'K'], [11, 20, 'K']], eyes: 'open', mouth: 'grit' },
        surprised: { brows: [...rng(11, 10, 12, 'K'), ...rng(11, 18, 20, 'K')], eyes: 'wide', mouth: 'E' },
      },
      eyes(style, blink) {
        if (blink) return [[14, 12, 's'], [14, 18, 's']];
        if (style === 'wide') return [[14, 11, 'E'], [14, 12, 'E'], [14, 18, 'E'], [14, 19, 'E']];
        return [[14, 12, 'E'], [14, 18, 'E']];
      },
      lines: [
        'v2 compiled. bridge welded, curls online.',
        'every curl is a hand-placed highlight.',
        'these frames are one hundred percent blue pixels.',
        'the beard is doing all the heavy shading.',
        'render me in sixels and i pop even harder.',
      ],
    },
  };

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
  .out { padding:6px 14px 12px; font-size:13px; color:#53ebe4; min-height:34px; line-height:1.3; }
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
