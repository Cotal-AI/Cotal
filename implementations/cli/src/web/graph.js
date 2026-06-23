/* Cotal — live mesh graph. Channels and agents are nodes in a force-directed constellation:
 * channel "spokes" pull an agent toward the channels it's subscribed to (so an agent on two channels
 * floats between both hubs), DM springs pull peers together, and charge spreads everything out. A wire
 * glows + fires a comet when a message flows. Fed by the same /feed SSE + REST the Monitor uses.
 *
 * Membership is AUTHORITATIVE and broker-sourced (not self-reported): the delivery daemon reads the
 * broker's connection view (CONNZ) ∪ the durable members registry and publishes a derived feed; the
 * observer serves it at /api/membership + a `membership` SSE event. So a spoke is drawn for every channel
 * an agent is actually subscribed to — including SILENT readers and `live` channels that keep no
 * enumerable roster. A `live` (connected) member draws solid-faint; a member that's only durable while its
 * presence is offline draws dashed-dim ("member, currently offline"). Traffic glow rides on top: a post
 * sends a comet to the hub, the hub blooms, then fans out to every other member. If the feed is absent
 * (no daemon / a space provisioned before this feature), the graph degrades to traffic-only and says so.
 *
 * Stability: messages drive *glow*, not layout. The simulation cools to a rest state (alpha decay) and
 * only gently re-heats when the node/edge SET changes — so nodes don't wander on every message. */
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("graph");
  const ctx = canvas.getContext("2d");

  // ── palette ──
  const MODE = { chat: "#58a6ff", unicast: "#d29922", anycast: "#3fb950" };
  const STAT = { working: "#46d35e", waiting: "#e9bf52", idle: "#9aa6b5", offline: "#5a6472" };
  const MEM_LIVE = "#8493a8"; // a live (connected) membership spoke
  const MEM_OFF = "#5a6472"; // a durable member whose presence is offline ("member, currently offline")
  const TRAFFIC_COLD = 0.02; // heat below which a NON-member (traffic-only) spoke is pruned
  const FEED_STALE_MS = 45000; // membership feed older than this reads "stale" (daemon polls ~15s)

  // ── state ──
  const hubs = new Map(); // channel -> hub node
  const agents = new Map(); // id -> agent node
  const edges = new Map(); // `${agentId}|${chan}` -> { a, chan, last, heat, mem, durableOnly }
  const dms = new Map(); // `${idA}|${idB}` (sorted) -> { a, b, last, heat }
  const particles = [];
  const blooms = [];
  const recent = [];
  const feed = { asOf: undefined, available: false }; // membership-feed freshness
  const cam = { x: 0, y: 0, scale: 1, ready: false, user: false };
  const filter = { chat: true, unicast: true, anycast: true, window: 30, paused: false };
  let W = 0, H = 0, DPR = 1, hover = null, sel = null, lastT = 0, alpha = 1;

  // ── utils ──
  const partsText = (m) => (m.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const shortId = (x) => (/^[A-Z2-7]{32,}$/.test(x) ? x.slice(0, 6) + "…" : x);
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };
  const now = () => Date.now();
  const reheat = () => { alpha = Math.max(alpha, 0.55); };

  // ── channel-subscription matching (ports core subjectMatches; `live` patterns keep wildcards) ──
  const isWild = (ch) => ch.split(".").some((s) => s === "*" || s === ">");
  function patternMatches(pattern, subject) {
    const p = pattern.split("."), s = subject.split(".");
    for (let i = 0; i < p.length; i++) { if (p[i] === ">") return i < s.length; if (i >= s.length) return false; if (p[i] === "*") continue; if (p[i] !== s[i]) return false; }
    return p.length === s.length;
  }
  /** Expand an agent's {live patterns, durable channels} → { channels: channel→kind, wide }. Bounded
   *  wildcards (`team.>`) expand against the KNOWN channel set (registry hubs); concrete patterns stand
   *  alone; `live` wins over `durable`. A WHOLE-BREADTH pattern (`>` or `*` — e.g. the default persona's
   *  read-everything grant) is NOT expanded to a spoke per hub (that's a dandelion); it sets `wide`, and
   *  the agent renders as a "reads-all" node badge instead — truthful without per-channel noise. */
  function memberChannels(live, durable, known) {
    const out = new Map();
    let wide = false;
    for (const pat of live || []) {
      if (pat === ">" || pat === "*") { wide = true; continue; }
      if (isWild(pat)) { for (const ch of known) if (patternMatches(pat, ch)) out.set(ch, "live"); }
      else out.set(pat, "live");
    }
    for (const ch of durable || []) if (!out.has(ch)) out.set(ch, "durable");
    return { channels: out, wide };
  }

  // ── nodes ──
  function spawn(id, seedR) { const a = (hash(id) % 628) / 100, r = seedR + (Math.abs(hash(id)) % 120); return { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 }; }
  function ensureHub(name) {
    if (!name) return null;
    let h = hubs.get(name);
    if (!h) { h = Object.assign({ kind: "hub", name, r: 14, charge: -560, mass: 3, msgs: 0, desc: "" }, spawn("#" + name, 150)); hubs.set(name, h); reheat(); onNewChannel(name); }
    return h;
  }
  function ensureAgent(ref) {
    if (!ref) return null;
    const id = typeof ref === "object" ? ref.id || ref.name : ref;
    if (!id) return null;
    let a = agents.get(id);
    if (!a) { a = Object.assign({ kind: "agent", id, name: (typeof ref === "object" && ref.name) || shortId(id), role: typeof ref === "object" ? ref.role : undefined, status: "idle", activity: "", harness: undefined, ts: 0, live: [], durable: [], memberOf: new Map(), r: 6.5, charge: -190, mass: 1, phase: (hash(id) % 1000) / 1000 * 6.283 }, spawn(id, 70)); agents.set(id, a); reheat(); }
    else if (typeof ref === "object" && ref.name) a.name = ref.name;
    return a;
  }
  const edgeKey = (id, chan) => id + "|" + chan;
  const dmKey = (a, b) => [a, b].sort().join("|");
  function ensureEdge(a, chan) { const k = edgeKey(a.id, chan); let e = edges.get(k); if (!e) { edges.set(k, (e = { a, chan, last: 0, heat: 0, mem: false, durableOnly: false })); reheat(); } return e; }
  function chatHit(a, chan, ts) { const e = ensureEdge(a, chan); e.last = Math.max(e.last, ts); return e; }
  function dmHit(a, b, ts) { const k = dmKey(a.id, b.id); let d = dms.get(k); if (!d) { dms.set(k, (d = { a, b, last: 0, heat: 0 })); reheat(); } d.last = Math.max(d.last, ts); return d; }
  function primaryChan(a) { let best = null, bt = 0; for (const e of edges.values()) if (e.a === a && e.last > bt) { bt = e.last; best = e.chan; } return best; }

  // When a channel first appears, retro-link any agent whose live WILDCARD covers it (so a `team.>`
  // subscriber gains a spoke to a newly-created `team.backend` with no membership-feed round-trip).
  function onNewChannel(name) {
    for (const a of agents.values()) for (const pat of a.live || []) { if (pat === ">" || pat === "*") continue; if (isWild(pat) && patternMatches(pat, name)) { const e = ensureEdge(a, name); e.mem = true; e.durableOnly = false; a.memberOf.set(name, "live"); } }
  }

  // ── force simulation (cooling; re-heated only on structural change) ──
  function link(a, b, len, k) { let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1; const f = (d - len) * k * alpha, fx = (dx / d) * f, fy = (dy / d) * f; a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy; }
  function physics() {
    if (alpha < 0.004 || filter.paused) return;
    const ns = [...hubs.values(), ...agents.values()];
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (hash(a.name + i) % 11) - 5; dy = (hash(b.name + j) % 11) - 5; d2 = dx * dx + dy * dy || 1; }
        const d = Math.sqrt(d2), q = ((a.charge * b.charge) / d2) * alpha;
        a.vx += (dx / d) * q; a.vy += (dy / d) * q; b.vx -= (dx / d) * q; b.vy -= (dy / d) * q;
      }
    }
    for (const e of edges.values()) { const h = hubs.get(e.chan); if (h) link(e.a, h, 105, 0.08); }
    for (const d of dms.values()) link(d.a, d.b, 165, 0.03);
    // small graphs: faint tangential nudge so agents form a loose ring around their hub instead of a line (decays with alpha)
    if (hubs.size <= 2) for (const a of agents.values()) { const h = (primaryChan(a) && hubs.get(primaryChan(a))) || [...hubs.values()][0]; if (h) { const dx = a.x - h.x, dy = a.y - h.y, d = Math.hypot(dx, dy) || 1; a.vx += (-dy / d) * 0.4 * alpha; a.vy += (dx / d) * 0.4 * alpha; } }
    // collision: position-based min-distance — prevents the 1/d² charge singularity + node overlap
    const pad = 10;
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
        const min = a.r + b.r + pad;
        if (d < min) { const push = (min - d) / 2, ux = dx / d, uy = dy / d; a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push; const va = a.vx * ux + a.vy * uy, vb = b.vx * ux + b.vy * uy; a.vx -= va * ux; a.vy -= va * uy; b.vx -= vb * ux; b.vy -= vb * uy; }
      }
    }
    for (const n of ns) {
      n.vx += -n.x * 0.014 * alpha; n.vy += -n.y * 0.014 * alpha; // gravity toward center
      n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx / (n.mass || 1); n.y += n.vy / (n.mass || 1); // heavier hubs resist the kick
    }
    alpha += (0 - alpha) * 0.0228;
  }

  // ── traffic ──
  const mk = (a, b, color, onArrive, curve) => ({ a, b, t: 0, dur: curve ? 1.4 : 1.1, color, onArrive: onArrive || null, curve: !!curve, trail: [] });
  function onMessage({ mode, senderId, msg }) {
    if (!msg) return;
    const from = ensureAgent(senderId ? { id: senderId, name: msg.from?.name, role: msg.from?.role } : msg.from);
    if (from) from.ts = now();
    const animate = !filter.paused && filter[mode];
    let toName = null;
    if (mode === "chat" && msg.channel) {
      const h = ensureHub(msg.channel);
      if (from) chatHit(from, msg.channel, now()).heat = 1;
      // inbound: sender → hub, then the hub flashes and fans the post back out to every other member on
      // the channel (their spokes glow as the wave reaches them) — a real broadcast.
      if (animate && from && h) particles.push(mk(from, h, MODE.chat, () => {
        blooms.push({ x: h.x, y: h.y, t: 0, dur: 0.95, color: MODE.chat, r0: h.r });
        for (const e of edges.values()) if (e.chan === msg.channel && e.a !== from) { e.heat = 1; particles.push(mk(h, e.a, MODE.chat, null, false)); }
      }));
    } else if (mode === "unicast") {
      const to = typeof msg.to === "string" ? agents.get(msg.to) : msg.to && agents.get(msg.to.id);
      toName = to?.name || (typeof msg.to === "string" ? shortId(msg.to) : msg.to?.name);
      if (from && to && from !== to) { dmHit(from, to, now()).heat = 1; if (animate) particles.push(mk(from, to, MODE.unicast, null, true)); }
    } else if (mode === "anycast") {
      toName = "@" + (msg.toService || "");
      if (animate && from) blooms.push({ x: from.x, y: from.y, t: 0, dur: 1.0, color: MODE.anycast, r0: from.r });
    }
    recent.push({ mode, from: from?.name, fromId: from?.id, to: toName, chan: msg.channel, text: partsText(msg), ts: msg.ts || now() });
    if (recent.length > 80) recent.shift();
    if (sel) renderDetail();
  }
  function updateRoster(list) {
    const seen = new Set();
    for (const p of list) {
      if (p.card?.kind === "endpoint") continue;
      const a = ensureAgent({ id: p.card.id, name: p.card.name, role: p.card.role });
      a.status = p.status; a.activity = p.activity || ""; a.role = p.card.role; a.harness = p.card.meta?.connector; a.ts = p.ts;
      seen.add(a.id);
    }
    // Drop an agent as soon as it goes offline OR leaves the roster (main's ghost fix, c9e9000) — EXCEPT
    // keep it if it's still a feed member: a durable member whose presence is offline must persist to
    // render as "member, currently offline" (the feed's durable arm survives offline). Membership is
    // broker-truth, applied separately; presence no longer carries channels.
    for (const [id, a] of agents) if ((!seen.has(id) || a.status === "offline") && !(a.wideReader || (a.memberOf && a.memberOf.size))) { agents.delete(id); for (const k of [...edges.keys()]) if (edges.get(k).a === a) edges.delete(k); for (const k of [...dms.keys()]) { const d = dms.get(k); if (d.a === a || d.b === a) dms.delete(k); } reheat(); if (sel === a) closeDetail(); }
  }

  // ── membership (authoritative spokes) ──
  function applyMembership(snap) {
    if (!snap) return;
    feed.asOf = snap.asOf;
    feed.available = snap.asOf !== undefined || (Array.isArray(snap.members) && snap.members.length > 0);
    setFeed();
    const known = [...hubs.keys()];
    const present = new Set();
    for (const m of snap.members || []) {
      const a = ensureAgent({ id: m.id });
      present.add(a.id);
      a.live = m.live || []; a.durable = m.durable || [];
      const mc = memberChannels(a.live, a.durable, known);
      a.memberOf = mc.channels; a.wideReader = mc.wide;
      for (const [ch, kind] of mc.channels) { ensureHub(ch); const e = ensureEdge(a, ch); e.mem = true; e.durableOnly = kind === "durable"; }
      pruneMemberEdges(a, mc.channels);
    }
    // An agent that dropped out of the feed entirely is no longer a member of anything (incl. a wide reader,
    // which carries the flag but no concrete edges).
    for (const a of agents.values()) if (!present.has(a.id) && (a.wideReader || (a.memberOf && a.memberOf.size))) { a.live = []; a.durable = []; a.wideReader = false; const empty = new Map(); pruneMemberEdges(a, empty); a.memberOf = empty; }
    if (sel) renderDetail();
  }
  // Drop this agent's membership edges that are no longer in `keep`; a still-warm one stays as a fading
  // traffic-only edge (mem:false) and is pruned later when cold, so a comet in flight isn't orphaned.
  function pruneMemberEdges(a, keep) {
    for (const [k, e] of edges) if (e.a === a && e.mem && !keep.has(e.chan)) { if (e.heat <= TRAFFIC_COLD) edges.delete(k); else { e.mem = false; e.durableOnly = false; } reheat(); }
  }

  // ── render loop ──
  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0); lastT = t;
    // Prune cold traffic-only spokes (a non-member's post that has faded). Membership spokes persist by
    // membership, never on a timer — they're the resting skeleton, faint at rest, glowing on traffic.
    for (const [k, e] of edges) if (!e.mem && e.heat <= TRAFFIC_COLD && now() - e.last > 1000) { edges.delete(k); reheat(); }
    for (const h of hubs.values()) h.empty = ![...edges.values()].some((e) => e.chan === h.name && e.mem); // no members = dormant (silent readers keep it live)
    physics();
    // re-frame only once the sim has cooled, so the camera doesn't chase the re-settle wobble
    if (!cam.user && alpha < 0.12) { const f = fitTarget(); const e = 1 - Math.pow(0.02, dt); cam.x += (f.x - cam.x) * e; cam.y += (f.y - cam.y) * e; cam.scale += (f.scale - cam.scale) * e; }
    if (!filter.paused) { const k = Math.exp(-dt / filter.window); for (const e of edges.values()) e.heat *= k; for (const d of dms.values()) d.heat *= k; }

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawStarfield(ctx, W, H, cam);
    ctx.translate(cam.x, cam.y); ctx.scale(cam.scale, cam.scale);
    drawSpokes(); drawDmEdges(); drawBlooms(dt); drawParticles(dt); drawNodes();
    requestAnimationFrame(frame);
  }

  // Hover/select a hub or agent → highlight its membership fan, dim the rest (dandelion mitigation).
  function fanFocus() { return hover && hover.kind === "hub" ? hover : sel && sel.kind === "hub" ? sel : hover && hover.kind === "agent" ? hover : sel && sel.kind === "agent" ? sel : null; }
  function inFan(e, f) { if (!f) return true; return f.kind === "hub" ? e.chan === f.name : e.a === f; }

  function drawSpokes() {
    ctx.lineCap = "round";
    const f = fanFocus();
    // structure layer: a constant-faint spoke per membership (solid = live, dashed-dim = member-offline)
    for (const e of edges.values()) {
      if (!e.mem) continue;
      const h = hubs.get(e.chan); if (!h) continue;
      const off = e.durableOnly || e.a.status === "offline";
      const lit = inFan(e, f);
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(h.x, h.y);
      ctx.setLineDash(off ? [3, 4] : []);
      ctx.strokeStyle = rgba(off ? MEM_OFF : MEM_LIVE, (off ? 0.3 : 0.42) * (lit ? 1 : 0.28));
      ctx.lineWidth = 1.4; ctx.stroke();
    }
    ctx.setLineDash([]);
    // activity layer: traffic glow on top (members + transient non-member posts)
    ctx.globalCompositeOperation = "lighter";
    for (const e of edges.values()) { const h = hubs.get(e.chan); if (!h || e.heat <= 0.02) continue; const lit = inFan(e, f); ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(h.x, h.y); ctx.strokeStyle = rgba(MODE.chat, Math.min(0.55, e.heat * 0.55) * (lit ? 1 : 0.35)); ctx.lineWidth = 1 + e.heat * 1.6; ctx.stroke(); }
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  }
  function drawDmEdges() {
    ctx.setLineDash([3, 4]);
    for (const d of dms.values()) {
      const mx = (d.a.x + d.b.x) / 2, my = (d.a.y + d.b.y) / 2, nx = -(d.b.y - d.a.y), ny = d.b.x - d.a.x, len = Math.hypot(nx, ny) || 1;
      const cx = mx + (nx / len) * 24, cy = my + (ny / len) * 24;
      ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.quadraticCurveTo(cx, cy, d.b.x, d.b.y);
      ctx.strokeStyle = rgba(MODE.unicast, 0.5 + d.heat * 0.45); ctx.lineWidth = 1.7 + d.heat * 1.6; ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  function drawNodes() {
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const t = performance.now() / 1000;
    for (const h of hubs.values()) {
      const focus = h === hover || h === sel, dim = h.empty ? 0.55 : 1; // dormant hubs read quieter, not gone
      ctx.save(); ctx.shadowColor = MODE.chat; ctx.shadowBlur = (focus ? 28 : 16) * dim;
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.r); g.addColorStop(0, h.empty ? "#16314f" : "#2b5a8f"); g.addColorStop(1, "#0c1726");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
      ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(MODE.chat, 0.95 * dim); ctx.stroke();
      ctx.fillStyle = rgba("#cfe2ff", dim); ctx.font = "600 12.5px var(--font), sans-serif"; ctx.fillText("#" + h.name, h.x, h.y + h.r + 13);
    }
    for (const a of agents.values()) {
      const col = STAT[a.status] || STAT.idle, focus = a === hover || a === sel, off = a.status === "offline";
      const r = a.r + Math.sin(t * 0.8 + a.phase) * 0.4;
      if (a.status === "waiting") { const pulse = 0.5 + 0.5 * Math.sin(t * 1.7); for (const o of [0, 0.5]) { ctx.beginPath(); ctx.arc(a.x, a.y, r + 5 + ((pulse + o) % 1) * 9, 0, 2 * Math.PI); ctx.strokeStyle = rgba(STAT.waiting, (1 - ((pulse + o) % 1)) * 0.45); ctx.lineWidth = 1.6; ctx.stroke(); } }
      // wide reader (subscribes `>`/`*`): a faint dashed halo — "reads all channels" without a spoke per hub
      if (a.wideReader) { ctx.save(); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(a.x, a.y, r + 4.5, 0, 2 * Math.PI); ctx.strokeStyle = rgba(MEM_LIVE, off ? 0.3 : 0.6); ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore(); }
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = focus ? 20 : off ? 3 : 13;
      const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, r); g.addColorStop(0, rgba(col, off ? 0.5 : 1)); g.addColorStop(0.55, rgba(col, off ? 0.2 : 0.55)); g.addColorStop(1, "#141b26");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
      ctx.lineWidth = 2; ctx.strokeStyle = rgba(col, off ? 0.6 : 1); ctx.stroke();
      if (focus || a.status === "waiting" || agents.size <= 16) { ctx.fillStyle = focus ? "#ffffff" : "#cdd6e2"; ctx.font = (focus ? "600 " : "500 ") + "11px var(--font), sans-serif"; ctx.fillText(a.name, a.x, a.y - r - 8); }
    }
    ctx.globalAlpha = 1;
  }

  // ── atmosphere + motion ──
  const prng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  let stars = null, starW = 0, starH = 0;
  function buildStars(W, H) { const r = prng(0x9e3779b1); const arr = new Array(300); for (let i = 0; i < 300; i++) arr[i] = { x: r() * W, y: r() * H, size: 0.3 + r() * 1.0, alpha: 0.04 + r() * 0.26, depth: 0.04 + r() * 0.12, tw: r() < 0.2, ph: r() * Math.PI * 2, sp: 0.4 + r() * 0.9 }; stars = arr; starW = W; starH = H; }
  const drawStarfield = (ctx, W, H, cam) => {
    if (!stars || starW !== W || starH !== H) buildStars(W, H);
    const t = performance.now() / 1000;
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75); g.addColorStop(0, "#202c40"); g.addColorStop(0.55, "#172030"); g.addColorStop(1, "#10161f"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    const blob = (fx, fy, rad, color) => { const ng = ctx.createRadialGradient(W * fx, H * fy, 0, W * fx, H * fy, rad); ng.addColorStop(0, color); ng.addColorStop(1, "transparent"); ctx.globalAlpha = 0.04; ctx.fillStyle = ng; ctx.fillRect(0, 0, W, H); };
    blob(0.28, 0.32, Math.max(W, H) * 0.45, "#1a3a5c"); blob(0.72, 0.68, Math.max(W, H) * 0.4, "#2a1a4a");
    for (const s of stars) { let sx = s.x + cam.x * s.depth, sy = s.y + cam.y * s.depth; sx = ((sx % W) + W) % W; sy = ((sy % H) + H) % H; let a = s.alpha; if (s.tw) a *= 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph)); ctx.globalAlpha = a; ctx.fillStyle = "#cfe0ff"; ctx.beginPath(); ctx.arc(sx, sy, s.size, 0, 2 * Math.PI); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  };
  function drawParticles(dt) {
    ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; if (!filter.paused) p.t += dt / p.dur; const t = ease(Math.min(1, p.t)); let x, y;
      if (p.curve) { const mx = (p.a.x + p.b.x) / 2, my = (p.a.y + p.b.y) / 2, nx = -(p.b.y - p.a.y), ny = p.b.x - p.a.x, len = Math.hypot(nx, ny) || 1, cx = mx + (nx / len) * 24, cy = my + (ny / len) * 24, u = 1 - t; x = u * u * p.a.x + 2 * u * t * cx + t * t * p.b.x; y = u * u * p.a.y + 2 * u * t * cy + t * t * p.b.y; }
      else { x = p.a.x + (p.b.x - p.a.x) * t; y = p.a.y + (p.b.y - p.a.y) * t; }
      if (!filter.paused) { p.trail.push(x, y); if (p.trail.length > 12) p.trail.splice(0, p.trail.length - 12); }
      const n = p.trail.length >> 1;
      for (let k = 0; k < n; k++) { const f = k / Math.max(1, n - 1); ctx.globalAlpha = f * f * 0.6; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.trail[k * 2], p.trail[k * 2 + 1], 1 + f * 2.2, 0, 2 * Math.PI); ctx.fill(); }
      ctx.save(); ctx.shadowColor = p.color; ctx.shadowBlur = 20; ctx.globalAlpha = 1; ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x, y, 2, 0, 2 * Math.PI); ctx.fill(); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x, y, 4.4, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
      if (p.t >= 1) { if (p.onArrive) p.onArrive(); particles.splice(i, 1); }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  }
  function drawBlooms(dt) {
    ctx.globalCompositeOperation = "lighter";
    for (let i = blooms.length - 1; i >= 0; i--) {
      const b = blooms[i]; b.t += dt / b.dur; if (b.t >= 1) { blooms.splice(i, 1); continue; }
      const flash = Math.max(0, 1 - b.t / 0.35);
      if (flash > 0) { const fg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r0 + 18); fg.addColorStop(0, b.color); fg.addColorStop(1, "transparent"); ctx.globalAlpha = flash * 0.5; ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(b.x, b.y, b.r0 + 18, 0, 2 * Math.PI); ctx.fill(); }
      const ring = (off) => { const tt = b.t - off; if (tt <= 0 || tt >= 1) return; ctx.beginPath(); ctx.arc(b.x, b.y, b.r0 + ease(tt) * 28, 0, 2 * Math.PI); ctx.strokeStyle = b.color; ctx.globalAlpha = (1 - tt) * 0.7; ctx.lineWidth = 2; ctx.stroke(); };
      ring(0); ring(0.15);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  }

  // ── camera + hit-testing ──
  function fitTarget() {
    const ns = [...hubs.values(), ...agents.values()]; if (!ns.length) return { x: W / 2, y: H / 2, scale: 1 };
    // content nodes drive the frame; empty hubs only nudge the padding so one stray node can't shrink the live graph
    const content = ns.filter((n) => !(n.kind === "hub" && n.empty)), frame = content.length ? content : ns;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const n of frame) { const r = n.r + 40; a = Math.min(a, n.x - r); c = Math.max(c, n.x + r); b = Math.min(b, n.y - r); d = Math.max(d, n.y + r); }
    for (const h of hubs.values()) if (h.empty) { a = Math.min(a, h.x - 20); c = Math.max(c, h.x + 20); b = Math.min(b, h.y - 20); d = Math.max(d, h.y + 20); }
    const bw = c - a || 1, bh = d - b || 1, pad = 90, maxScale = ns.length <= 6 ? 2.4 : 1.6;
    const scale = Math.max(0.35, Math.min(maxScale, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
    return { x: W / 2 - ((a + c) / 2) * scale, y: H / 2 - ((b + d) / 2) * scale, scale };
  }
  const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale });
  function pick(sx, sy) { const w = toWorld(sx, sy); let best = null, bd = 1e9; for (const n of [...hubs.values(), ...agents.values()]) { const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < n.r + 8 && d < bd) { bd = d; best = n; } } return best; }

  // ── membership freshness pill ──
  function setFeed() {
    const el = $("feed"); if (!el) return;
    el.hidden = false;
    let cls, text;
    if (!feed.available) { cls = "off"; text = "membership: traffic-only"; }
    else { const age = feed.asOf ? now() - feed.asOf : Infinity; if (age < FEED_STALE_MS) { cls = ""; text = "membership: live"; } else { cls = "stale"; text = "membership: stale"; } }
    el.className = "pill" + (cls ? " " + cls : "");
    el.querySelector(".t").textContent = text;
  }

  // ── detail panel ──
  function closeDetail() { sel = null; $("detail").classList.remove("open"); }
  function recentRows(test) {
    const ms = recent.filter(test).slice(-6).reverse();
    return ms.length ? ms.map((m) => `<div class="d-msg" style="border-color:${MODE[m.mode] || "#2a313c"}"><div class="mhead"><span class="m" style="color:${MODE[m.mode] || "#8b949e"}">${m.mode}</span><span class="who">${esc(m.from)}</span>${m.chan ? `<span class="tgt">#${esc(m.chan)}</span>` : m.to ? `<span class="tgt">→ ${esc(m.to)}</span>` : ""}</div><div class="body">${esc(m.text).slice(0, 160) || "—"}</div></div>`).join("") : `<div class="d-msg empty">no recent traffic</div>`;
  }
  function renderDetail() {
    const el = $("detail"); if (!sel) { el.classList.remove("open"); return; }
    if (sel.kind === "hub") {
      // members from the broker feed (subscribed), split into live vs member-currently-offline; plus a
      // "recently active" subset (who actually posted here) vs just-subscribed.
      const mem = [...edges.values()].filter((e) => e.chan === sel.name && e.mem).map((e) => e.a);
      mem.sort((x, y) => x.name.localeCompare(y.name));
      const activeIds = new Set(recent.filter((m) => m.chan === sel.name && m.fromId).map((m) => m.fromId));
      const memberRow = (a) => { const off = a.status === "offline" || (a.memberOf && a.memberOf.get(sel.name) === "durable"); const dotCol = STAT[a.status] || STAT.idle; return `<span class="mtag"><span class="dot" style="background:${off ? MEM_OFF : dotCol}"></span>${esc(a.name)}${activeIds.has(a.id) ? '<span class="act">active</span>' : ""}${off ? '<span class="off">offline</span>' : ""}</span>`; };
      const memberList = mem.length ? `<div class="d-tags">${mem.map(memberRow).join("")}</div>` : `<div class="d-block muted">no subscribers yet</div>`;
      el.innerHTML = `<span class="x" id="dx">✕</span>
        <div class="d-kind">channel</div>
        <div class="d-who">#${esc(sel.name)}</div>
        ${sel.desc ? `<div class="d-block">${esc(sel.desc)}</div>` : ""}
        <div class="d-rows">
          <div class="d-row"><span class="k">subscribers</span><span class="v">${mem.length} agent${mem.length === 1 ? "" : "s"}</span></div>
          <div class="d-row"><span class="k">messages</span><span class="v">${sel.msgs || 0}</span></div>
        </div>
        <div class="d-section"><div class="d-label">members</div>${memberList}</div>
        <div class="d-section"><div class="d-label">recent</div><div class="d-msgs">${recentRows((m) => m.chan === sel.name)}</div></div>`;
    } else {
      // an agent's FULL subscription set from the feed: live patterns + durable. A whole-breadth `>`/`*`
      // grant shows as a single "all channels" chip, not literal `#>`; bounded subtrees show literally.
      const wideChip = sel.wideReader ? `<span class="ctag">all channels</span>` : "";
      const liveSet = (sel.live || []).filter((c) => c !== ">" && c !== "*").map((c) => `<span class="ctag">#${esc(c)}</span>`).join("");
      const durOnly = (sel.durable || []).filter((c) => !(sel.live || []).includes(c)).map((c) => `<span class="ctag off">#${esc(c)}</span>`).join("");
      const subs = wideChip || liveSet || durOnly ? `<div class="d-tags">${wideChip}${liveSet}${durOnly}</div>` : `<div class="d-block muted">no channel subscriptions</div>`;
      el.innerHTML = `<span class="x" id="dx">✕</span>
        <div class="d-kind">agent</div>
        <div class="d-who">${esc(sel.name)}${sel.role ? `<span class="role">${esc(sel.role)}</span>` : ""}</div>
        <div class="d-status ${sel.status}"><span class="dot"></span>${esc(sel.status)}</div>
        <div class="d-section"><div class="d-label">activity</div><div class="d-block ${sel.activity ? "" : "muted"}">${esc(sel.activity || "no current activity")}</div></div>
        <div class="d-section"><div class="d-label">subscribes</div>${subs}</div>
        ${sel.harness ? `<div class="d-rows"><div class="d-row"><span class="k">harness</span><span class="v">${esc(sel.harness)}</span></div></div>` : ""}
        <div class="d-section"><div class="d-label">recent</div><div class="d-msgs">${recentRows((m) => m.from === sel.name || m.to === sel.name)}</div></div>`;
    }
    el.classList.add("open"); $("dx").onclick = closeDetail;
  }

  // ── events ──
  function resize() { DPR = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight; canvas.width = W * DPR; canvas.height = H * DPR; if (!cam.ready) { cam.x = W / 2; cam.y = H / 2; cam.ready = true; } }
  window.addEventListener("resize", resize);
  let drag = null;
  canvas.addEventListener("mousemove", (e) => { if (drag) { cam.x = drag.cx + (e.clientX - drag.sx); cam.y = drag.cy + (e.clientY - drag.sy); drag.moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4; if (drag.moved) cam.user = true; return; } hover = pick(e.clientX, e.clientY); canvas.classList.toggle("hover", !!hover); });
  canvas.addEventListener("mousedown", (e) => { drag = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  window.addEventListener("mouseup", (e) => { if (drag && !drag.moved) { const n = pick(e.clientX, e.clientY); if (n) { sel = n; renderDetail(); $("hint").style.opacity = 0; } else closeDetail(); } drag = null; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); cam.user = true; const f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.max(0.3, Math.min(3, cam.scale * f)), w = toWorld(e.clientX, e.clientY); cam.scale = ns; cam.x = e.clientX - w.x * ns; cam.y = e.clientY - w.y * ns; }, { passive: false });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
  $("modes").onclick = (e) => { const c = e.target.closest(".chip"); if (!c) return; const m = c.dataset.mode; filter[m] = !filter[m]; c.classList.toggle("on", filter[m]); };
  $("pause").onclick = () => { filter.paused = !filter.paused; $("pause").classList.toggle("on", filter.paused); $("pause").textContent = filter.paused ? "▶ resume" : "⏸ pause"; };
  $("legendToggle").onclick = () => $("legend").classList.toggle("collapsed");
  function setConn(live) { const el = $("conn"); el.classList.toggle("down", !live); el.querySelector(".t").textContent = live ? "live" : "disconnected"; }

  // ── boot ──
  async function load() {
    const [meta, roster, chans, membership, activity, dmHist] = await Promise.all([
      fetch("/api/meta").then((r) => r.json()), fetch("/api/roster").then((r) => r.json()), fetch("/api/channels").then((r) => r.json()),
      fetch("/api/membership").then((r) => r.json()).catch(() => ({ members: [] })),
      fetch("/api/activity?limit=400").then((r) => r.json()).catch(() => []), fetch("/api/dms?limit=400").then((r) => r.json()).catch(() => []),
    ]);
    $("space").textContent = "· " + meta.space;
    for (const c of chans) { const h = ensureHub(c.channel); h.msgs = c.messages || 0; h.desc = c.description || ""; }
    updateRoster(roster);
    applyMembership(membership); // authoritative spokes BEFORE traffic seeding (no skeleton flicker)
    for (const e of activity) { const m = e.msg; const a = m?.from?.id && agents.get(m.from.id); if (e.mode === "chat" && m?.channel && a) chatHit(a, m.channel, m.ts || now()); }
    for (const m of dmHist) { const a = m.from?.id && agents.get(m.from.id), b = typeof m.to === "string" && agents.get(m.to); if (a && b && a !== b) dmHit(a, b, m.ts || now()); }
    // Seed the `recent` buffer from the activity backfill so the channel detail's "recently active" tags +
    // the "recent" section aren't empty until the first live SSE message arrives (norman).
    for (const e of activity.slice(-80)) {
      const m = e.msg; if (!m) continue;
      const to = e.mode === "unicast" ? (typeof m.to === "string" ? (agents.get(m.to)?.name || shortId(m.to)) : m.to?.name) : e.mode === "anycast" ? "@" + (m.toService || "") : null;
      recent.push({ mode: e.mode, from: m.from?.name, fromId: m.from?.id, to, chan: m.channel, text: partsText(m), ts: m.ts || now() });
    }
    recent.sort((a, b) => a.ts - b.ts);
    if (recent.length > 80) recent.splice(0, recent.length - 80);
    alpha = 1; for (let i = 0; i < 200; i++) physics(); // pre-warm to a settled layout
    const f = fitTarget(); cam.x = f.x; cam.y = f.y; cam.scale = f.scale;
  }
  function connect() { const es = new EventSource("/feed"); es.onopen = () => setConn(true); es.onerror = () => setConn(false); es.addEventListener("roster", (e) => updateRoster(JSON.parse(e.data))); es.addEventListener("membership", (e) => applyMembership(JSON.parse(e.data))); es.addEventListener("message", (e) => onMessage(JSON.parse(e.data))); }

  resize();
  setInterval(setFeed, 5000); // age "live" → "stale" even without new events
  load().then(connect).catch((err) => { console.error(err); setConn(false); });
  requestAnimationFrame(frame);
})();
