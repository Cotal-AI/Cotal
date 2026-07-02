#!/usr/bin/env node
// face-term.mjs — animated pixel-art face IN THE TERMINAL, steered by a live OpenCode agent.
//
// Renders a cotal-face persona as truecolor half-blocks (▀, fg=top px / bg=bottom px) and drives
// its expression + lip-sync from OpenCode's session event stream: streamed assistant text moves
// the mouth, tool/reasoning => "thinking/working", session.idle => idle + blink.
//
//   opencode serve --port 4096                 # start the agent (or reuse a running server)
//   bun face-term.mjs                          # talk to it — the face reacts as it answers
//   bun face-term.mjs --demo                   # no server: scripted preview turn
//   bun face-term.mjs --persona david --server http://127.0.0.1:4096 \
//                     --model opencode-go/glm-5.1
//
// Persona pixel data mirrors cotal-face.js (the browser engine); keep the two in sync.

import { PERSONAS } from './personas.mjs';

function vis(ch) {
  ch = ch.toLowerCase();
  if (" .,!?'-\n\t".includes(ch)) return 'X';
  if ('mbp'.includes(ch)) return 'A';
  if ('fvu'.includes(ch)) return 'F';
  if ('ow'.includes(ch)) return 'E';
  if ('a'.includes(ch)) return 'D';
  if ('ei'.includes(ch)) return 'B';
  return Math.random() < 0.5 ? 'B' : 'C';
}

// ---- args ----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const has = (name) => argv.includes('--' + name);
const DEMO = has('demo');
const PERSONA = flag('persona', 'ray');
const SERVER = flag('server', 'http://127.0.0.1:4096').replace(/\/$/, '');
const SESSION = flag('session', ''); // attach to an existing session instead of creating one
const PASSWORD = flag('password', ''); // HTTP basic auth (opencode serve with OPENCODE_SERVER_PASSWORD)
const MODEL_STR = flag('model', 'opencode-go/glm-5.1');
const [provModel0, ...rest] = MODEL_STR.split('/');
const MODEL = { providerID: provModel0, modelID: rest.join('/') };
const p = PERSONAS[PERSONA] || PERSONAS.ray;

// The agent steers its own expression by emitting hidden [[face:X]] tags; face-term strips them.
const EXPRS = ['neutral', 'happy', 'sad', 'angry', 'surprised'];
const FACE_SYSTEM =
  'You speak through an animated pixel-art avatar of yourself shown above your reply. ' +
  'Convey emotion by emitting an inline tag [[face:X]] where X is one of: ' + EXPRS.join(', ') + '. ' +
  'Put the tag immediately before the sentence it applies to, and change it whenever your mood shifts ' +
  '(e.g. [[face:angry]] before describing a frustrating bug, [[face:happy]] when it works). ' +
  'Use them naturally and often. Never mention, explain, or apologize for the tags — they are invisible to the user.';

// ---- face state ----------------------------------------------------------------------------
const GRID = 32, BG = '#0b001b';
const state = { expr: 'neutral', viseme: null, blink: false, speaking: false, status: 'idle' };
const speakBuf = []; // chars waiting to be lip-synced
let lastDeltaAt = 0, nextBlinkAt = now() + 2500, blinkOffAt = 0, turnDone = true;
function now() { return Date.now(); }

function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
const RGB = {}; // per-persona color cache
for (const key of Object.keys(p.colors)) RGB[key] = hexRgb(p.colors[key]);
const BG_RGB = hexRgb(BG);

function composeGrid() {
  const t = now();
  const bob = Math.sin(t / 950) > 0.55 ? 1 : 0;
  const grid = Array.from({ length: GRID }, () => new Array(GRID).fill(null));
  const put = ([r, c, k]) => { const rr = r + bob; if (rr >= 0 && rr < GRID && c >= 0 && c < GRID) grid[rr][c] = k; };
  for (let r = 0; r < GRID; r++) {
    const row = (p.rows[r] || '').padEnd(GRID, '.');
    for (let c = 0; c < GRID; c++) { const k = row[c]; if (k && k !== '.') put([r, c, k]); }
  }
  const e = p.expr[state.expr] || p.expr.neutral;
  const mouth = (state.speaking && state.viseme) ? p.mouths[state.viseme] : p.mouths[e.mouth];
  [...e.brows, ...mouth, ...p.eyes(e.eyes, state.blink)].forEach(put);
  return grid;
}

