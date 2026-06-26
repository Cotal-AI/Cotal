// cotal-opencode.js — drive a <cotal-face> from a live OpenCode session (browser).
//
// Browser port of ../face-term.mjs's transport: create/attach a session, POST prompts,
// subscribe to the SSE event stream, and map streamed assistant text -> face.pushTokens(),
// [[face:X]] tags -> face.expr, tool/reasoning -> face.setActivity(). Same wire contract as
// the terminal face — only the renderer it drives is different.
//
//   import { driveFace } from './cotal-opencode.js';
//   const drv = driveFace(faceEl, { server: '', persona: 'sven' }); // '' = same origin
//   drv.send('hey, what are you working on?');
//
// Optional hooks: onActivity(persona,kind) · onExpr(persona,expr) · onMeshSend(edge) ·
// onLog({kind,...}) — the last streams the raw session (reason/say/tool/send/idle/error) for a
// terminal-style view of what the agent is doing.

const EXPRS = ['neutral', 'happy', 'sad', 'angry', 'surprised'];
const MESH_SEND_TOOLS = new Set(['cotal_send', 'cotal_dm', 'cotal_anycast']);
const TAG_RE = /\[\[\s*face\s*:\s*([a-zA-Z]+)\s*\]\]/gi;

// The agent steers its own expression by emitting hidden [[face:X]] tags; the driver strips them.
const FACE_SYSTEM =
  'You speak through an animated pixel-art avatar of yourself shown above your reply. ' +
  'Convey emotion by emitting an inline tag [[face:X]] where X is one of: ' + EXPRS.join(', ') + '. ' +
  'Put the tag immediately before the sentence it applies to, and change it whenever your mood shifts ' +
  '(e.g. [[face:angry]] before describing a frustrating bug, [[face:happy]] when it works). ' +
  'Use them naturally and often. Never mention, explain, or apologize for the tags — they are invisible to the user.';

