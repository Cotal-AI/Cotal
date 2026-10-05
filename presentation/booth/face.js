// Pixel-art face renderer: a compact port of examples/04-frontier-faces/web/cotal-face.js that draws
// straight into a <canvas> (no custom element, no module import) so it works from file://.
// Reads window.PERSONAS (personas.js, generated from the example's personas.mjs).
'use strict';
(() => {
  const GRID = 32, SZ = 10, PX = GRID * SZ, BG = '#0b001b';
  const vis = (ch) => {
    ch = ch.toLowerCase();
    if (" .,!?'-".includes(ch)) return 'X';
    if ('mbp'.includes(ch)) return 'A';
    if ('fvu'.includes(ch)) return 'F';
    if ('ow'.includes(ch)) return 'E';
    if ('a'.includes(ch)) return 'D';
    if ('ei'.includes(ch)) return 'B';
    return Math.random() < 0.5 ? 'B' : 'C';
  };

  class Face {
    constructor(canvas, persona) {
      this.cv = canvas; canvas.width = PX; canvas.height = PX;
      this.ctx = canvas.getContext('2d');
      this.p = window.PERSONAS[persona];
      if (!this.p) throw new Error('unknown persona ' + persona);
      this.grid = this.p.rows.map((r) => r.padEnd(GRID, '.'));
      this.st = { expr: 'neutral', viseme: null, blink: false, speaking: false };
      this.timer = setInterval(() => this.draw(), 80);
      this.blinkLoop();
      this.draw();
    }
    dispose() { clearInterval(this.timer); clearTimeout(this.blinkT); clearInterval(this.typeT); }
    set expr(e) { this.st.expr = e in this.p.expr ? e : 'neutral'; }
    blinkLoop() {
      this.blinkT = setTimeout(() => {
        this.st.blink = true;
        setTimeout(() => { this.st.blink = false; this.blinkLoop(); }, 140);
      }, 2200 + Math.random() * 2800);
    }
    // Lip-sync `text` at `cps` chars/sec; `onChar(ch)` receives each typed character.
    speak(text, { cps = 24, onChar } = {}) {
      this.stop();
      this.st.speaking = true;
      let i = 0;
      return new Promise((resolve) => {
        this.typeT = setInterval(() => {
          if (i >= text.length) {
            clearInterval(this.typeT); this.st.viseme = null;
            setTimeout(() => { this.st.speaking = false; resolve(); }, 200);
            return;
          }
          const ch = text[i++];
          this.st.viseme = vis(ch);
          if (onChar) onChar(ch);
        }, 1000 / cps);
      });
    }
    stop() { clearInterval(this.typeT); this.st.speaking = false; this.st.viseme = null; }
    draw() {
      const p = this.p, st = this.st, ctx = this.ctx;
      const bob = Math.sin(Date.now() / 950) > 0.55 ? 1 : 0;
      ctx.fillStyle = BG; ctx.fillRect(0, 0, PX, PX);
      const solid = [], emissive = [];
      const put = ([r, c, k]) => (p.glow[k] ? emissive : solid).push([r, c, k]);
      for (let r = 0; r < GRID; r++) {
        const row = this.grid[r];
        for (let c = 0; c < GRID; c++) { const k = row[c]; if (k && k !== '.') put([r, c, k]); }
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
  window.Face = Face;
})();