// 32x32 key grid -> 16 lines of truecolor half-blocks
function faceLines() {
  const g = composeGrid();
  const lines = [];
  for (let cr = 0; cr < GRID / 2; cr++) {
    let s = '';
    for (let c = 0; c < GRID; c++) {
      const tk = g[2 * cr][c], bk = g[2 * cr + 1][c];
      const [tr, tg, tb] = tk ? RGB[tk] : BG_RGB;
      const [br, bg2, bb] = bk ? RGB[bk] : BG_RGB;
      s += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg2};${bb}m▀`;
    }
    lines.push(s + '\x1b[0m');
  }
  return lines;
}

// ---- terminal app ---------------------------------------------------------------------------
const out = process.stdout;
const W = () => out.columns || 100, H = () => out.rows || 30;
let input = '', convo = []; // convo: array of {who, text}
let prevBuf = [], prevDim = ''; // frame cache for diff rendering (repaint only changed rows -> no flicker)
let curBotMsg = null;       // active assistant messageID for streaming

function pushUser(text) { convo.push({ who: 'you', text }); }
function appendBot(messageID, delta) {
  if (curBotMsg !== messageID) { curBotMsg = messageID; convo.push({ who: p.label, text: '' }); }
  convo[convo.length - 1].text += delta;
}

function wrap(text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > width) { out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    out.push(line);
  }
  return out;
}

function render() {
  const cols = W(), rows = H();
  const face = faceLines();                 // 16 lines, 32 cols
  const statusColor = { idle: '90', thinking: '93', working: '96', speaking: '92', error: '91' }[state.status] || '90';
  const exprIcon = { neutral: '·', happy: '☺', sad: '·', angry: '▲', surprised: '!' }[state.expr] || '·';
  const side = [
    `\x1b[1m${p.label}\x1b[0m \x1b[90m· ${PERSONA}\x1b[0m`,
    `\x1b[${statusColor}m● ${state.status}\x1b[0m`,
    `\x1b[95m${exprIcon} ${state.expr}\x1b[0m`,
    DEMO ? '\x1b[90mdemo mode\x1b[0m' : `\x1b[90m${MODEL.providerID}/${MODEL.modelID}\x1b[0m`,
  ];
  const buf = [];
  // rows 0..15: face + side panel
  for (let i = 0; i < face.length; i++) {
    buf.push(face[i] + '  ' + (side[i] || ''));
  }
  buf.push(''); // gap

  // transcript region
  const transW = Math.max(20, cols - 2);
  const flat = [];
  for (const m of convo) {
    const tag = m.who === 'you' ? '\x1b[96myou ›\x1b[0m ' : `\x1b[95m${m.who} ›\x1b[0m `;
    const wlines = wrap(m.text, transW - 6);
    flat.push(tag + (wlines[0] || ''));
    for (let i = 1; i < wlines.length; i++) flat.push('      ' + wlines[i]);
  }
  const inputRows = 2;
  const avail = Math.max(1, rows - face.length - 1 - inputRows);
  const shown = flat.slice(-avail);
  for (let i = 0; i < avail; i++) buf.push(shown[i] || '');

  // input line
  buf.push('\x1b[90m' + '─'.repeat(Math.min(cols, 80)) + '\x1b[0m');
  buf.push(`\x1b[92m›\x1b[0m ${input}\x1b[7m \x1b[0m`);

  // diff paint: only rewrite rows that changed since last frame (kills flicker)
  const dim = cols + 'x' + rows;
  let frame = '';
  if (dim !== prevDim) { frame += '\x1b[2J'; prevBuf = []; prevDim = dim; } // resize -> full repaint
  const n = Math.min(Math.max(buf.length, prevBuf.length), rows);
  for (let r = 0; r < n; r++) {
    const line = buf[r] || '';
    if (line !== prevBuf[r]) {
      frame += `\x1b[${r + 1};1H` + line + '\x1b[K'; // position, content, clear to EOL
      prevBuf[r] = line;
    }
  }
  prevBuf.length = buf.length; // drop rows no longer present
  if (frame) out.write(frame);
}

// ---- animation tick -------------------------------------------------------------------------
function tick() {
  const t = now();
  // blink
  if (state.blink && t > blinkOffAt) { state.blink = false; nextBlinkAt = t + 2200 + Math.random() * 2800; }
  else if (!state.blink && t > nextBlinkAt) { state.blink = true; blinkOffAt = t + 140; }
  // lip-sync: consume one queued char per frame, but follow the LATEST output — agents write far
  // faster than one char per frame, and playing the whole backlog kept the mouth flapping for
  // minutes after the agent went quiet. Skip everything beyond ~2s of backlog (like the browser
  // engine's pushTokens), applying skipped expression markers so a fast-forwarded [[face:X]] still
  // lands the right mood; within the window a marker still fires when the mouth reaches its spot.
  if (speakBuf.length) {
    while (speakBuf.length > 25) {
      const skipped = speakBuf.shift();
      if (skipped && typeof skipped === 'object') applyExpr(skipped.expr);
    }
    let head = speakBuf.shift();
    while (head && typeof head === 'object') { applyExpr(head.expr); head = speakBuf.shift(); }
    if (head !== undefined) { state.viseme = vis(head); state.speaking = true; state.status = 'speaking'; }
  }
  else if (state.speaking && t - lastDeltaAt > 300) { state.speaking = false; state.viseme = null; }
  if (!state.speaking && !speakBuf.length && turnDone && state.status !== 'idle' && state.status !== 'error') state.status = 'idle';
  render();
}

// Streaming parser: pull [[face:X]] tags out of the text before it reaches the transcript +
// lip-sync, holding back any trailing fragment that might be the start of a tag split across deltas.
const TAG_RE = /\[\[\s*face\s*:\s*([a-zA-Z]+)\s*\]\]/gi;
let pendingText = '', pendingMsg = null;

function applyExpr(e) { e = e.toLowerCase().trim(); if (p.expr[e]) state.expr = e; }

function emitClean(messageID, text) {
  if (!text) return;
  appendBot(messageID, text);
  for (const ch of text) speakBuf.push(ch);
}

function feedText(messageID, delta) {
  if (pendingMsg !== messageID) { pendingText = ''; pendingMsg = messageID; }
  pendingText += delta;
  // Consume complete tags in order, queueing an expression marker into the speech stream at the
  // exact spot the tag sat — the face changes when the mouth gets there, not all at once.
  for (;;) {
    TAG_RE.lastIndex = 0;
    const m = TAG_RE.exec(pendingText);
    if (!m) break;
    emitClean(messageID, pendingText.slice(0, m.index));
    speakBuf.push({ expr: m[1] });
    pendingText = pendingText.slice(m.index + m[0].length);
  }
  // hold back a possible partial tag at the tail: from the last unclosed "[[", or a lone trailing "["
  let hold = pendingText.length;
  const lastOpen = pendingText.lastIndexOf('[[');
  if (lastOpen >= 0 && pendingText.indexOf(']]', lastOpen) < 0) hold = lastOpen;
  else if (pendingText.endsWith('[')) hold = pendingText.length - 1;
  emitClean(messageID, pendingText.slice(0, hold));
  pendingText = pendingText.slice(hold);
  lastDeltaAt = now();
  state.status = 'speaking';
}

// ---- OpenCode driver ------------------------------------------------------------------------
const AUTH = PASSWORD ? { authorization: 'Basic ' + Buffer.from(`opencode:${PASSWORD}`).toString('base64') } : {};
const HDR = { 'content-type': 'application/json', ...AUTH };
let abort = new AbortController();

async function createSession() {
  // Per-persona title so this face's session is identifiable when one server's store
  // holds several (only used by standalone faces; mesh faces attach by --session id).
  const r = await fetch(`${SERVER}/session`, { method: 'POST', headers: HDR, body: JSON.stringify({ title: `face-term:${PERSONA}` }) });
  if (!r.ok) throw new Error(`create session: HTTP ${r.status}`);
  return (await r.json()).id;
}

async function sendPrompt(sid, text) {
  turnDone = false; state.status = 'thinking'; state.expr = 'neutral'; // reply tags override
  // Attached sessions keep their own model + system (persona) — only own sessions get ours.
  const body = SESSION
    ? { parts: [{ type: 'text', text }] }
    : { model: MODEL, system: FACE_SYSTEM, parts: [{ type: 'text', text }] };
  const r = await fetch(`${SERVER}/session/${sid}/message`, {
    method: 'POST', headers: HDR,
    body: JSON.stringify(body),
  });
  if (!r.ok) { state.status = 'error'; convo.push({ who: p.label, text: `[send failed: HTTP ${r.status}]` }); }
}

async function streamEvents(sid) {
  // Current opencode emits session events on /global/event (wrapped {directory, payload});
  // the bare /event stream only heartbeats. Older servers know just /event.
  let res = await fetch(`${SERVER}/global/event`, { signal: abort.signal, headers: AUTH });
  if (!res.ok) res = await fetch(`${SERVER}/event`, { signal: abort.signal, headers: AUTH });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        handleEvent(sid, ev.payload ?? ev); // /global/event wraps the event in {directory, payload}
      }
    }
  }
}

/** The event stream is gone (serve exited, or the connection failed): the agent cannot speak
 *  anymore, so stop the mouth NOW — drop the un-played backlog instead of talking on as if alive. */
function streamDead() {
  speakBuf.length = 0;
  state.speaking = false; state.viseme = null; turnDone = true;
  state.status = 'error';
}

// A mesh agent speaks through the cotal send tools — its words are tool-call ARGUMENTS, not
// streamed assistant text, so lip-sync them from the completed tool part's input.
const MESH_SEND_TOOLS = new Set(['cotal_send', 'cotal_dm', 'cotal_anycast']);
const fedParts = new Set(); // a part emits several `updated` events — feed each send once
const msgRole = new Map(); // messageID -> role; only assistant text parts get lip-synced
const fedLen = new Map(); // text part id -> chars already fed (parts arrive as growing snapshots)

function feedMeshSend(part) {
  if (fedParts.has(part.id)) return;
  fedParts.add(part.id);
  const inp = part.state?.input || {};
  if (!inp.text) return;
  const prefix =
    part.tool === 'cotal_dm' ? `(dm → ${inp.to}) `
    : part.tool === 'cotal_anycast' ? `(@${inp.role}) `
    : inp.channel && inp.channel !== 'general' ? `(#${inp.channel}) `
    : '';
  feedText(part.id, prefix + inp.text);
}

function handleEvent(sid, ev) {
  const pr = ev.properties || {};
  const evSid = pr.sessionID || pr.part?.sessionID;
  if (evSid && evSid !== sid) return;
  switch (ev.type) {
    case 'message.updated':
      if (pr.info?.id) msgRole.set(pr.info.id, pr.info.role);
      break;
    case 'message.part.delta':
      // Text parts arrive BOTH as deltas and as growing snapshots (part.updated) — the shared
      // fedLen ledger (chars fed per part) keeps the two paths from double-feeding.
      if (pr.field === 'text' && pr.delta && msgRole.get(pr.messageID) === 'assistant') {
        const key = pr.partID || pr.messageID;
        feedText(key, pr.delta);
        fedLen.set(key, (fedLen.get(key) || 0) + pr.delta.length);
      } else if (pr.field === 'reasoning' && state.status !== 'speaking') state.status = 'thinking';
      break;
    case 'message.part.updated': {
      const part = pr.part;
      if (!part) break;
      if (part.type === 'tool') {
        if (part.tool?.startsWith('face_')) {
          // Expression tool (mesh mode): the mood rides the tool name (face_happy → happy). It
          // never animates the mouth (it isn't speech) and never shows status — just set the face.
          if (part.state?.status === 'completed') {
            const e = part.tool.slice(5);
            if (EXPRS.includes(e)) state.expr = e;
          }
        } else if (MESH_SEND_TOOLS.has(part.tool) && part.state?.status === 'completed') feedMeshSend(part);
        else if (state.status !== 'speaking') state.status = 'working';
      } else if (part.type === 'text' && msgRole.get(part.messageID) === 'assistant') {
        // Snapshot: full text so far — feed only what the delta path hasn't already. Key the
        // bubble by part id: a message can hold several text parts, and feeding them under one
        // messageID would concatenate them without a break.
        const prev = fedLen.get(part.id) || 0;
        const text = part.text || '';
        if (text.length > prev) { feedText(part.id, text.slice(prev)); fedLen.set(part.id, text.length); }
      } else if (part.type === 'reasoning' && state.status !== 'speaking') state.status = 'thinking';
      break;
    }
    case 'session.idle':
      turnDone = true; // tick() flips to idle once the lip-sync buffer drains
      break;
    case 'session.error':
      state.status = 'error'; state.expr = 'sad';
      break;
  }
}

// ---- demo (no server) -----------------------------------------------------------------------
async function demoTurn(text) {
  state.status = 'thinking'; state.expr = 'neutral';
  await sleep(1100);
  const messageID = 'demo-' + now();
  for (const ch of text) { feedText(messageID, ch); await sleep(45); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- input + lifecycle ----------------------------------------------------------------------
let sid = null, sessionPromise = null;
function getSession() { // one session, no race; --session attaches instead of creating
  if (!sessionPromise) sessionPromise = SESSION ? Promise.resolve(SESSION) : createSession();
  return sessionPromise;
}

async function submit(text) {
  if (!text.trim()) return;
  pushUser(text);
  if (DEMO) { demoTurn('you said: ' + text + '. ' + p.lines[0]); return; }
  let s; try { s = await getSession(); } catch (e) { convo.push({ who: p.label, text: '[' + e.message + ']' }); return; }
  sendPrompt(s, text);
}

function cleanup() {
  abort.abort();
  out.write('\x1b[?25h\x1b[?1049l'); // show cursor, leave alt screen
  try { process.stdin.setRawMode(false); } catch {}
  process.exit(0);
}

async function main() {
  if (has('list')) { out.write(Object.keys(PERSONAS).join('\n') + '\n'); process.exit(0); }
  if (has('dump')) { // debug: print the composed key-grid as ASCII and exit
    if (flag('expr')) state.expr = flag('expr');
    if (has('speak')) { state.speaking = true; state.viseme = flag('viseme', 'D'); }
    const g = composeGrid();
    out.write(g.map((row) => row.map((k) => k || '·').join('')).join('\n') + '\n');
    process.exit(0);
  }
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J'); // alt screen, hide cursor, clear
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    for (const ch of d) {
      if (ch === '\x03' || ch === '\x04') return cleanup();           // Ctrl-C / Ctrl-D
      if (ch === '\r' || ch === '\n') { const t = input; input = ''; submit(t); }
      else if (ch === '\x7f' || ch === '\b') input = input.slice(0, -1); // backspace
      else if (ch >= ' ') input += ch;
    }
  });
  process.on('SIGINT', cleanup);
  out.on('resize', render);

  setInterval(tick, 80);

  if (DEMO) {
    convo.push({ who: p.label, text: 'demo mode — type a line + Enter and watch me talk it. Ctrl-C to quit.' });
    await sleep(600);
    // sample tags exercise the emotion parser without a server
    demoTurn('[[face:happy]] hello! the avatar is online. [[face:surprised]] oh — and i react. ' +
             '[[face:angry]] that bug made me furious, [[face:happy]] but i fixed it. [[face:neutral]] ask me anything.');
  } else {
    convo.push({
      who: p.label,
      text: SESSION
        ? `watching ${p.label} · session ${SESSION.slice(0, 16)}… type + Enter to talk to it.`
        : `connected to ${SERVER} · model ${MODEL.providerID}/${MODEL.modelID}. ask me something + Enter.`,
    });
    try { sid = await getSession(); streamEvents(sid).then(streamDead, streamDead); }
    catch (e) { convo.push({ who: p.label, text: '[no server at ' + SERVER + ' — run `opencode serve --port 4096`, or use --demo]' }); }
  }
}

main();