export function driveFace(faceEl, opts = {}) {
  const server = (opts.server || '').replace(/\/$/, ''); // '' => same origin (serve-wall proxies)
  const persona = opts.persona || 'ray';
  const attach = opts.session || ''; // attach to an existing session instead of creating one
  const [providerID, ...rest] = (opts.model || 'opencode-go/glm-5.1').split('/');
  const MODEL = { providerID, modelID: rest.join('/') };
  const AUTH = opts.password ? { authorization: 'Basic ' + btoa('opencode:' + opts.password) } : {};
  const HDR = { 'content-type': 'application/json', ...AUTH };
  const abort = new AbortController();

  // setActivity + optional report to the wall (per-face status badge); no-op without onActivity.
  // setActivity also mutates the face's expression (idle→happy, error→angry, …); surface that through
  // onExpr too, so a text "emotion" readout always mirrors the face instead of drifting out of sync.
  const setAct = (kind, detail) => { faceEl.setActivity(kind, detail); opts.onActivity?.(persona, kind); opts.onExpr?.(persona, faceEl.expr); };
  // expression changes (for a text "emotion" readout) and a structured activity log (for a terminal view).
  const setExpr = (e) => { faceEl.expr = e; opts.onExpr?.(persona, e); };
  const emitLog = (kind, extra) => opts.onLog?.({ kind, ...extra });

  const msgRole = new Map(); // messageID -> role; only assistant text gets lip-synced
  const fedParts = new Set(); // a part emits several `updated` events — feed each mesh send once
  const loggedTools = new Set(); // non-mesh tool parts already written to the terminal log
  const fedLen = new Map(); // text part id -> chars already fed (parts arrive as growing snapshots)
  let pendingText = '', pendingMsg = null; // streaming [[face:X]] parser state
  let speaking = false;

  // ---- streaming parser (mirrors face-term.feedText) ----------------------------
  const applyExpr = (e) => { e = e.toLowerCase().trim(); if (EXPRS.includes(e)) setExpr(e); };
  const emitClean = (text) => { if (text) { speaking = true; faceEl.pushTokens(text); } };

  // Pull [[face:X]] tags out before the text reaches the mouth, holding back any trailing
  // fragment that might be the start of a tag split across deltas.
  function feedText(messageID, delta) {
    if (pendingMsg !== messageID) { pendingText = ''; pendingMsg = messageID; faceEl.caption = ''; }
    pendingText += delta;
    for (;;) {
      TAG_RE.lastIndex = 0;
      const m = TAG_RE.exec(pendingText);
      if (!m) break;
      emitClean(pendingText.slice(0, m.index));
      applyExpr(m[1]);
      pendingText = pendingText.slice(m.index + m[0].length);
    }
    let hold = pendingText.length;
    const lastOpen = pendingText.lastIndexOf('[[');
    if (lastOpen >= 0 && pendingText.indexOf(']]', lastOpen) < 0) hold = lastOpen;
    else if (pendingText.endsWith('[')) hold = pendingText.length - 1;
    emitClean(pendingText.slice(0, hold));
    pendingText = pendingText.slice(hold);
  }

  // A mesh agent speaks through the cotal send tools — its words are tool-call ARGUMENTS,
  // not streamed assistant text, so lip-sync them from the completed tool part's input.
  function feedMeshSend(part) {
    if (fedParts.has(part.id)) return;
    fedParts.add(part.id);
    const inp = part.state?.input || {};
    if (!inp.text) return;
    emitLog('send', { tool: part.tool, to: inp.to, role: inp.role, channel: inp.channel, text: inp.text });
    // Report the real agent→agent edge to the wall (who messaged whom); routing is otherwise discarded.
    opts.onMeshSend?.({
      from: persona, tool: part.tool,
      mode: part.tool === 'cotal_dm' ? 'unicast' : part.tool === 'cotal_anycast' ? 'anycast' : 'chat',
      to: inp.to, role: inp.role, channel: inp.channel, text: inp.text, ts: Date.now(),
    });
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
    if (evSid && evSid !== sid) return; // /global/event is server-wide — keep only this session
    switch (ev.type) {
      case 'message.updated':
        if (pr.info?.id) msgRole.set(pr.info.id, pr.info.role);
        break;
      case 'message.part.delta':
        if (pr.field === 'text' && pr.delta && msgRole.get(pr.messageID) === 'assistant') {
          const key = pr.partID || pr.messageID;
          feedText(key, pr.delta);
          fedLen.set(key, (fedLen.get(key) || 0) + pr.delta.length);
          emitLog('say', { msg: key, text: pr.delta });
        } else if (pr.field === 'reasoning') {
          emitLog('reason', { msg: pr.messageID, text: pr.delta });
          if (!speaking) setAct('thinking');
        }
        break;
      case 'message.part.updated': {
        const part = pr.part;
        if (!part) break;
        if (part.type === 'tool') {
          if (MESH_SEND_TOOLS.has(part.tool) && part.state?.status === 'completed') feedMeshSend(part);
          else {
            if (!loggedTools.has(part.id)) { loggedTools.add(part.id); emitLog('tool', { tool: part.tool, msg: part.messageID }); }
            if (!speaking) setAct('working');
          }
        } else if (part.type === 'text' && msgRole.get(part.messageID) === 'assistant') {
          // Snapshot: full text so far — feed only what the delta path hasn't already.
          const prev = fedLen.get(part.id) || 0;
          const text = part.text || '';
          if (text.length > prev) { feedText(part.id, text.slice(prev)); emitLog('say', { msg: part.id, text: text.slice(prev) }); fedLen.set(part.id, text.length); }
        } else if (part.type === 'reasoning' && !speaking) setAct('thinking');
        break;
      }
      case 'session.idle':
        speaking = false;
        setAct('waiting');
        emitLog('idle');
        break;
      case 'session.error':
        speaking = false;
        setAct('error');
        emitLog('error');
        break;
    }
  }

  // ---- OpenCode driver ----------------------------------------------------------
  async function createSession() {
    // Per-persona title so this face's session is identifiable in a shared store
    // (same convention as the terminal face).
    const r = await fetch(`${server}/session`, { method: 'POST', headers: HDR, body: JSON.stringify({ title: `face-term:${persona}` }) });
    if (!r.ok) throw new Error(`create session: HTTP ${r.status}`);
    return (await r.json()).id;
  }

  async function sendPrompt(sid, text) {
    speaking = false;
    setAct('thinking');
    faceEl.expr = 'neutral'; // reply tags override
    // Attached sessions keep their own model + system (persona) — only own sessions get ours.
    const body = attach
      ? { parts: [{ type: 'text', text }] }
      : { model: MODEL, system: FACE_SYSTEM, parts: [{ type: 'text', text }] };
    setExpr('neutral'); // reply tags override
    const r = await fetch(`${server}/session/${sid}/message`, { method: 'POST', headers: HDR, body: JSON.stringify(body) });
    if (!r.ok) setAct('error');
  }

  async function streamEvents(sid) {
    // Current opencode emits session events on /global/event (wrapped {directory, payload});
    // older servers know just /event.
    let res = await fetch(`${server}/global/event`, { signal: abort.signal, headers: AUTH });
    if (!res.ok) res = await fetch(`${server}/event`, { signal: abort.signal, headers: AUTH });
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
          let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handleEvent(sid, evt.payload ?? evt); // /global/event wraps the event in {directory, payload}
        }
      }
    }
  }

  let sidPromise = null;
  const getSession = () => (sidPromise ??= attach ? Promise.resolve(attach) : createSession());

  // Keep the session event stream alive for the life of the page. A long-lived SSE gets reset
  // periodically (idle proxy/server timeouts) — a transient drop must NOT kill the face or strand
  // it on a fake "error"; reconnect and keep streaming. Only a real session.error sets error.
  (async () => {
    let sid;
    try { sid = await getSession(); } catch { setAct('error'); return; }
    while (!abort.signal.aborted) {
      try { await streamEvents(sid); } catch { /* stream dropped — reconnect below */ }
      if (abort.signal.aborted) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  return {
    async send(text) {
      if (!text || !text.trim()) return;
      let sid; try { sid = await getSession(); } catch { setAct('error'); return; }
      sendPrompt(sid, text);
    },
    stop() { abort.abort(); },
  };
}
