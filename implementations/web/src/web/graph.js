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
  // Harness branding from harness.js (one source with the monitor). Canvas uses .glyph; DOM uses .svg.
  const HARNESS = window.COTAL_HARNESS || {};
  const harnessLabel = (k) => (HARNESS[k] ? HARNESS[k].label : k);
  const harnessColor = (k) => (HARNESS[k] ? HARNESS[k].color : "#8b949e");
  const harnessGlyph = (k) => (HARNESS[k] ? HARNESS[k].glyph : "·");
  // Attention: open/absent are identical (receives all) — only dnd/focus surface.
  const attMark = (a) => (a === "dnd" ? "◼" : a === "focus" ? "◉" : "");
  /** Fit `provider/model · variant` into maxChars. Prefer dropping the provider prefix over the
   *  variant — "gpt-5.6-sol · xhigh" carries more per pixel than "openai/gpt-5.6-sol ·…". */
  function fitModelLabel(model, variant, maxChars) {
    let core = String(model);
    const withVar = (m) => (variant ? `${m} · ${variant}` : m);
    let s = withVar(core);
    if (s.length <= maxChars) return s;
    if (core.includes("/")) {
      core = core.slice(core.lastIndexOf("/") + 1);
      s = withVar(core);
      if (s.length <= maxChars) return s;
    }
    if (variant) {
      const suf = ` · ${variant}`;
      const room = maxChars - suf.length;
      if (room >= 4) return `${core.slice(0, room - 1)}…${suf}`;
      return String(variant).length <= maxChars ? String(variant) : `${String(variant).slice(0, maxChars - 1)}…`;
    }
    return core.length <= maxChars ? core : `${core.slice(0, maxChars - 1)}…`;
  }

  // ── state ──
  const hubs = new Map(); // channel -> hub node
  const agents = new Map(); // id -> agent node
  const edges = new Map(); // `${agentId}|${chan}` -> { a, chan, last, heat, mem, durableOnly }
  const dms = new Map(); // `${idA}|${idB}` (sorted) -> { a, b, last, heat }
  const particles = [];
  const blooms = [];
  const recent = [];
  // `available` is "there is a feed and it said something"; `unreadable` is "the last attempt to read
  // it failed". They are independent, and `unreadable` is declared here rather than sprung into
  // existence on first failure so the shape of the state is readable in one place.
  const feed = { asOf: undefined, available: false, unreadable: false }; // membership-feed freshness
  const cam = { x: 0, y: 0, scale: 1, ready: false, user: false };
  const filter = { chat: true, unicast: true, anycast: true, window: 30, paused: false, hideOffline: true, hideEmpty: true };
  let W = 0, H = 0, DPR = 1, hover = null, sel = null, lastT = 0, alpha = 1;

  // ── utils ──
  // Shared with app.js via parts.js (loaded before this file). It names a part kind it cannot
  // draw instead of rendering it as the empty string, which read as "nothing arrived".
  const partsText = (m) => window.COTAL_PARTS.partsToText(m.parts);
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
    if (!a) { a = Object.assign({ kind: "agent", id, name: (typeof ref === "object" && ref.name) || shortId(id), role: typeof ref === "object" ? ref.role : undefined, status: "idle", present: false, activity: "", harness: undefined, model: undefined, variant: undefined, attention: undefined, ts: 0, live: [], durable: [], memberOf: new Map(), r: 6.5, charge: -190, mass: 1, phase: (hash(id) % 1000) / 1000 * 6.283 }, spawn(id, 70)); agents.set(id, a); reheat(); }
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
    // while hiding, ghosts leave the sim entirely so the visible graph isn't laid out around invisible nodes (reheat on toggle re-settles)
    const ns = [...hubs.values(), ...agents.values()].filter((n) => !isHidden(n));
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
    for (const e of edges.values()) { const h = hubs.get(e.chan); if (h && !isHidden(h) && !isHiddenMember(e)) link(e.a, h, 105, 0.08); }
    for (const d of dms.values()) if (!isHidden(d.a) && !isHidden(d.b)) link(d.a, d.b, 165, 0.03);
    // small graphs: faint tangential nudge so agents form a loose ring around their hub instead of a line (decays with alpha)
    if (hubs.size <= 2) for (const a of agents.values()) { if (isHidden(a)) continue; const h = (primaryChan(a) && hubs.get(primaryChan(a))) || [...hubs.values()][0]; if (h) { const dx = a.x - h.x, dy = a.y - h.y, d = Math.hypot(dx, dy) || 1; a.vx += (-dy / d) * 0.4 * alpha; a.vy += (dx / d) * 0.4 * alpha; } }
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

  // ── traffic (visuals are decoration; graph STATE is not) ──
  // Particle/bloom arrays are bounded. A backgrounded tab stops rAF, so an unbounded queue + the
  // chat onArrive fan-out (one comet per other member) detonates into thousands of particles on
  // return — measured peak 8042 from 120 backlogged chats. Gate enqueue on visibility; hard-cap
  // both arrays (drop oldest; dropped onArrive is skipped — heat already applied on the state path).
  const PARTICLE_CAP = 240;
  const BLOOM_CAP = 80;
  const tabVisible = () => document.visibilityState === "visible";
  const mk = (a, b, color, onArrive, curve) => ({ a, b, t: 0, dur: curve ? 1.4 : 1.1, color, onArrive: onArrive || null, curve: !!curve, trail: [] });
  function pushParticle(p) {
    if (!tabVisible()) return false;
    particles.push(p);
    while (particles.length > PARTICLE_CAP) particles.shift(); // drop oldest; skip its onArrive
    return true;
  }
  function pushBloom(b) {
    if (!tabVisible()) return false;
    blooms.push(b);
    while (blooms.length > BLOOM_CAP) blooms.shift();
    return true;
  }
  /** Apply fan-out spoke heat without enqueueing comets (used when visuals are gated off). */
  function heatFanOut(channel, from) {
    for (const e of edges.values()) if (e.chan === channel && e.a !== from) e.heat = 1;
  }
  function onMessage({ mode, senderId, channel, msg }) {
    if (!msg) return;
    // Trust decided once (see app.js): the subject-derived channel replaces the payload claim,
    // UNCONDITIONALLY. A guarded overwrite fails open on `inst`/`svc`, where there is no
    // authoritative channel and the publisher's forged one would survive.
    msg.channel = channel;
    const from = ensureAgent(senderId ? { id: senderId, name: msg.from?.name, role: msg.from?.role } : msg.from);
    if (from) { from.ts = now(); from.present = true; } // a live sender is a live presence (roster event may lag)
    // Visual gate: pause chip, mode filter, AND tab visibility. State (heat/recent/roster) always applies.
    const animate = !filter.paused && filter[mode] && tabVisible();
    let toName = null;
    if (mode === "chat" && msg.channel) {
      const h = ensureHub(msg.channel);
      if (from) chatHit(from, msg.channel, now()).heat = 1;
      // inbound: sender → hub, then the hub flashes and fans the post back out to every other member on
      // the channel (their spokes glow as the wave reaches them) — a real broadcast.
      if (animate && from && h) {
        pushParticle(mk(from, h, MODE.chat, () => {
          pushBloom({ x: h.x, y: h.y, t: 0, dur: 0.95, color: MODE.chat, r0: h.r });
          for (const e of edges.values()) if (e.chan === msg.channel && e.a !== from) {
            e.heat = 1;
            pushParticle(mk(h, e.a, MODE.chat, null, false));
          }
        }));
      } else if (from && h) {
        // No comet: still heat every member spoke so the skeleton reflects the broadcast on return.
        heatFanOut(msg.channel, from);
      }
    } else if (mode === "unicast") {
      const to = typeof msg.to === "string" ? agents.get(msg.to) : msg.to && agents.get(msg.to.id);
      toName = to?.name || (typeof msg.to === "string" ? shortId(msg.to) : msg.to?.name);
      if (from && to && from !== to) {
        dmHit(from, to, now()).heat = 1;
        if (animate) pushParticle(mk(from, to, MODE.unicast, null, true));
      }
    } else if (mode === "anycast") {
      toName = "@" + (msg.toService || "");
      if (animate && from) pushBloom({ x: from.x, y: from.y, t: 0, dur: 1.0, color: MODE.anycast, r0: from.r });
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
      a.status = p.status; a.activity = p.activity || ""; a.role = p.card.role;
      a.harness = p.card.meta?.connector; a.model = p.card.meta?.model; a.variant = p.card.meta?.variant;
      a.attention = p.attention; // open/absent both mean receives-all; only dnd/focus render
      // Card legibility fields the detail panel renders (same source as the Monitor's Agent Detail).
      a.description = p.card.description; a.tags = p.card.tags; a.channelModes = p.channelModes;
      a.ts = p.ts;
      a.present = true; // in the roster = a live presence (the authority for isOffline)
      seen.add(a.id);
    }
    // Drop an agent as soon as it goes offline OR leaves the roster (main's ghost fix, c9e9000) — EXCEPT
    // keep it if it's still a feed member: a durable member whose presence is offline must persist to
    // render as "member, currently offline" (the feed's durable arm survives offline). Membership is
    // broker-truth, applied separately; presence no longer carries channels.
    for (const [id, a] of agents) { if (!seen.has(id)) a.present = false; if ((!seen.has(id) || a.status === "offline") && !(a.wideReader || (a.memberOf && a.memberOf.size))) { agents.delete(id); for (const k of [...edges.keys()]) if (edges.get(k).a === a) edges.delete(k); for (const k of [...dms.keys()]) { const d = dms.get(k); if (d.a === a || d.b === a) dms.delete(k); } reheat(); if (sel === a) closeDetail(); } }
  }

  // ── membership (authoritative spokes) ──
  // The server said it could not read membership. Kept separate from `available` rather than folded
  // into it: they are different facts and the pill has to say which one.
  function membershipUnreadable() { feed.unreadable = true; setFeed(); }

  // ── THE BOOTSTRAP MUST NOT OUTRANK THE LIVE FEED ────────────────────────────────────────────
  //
  // Every bootstrap read is ISSUED before its value is applied: `refreshAll` starts all six, awaits
  // all six, and only then applies each. So a snapshot is always at least as old as the moment the
  // page asked for it, while an SSE event is by definition newer than that moment. Now that the feed
  // opens FIRST, a live `roster` or `membership` can land while those reads are still in flight, and
  // applying the older snapshot afterwards silently reverts it: `updateRoster` on an empty list marks
  // every unseen agent `present = false` and deletes it outright unless it is still a feed member,
  // and `applyMembership` on an empty set clears `memberOf`. The agent the feed just announced
  // vanishes from the graph.
  //
  // Both channels carry a FULL snapshot through the SAME apply function, so a live event does not
  // need merging with the older read, it REPLACES it. Once the feed has spoken for a source, that
  // source's bootstrap value is stale on arrival and is dropped rather than applied.
  //
  // WHAT IS SUPERSEDED IS THE SOURCE, NOT THE SNAPSHOT. `membership` speaks in two sentences, a
  // snapshot and a REFUSAL, and each side can say either one. Writing the rule only onto the apply
  // wrappers covered the snapshots and left both refusals loose, in opposite directions: a live
  // refusal erased by an older successful read, and a successful live snapshot overruled by a
  // bootstrap read that refused after it. Both end in the header pill making a claim about the mesh
  // that is really a claim about one read, which is the one thing this pill exists not to do.
  const liveApplied = new Set();
  const supersededByFeed = (name, apply) => (value) => { if (!liveApplied.has(name)) apply(value); };

  function applyMembership(snap) {
    if (!snap) return;
    feed.unreadable = false; // a snapshot arrived, whatever it contains
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
    recomputeHubEmpty(); // these mutations change hub visibility — refresh before the detail/selection check below
    if (sel) { if (isHidden(sel)) closeDetail(); else renderDetail(); }
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
    recomputeHubEmpty(); // no VISIBLE members = dormant (hidden offline ghosts don't keep it lit); drives hub hide + dim
    if (sel && isHidden(sel)) closeDetail(); // a selection hidden by a membership/roster change (not just the toggle) closes its card
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
  // Core offline-ness of an AGENT (toggle-INDEPENDENT): it is NOT a live presence — either presence reports it
  // explicitly `offline`, or it is absent from the presence roster entirely (`present === false`). Presence is
  // the authority here, NOT the membership feed. This is what fixes the "ghost flashes back for ~1s" report: a
  // ghost that left EARLIER (its roster-absence already observed, `present === false`) stays hidden when a later
  // snapshot empties its memberOf — there is no per-node `memberOf.size` heuristic to flip it back to VISIBLE on
  // a membership change. (Membership and roster are independent SSE events; this covers the reported case, where
  // a peer's channel join drops a long-departed ghost. A near-simultaneous disconnect whose membership-drop is
  // processed before its roster-absence can still show the node for one roster interval — presence stays the
  // authority and it self-resolves on the next roster event; review-ux/critic R2.) It also does NOT false-hide a
  // genuinely-connected agent that just sits in no channel (e.g.
  // `manager`/DM-only: roster-present, but absent from the channel feed, so its `live` is an empty DEFAULT, not
  // proof of disconnection — review-freelance R2). `present` is set from the roster in updateRoster; a live
  // message sender is marked present too.
  const isOffline = (n) => n.kind === "agent" && (n.status === "offline" || !n.present);
  // A membership edge that is offline FOR ITS channel: durable-only here, or the agent itself is offline.
  const isOfflineMember = (e) => e.durableOnly || isOffline(e.a);
  // Render/sim visibility. `hide offline` (on by default) collapses offline AGENTS. `hide empty` (on by
  // default) collapses a HUB with no VISIBLE member under the current filters — it reads the cached `h.empty`
  // (kept current by recomputeHubEmpty). So when `hide offline` is ON this
  // means "no ONLINE member"; when it's OFF a channel that still shows offline members keeps its hub — the two
  // toggles don't fight (review-critic R2). Gated on the feed being AUTHORITATIVE: without the
  // authoritative feed there are no membership edges, so every hub would read empty — we can't tell a
  // quiet channel from an unknown one, so we don't hide. Reading the cached flag keeps isHidden(hub)
  // O(1), not an all-edges scan per call.
  // Hiding suppresses node/spoke rendering, hit-testing, camera framing, and physics participation; the node
  // stays in the model, so toggling reveals it instantly.
  //
  // `feedAuthoritative()` rather than `feed.available` alone. Those came apart the moment the feed
  // could report that it could not be READ: the last snapshot is still the last thing we KNEW, but it
  // is no longer what IS, and `hide empty` asserts a hub has no member NOW. That is the gate's own
  // stated reason applied to the case where we hold stale edges rather than none — otherwise the pill
  // says "unreadable" while the page keeps acting on the reading it just disowned.
  //
  // The snapshot itself is deliberately NOT discarded: `asOf` and the spokes remain the honest record
  // of the last successful read, which is true and worth showing. What stops is treating it as current.
  const feedAuthoritative = () => feed.available && !feed.unreadable;
  const isHidden = (n) => n.kind === "hub"
    ? filter.hideEmpty && feedAuthoritative() && n.empty
    : filter.hideOffline && isOffline(n);
  // Per-CHANNEL visibility of a membership spoke: hidden when `hide offline` is on AND this edge is offline
  // for its channel (durable-only, or the agent is offline) — so "hide offline" holds per channel, not just
  // per node (an agent live elsewhere keeps its node, but its dashed offline spokes + roster seats drop).
  const isHiddenMember = (e) => filter.hideOffline && isOfflineMember(e);
  // Recompute every hub's `empty` (no VISIBLE member under the current filters) in ONE O(hubs+edges) pass.
  // isHidden(hub) reads this cached flag, so call this synchronously anywhere a hub's visibility is consulted
  // outside the render loop — toggle cleanup + after applyMembership — so detail/selection logic never reads a
  // stale flag (review-critic/freelance/ux R2). The frame loop calls it too, for roster/traffic-driven changes.
  function recomputeHubEmpty() {
    for (const h of hubs.values()) h.empty = true;
    for (const e of edges.values()) if (e.mem && !isHiddenMember(e)) { const h = hubs.get(e.chan); if (h) h.empty = false; }
  }

  function drawSpokes() {
    ctx.lineCap = "round";
    const f = fanFocus();
    // structure layer: a constant-faint spoke per membership (solid = live, dashed-dim = member-offline)
    for (const e of edges.values()) {
      if (!e.mem || isHiddenMember(e)) continue;
      const h = hubs.get(e.chan); if (!h || isHidden(h)) continue;
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
    for (const e of edges.values()) { const h = hubs.get(e.chan); if (!filter.chat || !h || isHidden(h) || e.heat <= 0.02 || isHiddenMember(e)) continue; const lit = inFan(e, f); ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(h.x, h.y); ctx.strokeStyle = rgba(MODE.chat, Math.min(0.55, e.heat * 0.55) * (lit ? 1 : 0.35)); ctx.lineWidth = 1 + e.heat * 1.6; ctx.stroke(); }
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
  }
  // Perpendicular control point for a DM arc, computed in a direction-INDEPENDENT canonical order (by id)
  // so the traveling comet rides the exact same dashed curve no matter which peer sent this message — a
  // reply in the opposite direction otherwise flips the bulge to the wrong side and the comet peels off.
  function dmControl(a, b) {
    const [p, q] = a.id < b.id ? [a, b] : [b, a];
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, nx = -(q.y - p.y), ny = q.x - p.x, len = Math.hypot(nx, ny) || 1;
    return { x: mx + (nx / len) * 24, y: my + (ny / len) * 24 };
  }
  function drawDmEdges() {
    if (!filter.unicast) return; // the `direct` chip filters DM traffic — including the persistent DM curves
    ctx.setLineDash([3, 4]);
    for (const d of dms.values()) {
      if (isHidden(d.a) || isHidden(d.b)) continue;
      const c = dmControl(d.a, d.b);
      ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.quadraticCurveTo(c.x, c.y, d.b.x, d.b.y);
      ctx.strokeStyle = rgba(MODE.unicast, 0.5 + d.heat * 0.45); ctx.lineWidth = 1.7 + d.heat * 1.6; ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  function drawNodes() {
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const t = performance.now() / 1000;
    for (const h of hubs.values()) {
      if (isHidden(h)) continue;
      const focus = h === hover || h === sel, dim = h.empty ? 0.55 : 1; // dormant hubs read quieter, not gone
      ctx.save(); ctx.shadowColor = MODE.chat; ctx.shadowBlur = (focus ? 28 : 16) * dim;
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.r); g.addColorStop(0, h.empty ? "#16314f" : "#2b5a8f"); g.addColorStop(1, "#0c1726");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
      ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(MODE.chat, 0.95 * dim); ctx.stroke();
      ctx.fillStyle = rgba("#cfe2ff", dim); ctx.font = "600 12.5px var(--font), sans-serif"; ctx.fillText("#" + h.name, h.x, h.y + h.r + 13);
    }
    for (const a of agents.values()) {
      if (isHidden(a)) continue;
      const col = STAT[a.status] || STAT.idle, focus = a === hover || a === sel, off = a.status === "offline", idle = a.status === "idle";
      const r = a.r + Math.sin(t * 0.8 + a.phase) * 0.4;
      if (a.status === "waiting") { const pulse = 0.5 + 0.5 * Math.sin(t * 1.7); for (const o of [0, 0.5]) { ctx.beginPath(); ctx.arc(a.x, a.y, r + 5 + ((pulse + o) % 1) * 9, 0, 2 * Math.PI); ctx.strokeStyle = rgba(STAT.waiting, (1 - ((pulse + o) % 1)) * 0.45); ctx.lineWidth = 1.6; ctx.stroke(); } }
      // wide reader (subscribes `>`/`*`): a faint dashed halo — "reads all channels" without a spoke per hub
      if (a.wideReader) { ctx.save(); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(a.x, a.y, r + 4.5, 0, 2 * Math.PI); ctx.strokeStyle = rgba(MEM_LIVE, off ? 0.3 : 0.6); ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore(); }
      // Shape channel (never colour alone): offline = hollow ring; idle = filled disc; working/waiting = filled + glow.
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = focus ? 20 : off ? 0 : idle ? 6 : 13;
      if (off) {
        ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = "#141b26"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = rgba(col, 0.85); ctx.setLineDash([2.5, 2]); ctx.stroke(); ctx.setLineDash([]);
      } else {
        const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, r); g.addColorStop(0, rgba(col, 1)); g.addColorStop(0.55, rgba(col, 0.55)); g.addColorStop(1, "#141b26");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, 2 * Math.PI); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = rgba(col, 1); ctx.stroke();
      }
      ctx.restore();
      // Attention mark (dnd/focus only) — glyph at node rim, sized for rest-scale legibility.
      const am = attMark(a.attention);
      if (am && !off) {
        ctx.fillStyle = a.attention === "dnd" ? "#db6d28" : MODE.chat;
        ctx.font = "700 11px var(--font), sans-serif";
        ctx.fillText(am, a.x + r + 2, a.y - r - 1);
      }
      // Labels track SCREEN SPACE, not global node count. A count gate hid every name on a real
      // 19-agent mesh (David's "don't hide model names") and zoom never helped. Rule:
      //   • viewport cull — off-screen nodes cost nothing
      //   • name when the node's on-screen footprint can hold text (or focus/waiting)
      //   • model/harness when zoomed further (or focus) — density follows cam.scale
      const sx = cam.x + a.x * cam.scale, sy = cam.y + a.y * cam.scale;
      const inView = sx >= -40 && sx <= W + 40 && sy >= -40 && sy <= H + 40;
      const foot = 2 * r * cam.scale; // on-screen diameter in CSS px
      const showName = focus || a.status === "waiting" || (inView && foot >= 8);
      const showModel = focus || (inView && foot >= 16);
      if (showName) {
        ctx.fillStyle = focus ? "#ffffff" : "#cdd6e2";
        ctx.font = (focus ? "600 " : "500 ") + "11px var(--font), sans-serif";
        ctx.fillText(a.name, a.x, a.y - r - 8);
      }
      if (showModel) {
        // Budget scales with on-screen footprint (same axis as the label gate). Never eat the
        // variant to save chars — if we must shorten, drop the provider prefix first
        // ("openai/gpt-5.6-sol · xhigh" → "gpt-5.6-sol · xhigh"), then trim the model id.
        const maxChars = focus ? 56 : Math.max(20, Math.min(56, Math.round(foot * 2.2)));
        let sub = "";
        if (a.model) sub = fitModelLabel(a.model, a.variant, maxChars);
        else if (a.harness) sub = harnessLabel(a.harness);
        if (sub) {
          ctx.fillStyle = focus ? "#b6c2d1" : "#8b949e";
          ctx.font = "500 9.5px var(--font), sans-serif";
          ctx.fillText(sub, a.x, a.y - r - (showName ? 19 : 8));
        }
      }
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
      const p = particles[i]; if (!filter.paused) p.t += dt / p.dur;
      // a fan-out comet to a hidden offline member would fly to empty space — still tick + retire it, just don't draw
      if (isHidden(p.a) || isHidden(p.b)) { if (p.t >= 1) { if (p.onArrive) p.onArrive(); particles.splice(i, 1); } continue; }
      const t = ease(Math.min(1, p.t)); let x, y;
      if (p.curve) { const c = dmControl(p.a, p.b), u = 1 - t; x = u * u * p.a.x + 2 * u * t * c.x + t * t * p.b.x; y = u * u * p.a.y + 2 * u * t * c.y + t * t * p.b.y; }
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
    const content = ns.filter((n) => !(n.kind === "hub" && n.empty) && !isHidden(n)), frame = content.length ? content : ns;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const n of frame) { const r = n.r + 40; a = Math.min(a, n.x - r); c = Math.max(c, n.x + r); b = Math.min(b, n.y - r); d = Math.max(d, n.y + r); }
    for (const h of hubs.values()) if (h.empty && !isHidden(h)) { a = Math.min(a, h.x - 20); c = Math.max(c, h.x + 20); b = Math.min(b, h.y - 20); d = Math.max(d, h.y + 20); }
    const bw = c - a || 1, bh = d - b || 1, pad = 90, maxScale = ns.length <= 6 ? 2.4 : 1.6;
    const scale = Math.max(0.35, Math.min(maxScale, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
    return { x: W / 2 - ((a + c) / 2) * scale, y: H / 2 - ((b + d) / 2) * scale, scale };
  }
  const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale });
  function pick(sx, sy) { const w = toWorld(sx, sy); let best = null, bd = 1e9; for (const n of [...hubs.values(), ...agents.values()]) { if (isHidden(n)) continue; const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < n.r + 8 && d < bd) { bd = d; best = n; } } return best; }

  // ── membership freshness pill ──
  function setFeed() {
    const el = $("feed"); if (!el) return;
    el.hidden = false;
    let cls, text;
    // UNREADABLE IS ITS OWN STATE, and it must be checked before `available`. "traffic-only" is a
    // CLAIM ABOUT THE MESH — that no membership feed is being published — and it was being shown for
    // a failed read, which is a claim about US. The operator's own viewer reported traffic-only
    // against a mesh that had a feed, and nothing on the page could have revealed the difference.
    if (feed.unreadable) { cls = "off"; text = "membership: unreadable"; }
    else if (!feed.available) { cls = "off"; text = "membership: traffic-only"; }
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
      const memEdges = [...edges.values()].filter((e) => e.chan === sel.name && e.mem);
      // hide per MEMBERSHIP edge: an agent live elsewhere but durable-only here is offline FOR THIS channel
      const mem = memEdges.filter((e) => !isHiddenMember(e)).map((e) => e.a).sort((x, y) => x.name.localeCompare(y.name));
      const hiddenOff = memEdges.length - mem.length;
      const activeIds = new Set(recent.filter((m) => m.chan === sel.name && m.fromId).map((m) => m.fromId));
      const memberRow = (a) => { const off = a.status === "offline" || (a.memberOf && a.memberOf.get(sel.name) === "durable"); const dotCol = STAT[a.status] || STAT.idle; return `<span class="mtag"><span class="dot" style="background:${off ? MEM_OFF : dotCol}"></span>${esc(a.name)}${activeIds.has(a.id) ? '<span class="act">active</span>' : ""}${off ? '<span class="off">offline</span>' : ""}</span>`; };
      const memberList = mem.length ? `<div class="d-tags">${mem.map(memberRow).join("")}</div>` : `<div class="d-block muted">${hiddenOff ? `${hiddenOff} member${hiddenOff === 1 ? "" : "s"} offline (hidden)` : "no subscribers yet"}</div>`;
      // Effective channel policy (from /api/channels, server-resolved). Delivery class = durability;
      // replay = whether a join backfills. Omit a row the feed didn't carry (never guess a default).
      const deliveryRow = sel.deliveryClass
        ? `<div class="d-row"><span class="k">delivery</span><span class="v">${esc(sel.deliveryClass)} · ${sel.deliveryClass === "durable" ? "at-least-once for members" : "at-most-once"}</span></div>`
        : "";
      const replayRow = sel.replay === true
        ? `<div class="d-row"><span class="k">replay</span><span class="v">${sel.replayWindow ? "on · " + esc(sel.replayWindow) : "on"}</span></div>`
        : sel.replay === false
          ? `<div class="d-row"><span class="k">replay</span><span class="v muted">off</span></div>`
          : "";
      el.innerHTML = `<span class="x" id="dx">✕</span>
        <div class="d-kind">channel</div>
        <div class="d-who">#${esc(sel.name)}</div>
        ${sel.desc ? `<div class="d-block">${esc(sel.desc)}</div>` : ""}
        <div class="d-rows">
          <div class="d-row"><span class="k">subscribers</span><span class="v">${hiddenOff ? `${mem.length} shown <span style="color:var(--faint)">+${hiddenOff} offline hidden</span>` : `${mem.length} agent${mem.length === 1 ? "" : "s"}`}</span></div>
          <div class="d-row"><span class="k">messages</span><span class="v">${sel.msgs || 0}</span></div>
          ${deliveryRow}
          ${replayRow}
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
      // Identity rows: branded harness (not raw key); model · variant when known; "not reported" only for harness agents.
      const hLabel = sel.harness ? harnessLabel(sel.harness) : "";
      const hColor = sel.harness ? harnessColor(sel.harness) : "";
      const harnessRow = sel.harness
        ? `<div class="d-row"><span class="k">harness</span><span class="v"><span class="hmark" style="color:${hColor}">${esc(harnessGlyph(sel.harness))}</span> ${esc(hLabel)}</span></div>`
        : "";
      const modelRow = sel.harness
        ? `<div class="d-row"><span class="k">model</span><span class="v${sel.model ? "" : " muted"}">${sel.model ? esc(sel.model) + (sel.variant ? ` · ${esc(sel.variant)}` : "") : "not reported"}</span></div>`
        : sel.model
          ? `<div class="d-row"><span class="k">model</span><span class="v">${esc(sel.model)}${sel.variant ? ` · ${esc(sel.variant)}` : ""}</span></div>`
          : "";
      const att = attMark(sel.attention);
      const attRow = att
        ? `<div class="d-row"><span class="k">attention</span><span class="v att-${esc(sel.attention)}">${att} ${esc(sel.attention)}</span></div>`
        : "";
      // The card's own description (AgentCard.description) — the same legibility text the Monitor shows.
      const descBlock = sel.description ? `<div class="d-block">${esc(sel.description)}</div>` : "";
      const tagsSection = (sel.tags || []).length
        ? `<div class="d-section"><div class="d-label">tags</div><div class="d-tags">${sel.tags.map((t) => `<span class="ctag">${esc(t)}</span>`).join("")}</div></div>`
        : "";
      // Per-channel attention overrides (quiet / muted) — advisory receive-side, not ACL.
      const modeEntries = Object.entries(sel.channelModes || {}).sort(([a], [b]) => a.localeCompare(b));
      const modesSection = modeEntries.length
        ? `<div class="d-section"><div class="d-label">channel modes</div><div class="d-tags">${modeEntries.map(([ch, m]) => `<span class="ctag${m === "muted" ? " off" : ""}">#${esc(ch)} · ${esc(m)}</span>`).join("")}</div></div>`
        : "";
      el.innerHTML = `<span class="x" id="dx">✕</span>
        <div class="d-kind">agent</div>
        <div class="d-who">${esc(sel.name)}${sel.role ? `<span class="role">${esc(sel.role)}</span>` : ""}</div>
        <div class="d-status ${sel.status}"><span class="dot"></span>${esc(sel.status)}</div>
        ${descBlock}
        <div class="d-section"><div class="d-label">activity</div><div class="d-block ${sel.activity ? "" : "muted"}">${esc(sel.activity || "no current activity")}</div></div>
        ${(harnessRow || modelRow || attRow) ? `<div class="d-rows">${harnessRow}${modelRow}${attRow}</div>` : ""}
        <div class="d-section"><div class="d-label">subscribes</div>${subs}</div>
        ${modesSection}
        ${tagsSection}
        <div class="d-section"><div class="d-label">recent</div><div class="d-msgs">${recentRows((m) => m.from === sel.name || m.to === sel.name)}</div></div>`;
    }
    el.classList.add("open"); $("dx").onclick = closeDetail;
  }

  // ── events ──
  // A <canvas> is a REPLACED element: `inset:0` does NOT stretch it the way it stretches a block. Without
  // an explicit CSS size it renders at its intrinsic (= backing) size — W*DPR × H*DPR — so on a retina Mac
  // (DPR 2) it overflows the viewport at 2× and pointer coords no longer map to the drawing's coordinate
  // space (zoom/hover/click anchor low-and-right of the cursor). Pin the CSS size to the viewport so backing
  // stays crisp at DPR while clientX/clientY line up 1:1 with the world transform.
  function resize() { DPR = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight; canvas.width = W * DPR; canvas.height = H * DPR; canvas.style.width = W + "px"; canvas.style.height = H + "px"; if (!cam.ready) { cam.x = W / 2; cam.y = H / 2; cam.ready = true; } }
  window.addEventListener("resize", resize);
  let drag = null;
  canvas.addEventListener("mousemove", (e) => { if (drag) { cam.x = drag.cx + (e.clientX - drag.sx); cam.y = drag.cy + (e.clientY - drag.sy); drag.moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4; if (drag.moved) cam.user = true; return; } hover = pick(e.clientX, e.clientY); canvas.classList.toggle("hover", !!hover); });
  canvas.addEventListener("mousedown", (e) => { drag = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  window.addEventListener("mouseup", (e) => { if (drag && !drag.moved) { const n = pick(e.clientX, e.clientY); if (n) { sel = n; renderDetail(); $("hint").style.opacity = 0; } else closeDetail(); } drag = null; });
  // Zoom-to-cursor. The factor is PROPORTIONAL to the wheel delta (exp), not a fixed step per event: a
  // trackpad fires a burst of tiny wheel events per gesture, and a fixed 1.1×-each slammed the scale
  // straight to the clamp — flinging the graph off-screen around the (correctly anchored) cursor. deltaMode
  // is normalized to px so a mouse notch and a trackpad swipe both feel right.
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); cam.user = true; const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1), f = Math.exp(-px * 0.0015), ns = Math.max(0.3, Math.min(3, cam.scale * f)), w = toWorld(e.clientX, e.clientY); cam.scale = ns; cam.x = e.clientX - w.x * ns; cam.y = e.clientY - w.y * ns; }, { passive: false });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
  // Backgrounded tab: drop in-flight decoration (rAF is frozen, so mid-flight comets would otherwise
  // detonate their onArrive fan-out on return). State (edges/roster/recent) is untouched. On return:
  // reset lastT so the first frame doesn't integrate a multi-minute dt, and reheat physics so a node
  // set that changed while hidden can re-settle instead of sitting cold.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      particles.length = 0;
      blooms.length = 0;
    } else {
      lastT = performance.now();
      reheat();
    }
  });
  $("modes").onclick = (e) => { const c = e.target.closest(".chip"); if (!c) return; const m = c.dataset.mode; filter[m] = !filter[m]; c.classList.toggle("on", filter[m]); };
  $("pause").onclick = () => { filter.paused = !filter.paused; $("pause").classList.toggle("on", filter.paused); $("pause").textContent = filter.paused ? "▶ resume" : "⏸ pause"; };
  $("hideOffline").onclick = () => { filter.hideOffline = !filter.hideOffline; $("hideOffline").classList.toggle("on", filter.hideOffline); recomputeHubEmpty(); if (sel && isHidden(sel)) closeDetail(); if (hover && isHidden(hover)) hover = null; reheat(); if (sel) renderDetail(); };
  $("hideEmpty").onclick = () => { filter.hideEmpty = !filter.hideEmpty; $("hideEmpty").classList.toggle("on", filter.hideEmpty); recomputeHubEmpty(); if (sel && isHidden(sel)) closeDetail(); if (hover && isHidden(hover)) hover = null; reheat(); if (sel) renderDetail(); };
  $("legendToggle").onclick = () => $("legend").classList.toggle("collapsed");
  function setConn(live) { const el = $("conn"); el.classList.toggle("down", !live); el.querySelector(".t").textContent = live ? "live" : "disconnected"; }

  /** Say which sources are showing their last good value. Visible, not a console line. */
  function setStale(stale) {
    const el = $("stale");
    if (!el) return;
    const label = window.COTAL_SNAPSHOT.staleLabel(stale);
    el.hidden = !label;
    if (!label) return;
    el.querySelector(".t").textContent = label;
    el.title = stale.map((s) => `${s.name}: ${s.reason}`).join("\n");
  }

  // ── boot ──
  async function load() {
    // ── ONE REFUSED READ MUST NOT EMPTY THE PAGE ────────────────────────────────────────────────
    //
    // This was a six-way `Promise.all` of `fetch(u).then((r) => r.json())`. `fetch` does not reject
    // on a 500 and this server's 500 body is `{"error": "..."}`, which parses, so the refusal
    // arrived as DATA and the first `for (const c of chans)` threw `chans is not iterable` out of
    // the whole bootstrap. The `.catch(() => [])` guards on activity and dms never fired for the
    // same reason: there was nothing to catch. Because `load()` rejected, `connect()`, which runs
    // as `load().then(connect)`, was never called, so the page sat at `disconnected` with no peers
    // and no channel hubs and could not recover without a reload. Measured against a broker behind
    // a 160ms link, where `/api/channels` and `/api/activity` both returned 500 `timeout`.
    //
    // Now every source is read independently, only successful reads are applied, and what did not
    // land is named on screen. Nothing here can prevent `connect()` from running.
    const SNAP = window.COTAL_SNAPSHOT;
    let activityPage = null;
    const stale = await SNAP.refreshAll([
      { name: "space", read: async () => SNAP.readJson(await fetch("/api/meta"), "space"),
        apply: (meta) => { $("space").textContent = "· " + meta.space; } },
      { name: "channels", read: async () => SNAP.readJson(await fetch("/api/channels"), "channels"),
        apply: (chans) => { for (const c of chans) { const h = ensureHub(c.channel); h.msgs = c.messages || 0; h.desc = c.description || ""; h.deliveryClass = c.deliveryClass; h.replay = c.replay; h.replayWindow = c.replayWindow; } } },
      { name: "peers", read: async () => SNAP.readJson(await fetch("/api/roster"), "peers"),
        apply: supersededByFeed("peers", (roster) => updateRoster(roster)) },
      // `.catch(() => ({members: []}))` here turned a failed fetch into an empty snapshot, which the
      // pill then reported as "traffic-only" — the client half of the same defect the server had.
      // A non-200 is not a snapshot either: `r.json()` on the refusal body would parse fine and
      // arrive as data, so the status is checked before the body is trusted. That check now lives in
      // `readJson`, and an unreadable feed reaches `membershipUnreadable()` through the stale path.
      { name: "membership", read: async () => SNAP.readJson(await fetch("/api/membership"), "membership"),
        apply: supersededByFeed("membership", (m) => applyMembership(m)) },
      // `/api/activity` answers an ENVELOPE, never a bare array; a caller that ignored `partial`
      // would break here rather than seed a short page as though it were the whole backfill.
      { name: "activity", read: async () => SNAP.readJson(await fetch("/api/activity?limit=400"), "activity"),
        apply: (page) => { activityPage = page; seedActivity(page.entries); } },
      { name: "direct messages", read: async () => SNAP.readJson(await fetch("/api/dms?limit=400"), "direct messages"),
        apply: (dmHist) => seedDms(dmHist) },
    ]);
    if (activityPage && activityPage.partial)
      stale.push({
        kind: "partial",
        name: "activity",
        reason: `${activityPage.read} of ${activityPage.of} sources answered within ${activityPage.deadlineMs}ms; missing ${activityPage.missing.join(", ")}`,
      });
    setStale(stale);
    // A bootstrap read that REFUSED is a sentence about the membership source like any other, so it
    // obeys the same rule as the snapshot beside it: it is a fact about that one read, and the live
    // feed may already have said something newer. Routed through `supersededByFeed` rather than a
    // second copy of the condition, because two spellings of one rule is how two halves drift apart.
    if (stale.some((s) => s.name === "membership")) supersededByFeed("membership", membershipUnreadable)();
    alpha = 1; for (let i = 0; i < 200; i++) physics(); // pre-warm to a settled layout
    const f = fitTarget(); cam.x = f.x; cam.y = f.y; cam.scale = f.scale;
  }

  /** Seed traffic glow + the `recent` buffer from the activity backfill so the channel detail's
   *  "recently active" tags and the "recent" section aren't empty until the first live SSE message
   *  arrives. Its own function so the read that feeds it can fail without taking the boot with it. */
  function seedActivity(activity) {
    for (const e of activity) { const m = e.msg; if (m) m.channel = e.channel; const a = m?.from?.id && agents.get(m.from.id); if (e.mode === "chat" && m?.channel && a) chatHit(a, m.channel, m.ts || now()); }
    for (const e of activity.slice(-80)) {
      const m = e.msg; if (!m) continue;
      const to = e.mode === "unicast" ? (typeof m.to === "string" ? (agents.get(m.to)?.name || shortId(m.to)) : m.to?.name) : e.mode === "anycast" ? "@" + (m.toService || "") : null;
      recent.push({ mode: e.mode, from: m.from?.name, fromId: m.from?.id, to, chan: m.channel, text: partsText(m), ts: m.ts || now() });
    }
    recent.sort((a, b) => a.ts - b.ts);
    if (recent.length > 80) recent.splice(0, recent.length - 80);
  }

  function seedDms(dmHist) {
    for (const m of dmHist) { const a = m.from?.id && agents.get(m.from.id), b = typeof m.to === "string" && agents.get(m.to); if (a && b && a !== b) dmHit(a, b, m.ts || now()); }
  }
  function connect() { const es = new EventSource("/feed"); es.onopen = () => setConn(true); es.onerror = () => setConn(false); es.addEventListener("roster", (e) => { liveApplied.add("peers"); updateRoster(JSON.parse(e.data)); }); es.addEventListener("membership", (e) => { liveApplied.add("membership"); applyMembership(JSON.parse(e.data)); }); es.addEventListener("membership-read-failed", () => { liveApplied.add("membership"); membershipUnreadable(); }); es.addEventListener("message", (e) => onMessage(JSON.parse(e.data))); }

  resize();
  setInterval(setFeed, 5000); // age "live" → "stale" even without new events
  // THE FEED IS NOT GATED ON THE BOOTSTRAP, IN EITHER SENSE. It was once chained behind `load()`
  // RESOLVING, so a single refused read left the page permanently disconnected with nothing on it.
  // That was fixed by making `load()` never reject, which guaranteed `connect()` would RUN but not
  // that it would run SOON: chained with `.then`, it still waited for the whole bootstrap, and that
  // bootstrap reads `/api/activity?limit=400` and `/api/dms?limit=400`, both bounded by the
  // aggregation deadline. On a slow link the page therefore read `disconnected` for the entire load
  // window. Observed across a WAN link as "always showing disconnected, and taking long to show the
  // graph". The live feed is exactly what a page showing stale data needs most, so it opens FIRST
  // and the bootstrap fills in around it. The Monitor page has always done this: `app.js` ends with
  // `refresh(); connect();`, concurrent, not chained.
  connect();
  load().catch((err) => console.error(err));
  requestAnimationFrame(frame);
})();
