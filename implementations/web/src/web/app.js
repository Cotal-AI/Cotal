// Cotal observability client: a read-only god-view of one space. Presence + channel
// list + DM history come over HTTP; the live stream (roster + every chat/unicast/anycast
// message) arrives via SSE (/feed). This page never publishes to the mesh.
//
// Three centre views, one consistent skeleton (left = navigation, centre = content,
// right = NEEDS YOU, always): the Monitor (all-activity feed), a Channel view (message
// list; members fold into the header), and a Direct-messages lens (per-peer roll-up in
// the sidebar → a thread in the centre). `?demo` renders the fixed reference scene.

const $ = (id) => document.getElementById(id);
const STATUS = ["working", "waiting", "idle", "offline"];
// Status as shape *and* colour (never colour alone).
const GLYPH = { working: "●", waiting: "◐", idle: "○", offline: "⊘" };
const MODES = ["chat", "unicast", "anycast"];
const isDemo = new URLSearchParams(location.search).has("demo");

let roster = [];
let channels = new Map(); // name -> { messages, description?, replay, replayWindow?, deliveryClass }
let unread = new Map(); // name -> messages seen since last viewed
let dms = []; // raw DM messages (god-view), grouped client-side
let selected = "*"; // "*" = all activity, else a channel name (null when a DM is open)
let dmSel = null; // { peer, with } when a Direct-messages thread is open
let agentSel = null; // peer id when an Agent Detail drill-down is open (else selected/dmSel drive the view)
let activity = []; // {mode, msg} ring buffer for the all-activity view
let channelMsgs = []; // messages for the selected channel
let modes = new Set(MODES); // delivery modes currently shown
let paused = false; // freeze auto-scroll so a value can be read
let expandAll = false; // channel-wide: expand every clamped message body (else per-message toggle)

const esc = (s) =>
  String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const bodyText = (msg) => window.COTAL_PARTS.partsToText(msg.parts);
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const agoShort = (ts) => (ago(ts) === "just now" ? "now" : ago(ts));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Markdown rendering lives in md.js (window.COTAL_MD) — marked + DOMPurify, one source for every
// message body. render() escapes+sanitizes untrusted agent text; never pass raw text to innerHTML.
const MD = window.COTAL_MD;
// Harness branding lives in harness.js (window.COTAL_HARNESS) — one source for monitor + graph.
const HARNESS = window.COTAL_HARNESS || {};
// Render the harness badge: a branded pill (svg + label) by default, or `{compact:true}` for a
// bare colour icon (the roster row). Style values only ever come from HARNESS, never raw card input.
function harnessBadge(connector, opts = {}) {
  if (!connector) return "";
  const h = HARNESS[connector];
  const color = h ? h.color : "var(--dim)";
  const text = h ? h.label : connector;
  if (opts.compact)
    return h ? `<span class="harness-ico" style="color:${color}" title="harness · ${esc(text)}">${h.svg}</span>` : "";
  return `<span class="harness-badge" style="--hc:${color}" title="agent harness · ${esc(text)}">${h ? h.svg : ""}<span class="hl">${esc(text)}</span></span>`;
}
// Attention is advisory presence: open/absent are the same ("receives all") — only dnd/focus surface.
// Shape + label (never colour alone). Returns "" for open/absent.
function attentionChip(attention, opts = {}) {
  if (attention !== "dnd" && attention !== "focus") return "";
  const label = attention === "dnd" ? "dnd" : "focus";
  const glyph = attention === "dnd" ? "◼" : "◉";
  const title = attention === "dnd" ? "do not disturb — untagged channel chatter won't wake" : "focus — only DMs/anycast reach context";
  if (opts.compact) return `<span class="att ${label}" title="${title}">${glyph}</span>`;
  return `<span class="att-badge ${label}" title="${title}"><span class="att ${label}">${glyph}</span>${label}</span>`;
}

function setConn(live) {
  const el = $("conn");
  el.className = "pill" + (live ? "" : " down");
  el.querySelector(".t").textContent = live ? "live" : "disconnected";
}

// ── Header: golden-signal tiles ───────────────────────────────────────────────
// Fifth tile is last-heartbeat freshness (Presence.ts), NOT blocked-duration — we cannot know
// how long someone has been waiting (no statusSince on the wire). Label it honestly.
function renderTiles(counts, stalest) {
  const tiles = [
    ["working", counts.working],
    ["waiting", counts.waiting],
    ["idle", counts.idle],
    ["offline", counts.offline],
    ["oldest", stalest, "stalest live heartbeat"],
  ];
  $("tiles").innerHTML = tiles
    .map(([k, n, lbl]) => {
      // Amber only when waiting > 0 — a zero-count alert is pure alarm fatigue.
      const alert = k === "waiting" && Number(n) > 0 ? " alert" : "";
      return `<div class="tile ${k}${alert}">
        <span class="bar"></span>
        <div class="c"><span class="n">${n}</span><span class="lbl">${lbl ?? k}</span></div>
      </div>`;
    })
    .join("");
}

// ── Sidebar: roster ───────────────────────────────────────────────────────────
function peerRow(p) {
  // A peer with an id is a click-through into its Agent Detail card; demo rows have no id.
  const nav = p.id ? ` nav${p.id === agentSel ? " sel" : ""}` : "";
  const attrs = p.id ? ` data-agent="${esc(p.id)}" tabindex="0" role="button"` : "";
  return `<div class="peer ${p.status}${nav}"${attrs}>
    <span class="dot ${p.status}">${GLYPH[p.status] ?? "○"}</span>
    <div class="c">
      <div class="l1">
        <span class="name">${esc(p.name)}</span>
        ${p.harness ? harnessBadge(p.harness, { compact: true }) : ""}
        ${p.role ? `<span class="role">${esc(p.role)}</span>` : ""}
        ${attentionChip(p.attention, { compact: true })}
        ${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ""}
      </div>
      ${p.act ? `<div class="act" title="${esc(p.act)}">${esc(p.act)}</div>` : ""}
    </div>
  </div>`;
}
function renderRoster(list) {
  $("roster").innerHTML = list.length
    ? list.map(peerRow).join("")
    : `<div class="empty">no peers</div>`;
  for (const el of $("roster").querySelectorAll(".peer[data-agent]")) {
    el.onclick = () => selectAgent(el.dataset.agent);
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") (e.preventDefault(), selectAgent(el.dataset.agent));
    };
  }
}
// The online roster, shaped for the sidebar: offline peers drop out (their count still rides the
// header tiles), live peers sort by status then name. Re-rendered on its own when a selection
// changes so the row highlight tracks the open Agent Detail.
function rosterRows() {
  return [...roster]
    .filter((p) => p.status !== "offline")
    .sort(
      (a, b) =>
        STATUS.indexOf(a.status) - STATUS.indexOf(b.status) ||
        a.card.name.localeCompare(b.card.name),
    )
    .map((p) => ({
      id: p.card.id,
      name: p.card.name,
      role: p.card.role,
      status: p.status,
      act: p.activity,
      harness: p.card.meta?.connector,
      attention: p.attention, // open/absent both render as nothing
      tag: p.status === "waiting" ? "needs input" : null,
    }));
}

// ── Sidebar: channels ─────────────────────────────────────────────────────────
// deliveryClass as shape+letter (never colour alone): D = durable, L = live.
function deliveryGlyph(dc) {
  if (dc === "live") return `<span class="dclass live" title="live delivery — at-most-once">L</span>`;
  if (dc === "durable") return `<span class="dclass durable" title="durable delivery — at-least-once for members">D</span>`;
  return "";
}
// Replay state at a glance (shape, not colour alone): ↻ = on, struck ↻ = off. Unknown (a live
// message that beat the registry) shows nothing rather than guessing a default.
function replayGlyph(replay) {
  if (replay === true) return `<span class="replay on" title="replay on — a join backfills retained history">↻</span>`;
  if (replay === false) return `<span class="replay off" title="replay off — a join does not backfill history">↻</span>`;
  return "";
}
function chanRow(ch) {
  const sel = !dmSel && ch.key === selected;
  const lead = ch.all ? `<span class="glyph">✸</span>` : `<span class="hash">#</span>`;
  return `<div class="chan${sel ? " sel" : ""}" data-ch="${esc(ch.key)}">
    <span class="l">${lead}<span class="name">${esc(ch.label)}</span>${ch.dclass ? deliveryGlyph(ch.dclass) : ""}${replayGlyph(ch.replay)}</span>
    ${ch.mention ? `<span class="mention">${ch.mention}</span>` : ""}
    <span class="count">${ch.count}</span>
  </div>`;
}
function renderChannels() {
  const names = [...channels.keys()]; // insertion order (curated in demo, server order live)
  const total = [...channels.values()].reduce((sum, ch) => sum + (ch.messages || 0), 0);
  const rows = [{ key: "*", all: true, label: "all activity", count: total }].concat(
    names.map((n) => {
      const c = channels.get(n) || {};
      return {
        key: n,
        label: n,
        count: c.messages || 0,
        mention: unread.get(n) || 0,
        dclass: c.deliveryClass,
        replay: c.replay,
      };
    }),
  );
  $("channels").innerHTML = rows.map(chanRow).join("");
  for (const el of $("channels").querySelectorAll(".chan")) el.onclick = () => select(el.dataset.ch);
}

// ── Sidebar: direct messages (per-peer roll-up → drill) ───────────────────────
const SEP = "\u0001";
function peerById(id) {
  return roster.find((x) => x.card?.id === id);
}
function roleOf(id) {
  const r = peerById(id);
  return r?.card?.role;
}
function rosterStatus(id) {
  const r = peerById(id);
  return r ? r.status : "offline";
}
// id→name resolution shared by the DM lens and the all-activity feed. `from` carries a full
// card (id+name), but a unicast `to` is the bare recipient identity id (a pubkey) — without this
// it renders raw. Sources: live roster cards, DM senders, and feed senders we've seen.
function nameIndex() {
  const idName = new Map();
  for (const p of roster) if (p.card?.id) idName.set(p.card.id, p.card.name);
  for (const m of dms) if (m.from?.id && m.from?.name) idName.set(m.from.id, m.from.name);
  for (const e of activity) if (e.msg?.from?.id && e.msg.from.name) idName.set(e.msg.from.id, e.msg.from.name);
  return idName;
}
// Resolve an EndpointRef object or a bare id to a display name; an unknown id shrinks to a short
// prefix, and a string that isn't an identity (already a name) passes through unchanged.
function displayNameOf(x, idx) {
  if (!x) return "?";
  if (typeof x === "object") return x.name || displayNameOf(x.id, idx);
  if (idx.has(x)) return idx.get(x);
  // Principal ids are exactly two NATS-safe tokens, owner.actor. Keep the opaque owner for
  // namespace disambiguation, but require a long actor so ordinary dotted display names survive.
  const principal = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(x);
  if (principal && principal[2].length >= 32)
    return `${principal[1]}.${principal[2].slice(0, 6)}…`;
  return /^[A-Z2-7]{32,}$/.test(x) ? x.slice(0, 6) + "…" : x; // legacy bare identity
}

// Group raw DMs into per-peer rows; each peer lists its counterparties (conversations).
// O(peers-with-DMs), never the n² pair cross-product — only pairs that actually talked.
function dmPeers() {
  if (isDemo) return DEMO.dmPeers;
  const idx = nameIndex();
  const conv = new Map();
  for (const m of dms) {
    const from = m.from?.id;
    const to = typeof m.to === "string" ? m.to : m.to?.id;
    if (!from || !to || from === to) continue;
    const parts = [from, to].sort();
    const key = parts.join(SEP);
    if (!conv.has(key)) conv.set(key, { parts, msgs: [] });
    conv.get(key).msgs.push({
      ts: time(m.ts),
      who: from,
      whoName: displayNameOf(from, idx),
      status: rosterStatus(from),
      body: bodyText(m),
      _ts: m.ts,
    });
  }
  const peers = new Map();
  for (const c of conv.values()) {
    c.msgs.sort((x, y) => x._ts - y._ts);
    const last = c.msgs.length ? c.msgs[c.msgs.length - 1]._ts : 0;
    for (const p of c.parts) {
      const other = c.parts[0] === p ? c.parts[1] : c.parts[0];
      if (!peers.has(p)) peers.set(p, { id: p, name: displayNameOf(p, idx), conversations: [], last: 0 });
      const pe = peers.get(p);
      pe.conversations.push({
        with: other,
        withName: displayNameOf(other, idx),
        role: roleOf(other),
        status: rosterStatus(other),
        unread: 0,
        last,
        msgs: c.msgs,
      });
      pe.last = Math.max(pe.last, last);
    }
  }
  return [...peers.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: roleOf(p.id),
      status: rosterStatus(p.id),
      unread: 0,
      threads: p.conversations.length,
      conversations: p.conversations.sort((a, b) => b.last - a.last),
      last: p.last,
    }))
    .sort((a, b) => b.last - a.last);
}
function dmPeerRow(p, expanded) {
  return `<div class="dm${expanded ? " sel" : ""}" data-dm="${esc(p.id)}">
    <span class="caret">${expanded ? "▾" : "▸"}</span>
    <span class="l">
      <span class="dot ${p.status}">${GLYPH[p.status] ?? "○"}</span>
      <span class="nm">${esc(p.name)}</span>
      ${p.role ? `<span class="role">${esc(p.role)}</span>` : ""}
    </span>
    ${p.unread ? `<span class="mention">${p.unread}</span>` : ""}
    ${expanded ? "" : `<span class="threads">${plural(p.threads, "thread")}</span>`}
  </div>`;
}
function dmSubRow(peer, c) {
  const sel = dmSel && dmSel.peer === peer && dmSel.with === c.with;
  return `<div class="dm sub${sel ? " sel" : ""}" data-dm="${esc(peer)}${SEP}${esc(c.with)}">
    <span class="ln">↳</span>
    <span class="l">
      <span class="dot ${c.status}">${GLYPH[c.status] ?? "○"}</span>
      <span class="nm">${esc(c.withName ?? c.with)}</span>
      ${c.role ? `<span class="role">${esc(c.role)}</span>` : ""}
    </span>
    ${c.unread ? `<span class="mention">${c.unread}</span>` : ""}
  </div>`;
}
function renderDMs() {
  const peers = dmPeers();
  if (!peers.length) {
    $("dms").innerHTML = `<div class="empty">no direct messages</div>`;
    return;
  }
  let html = "";
  for (const p of peers) {
    const expanded = !!dmSel && dmSel.peer === p.id;
    html += dmPeerRow(p, expanded);
    if (expanded) for (const c of p.conversations) html += dmSubRow(p.id, c);
  }
  $("dms").innerHTML = html;
  for (const el of $("dms").querySelectorAll("[data-dm]")) {
    el.onclick = () => {
      const [peer, w] = el.dataset.dm.split(SEP);
      selectDM(peer, w || null);
    };
  }
}
function renderSidebarNav() {
  renderChannels();
  renderDMs();
}

// ── Feed rows (all-activity) ──────────────────────────────────────────────────
// Progressive disclosure: long agent essays collapse to a few lines; full text one click away.
// Never silently truncate — the expand control is the only path to the rest. Bodies render markdown
// (md.js), so the clamp caps rendered height, not raw characters. `expandAll` opens every body at
// once (the channel-wide toggle); an individual "show more" still flips one.
const BODY_CLAMP_CHARS = 280;
const isLong = (text) => !!text && text.length > BODY_CLAMP_CHARS;
function bodyBlock(text) {
  const html = MD.render(text || "");
  if (!isLong(text)) return `<div class="body md">${html}</div>`;
  const open = expandAll ? " open" : "";
  const label = expandAll ? "show less" : "show more";
  return `<div class="body md clamp${open}">
    <div class="body-text">${html}</div>
    <button type="button" class="body-more">${label}</button>
  </div>`;
}
// The channel-wide expand/collapse-all control — rendered only when a list actually has clamped
// bodies (nothing to toggle otherwise). Reuses the mode-chip look.
function toggleAllChip(items, bodyOf = (x) => x.body) {
  if (!items.some((x) => isLong(bodyOf(x)))) return "";
  return `<span class="chip toggle-all" id="toggle-all" title="${expandAll ? "collapse every message" : "expand every message"}">${expandAll ? "⊟ collapse all" : "⊞ expand all"}</span>`;
}
function bindToggleAll(root) {
  const el = root.querySelector("#toggle-all");
  if (el) el.onclick = () => ((expandAll = !expandAll), renderCenter());
}
function bindBodyToggles(root) {
  for (const btn of root.querySelectorAll(".body-more")) {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const block = btn.closest(".body");
      const open = block.classList.toggle("open");
      btn.textContent = open ? "show less" : "show more";
    };
  }
}
function rowHTML(e) {
  if (e.type === "sys") return `<div class="sys">${esc(e.text)}</div>`;
  if (e.type === "rollup")
    return `<div class="rollup"><span class="ar">⌄</span><span class="t">${esc(e.text)}</span></div>`;
  const intent = e.type === "intent";
  const badgeClass = intent ? "intent" : e.mode;
  const badgeText = intent ? "⟶ intent" : e.mode;
  const tgt = intent ? e.note : e.target;
  return `<div class="msg${intent ? " intent" : ""}">
    <span class="ts">${esc(e.ts)}</span>
    <span class="badge ${badgeClass}">${esc(badgeText)}</span>
    <div class="c">
      <div class="l1">
        <span class="who">${esc(e.who)}</span>
        ${e.role ? `<span class="role">${esc(e.role)}</span>` : ""}
        ${tgt ? `<span class="tgt">${esc(tgt)}</span>` : ""}
        ${e.sub ? `<span class="subpill">${esc(e.sub)}</span>` : ""}
      </div>
      ${bodyBlock(e.body)}
    </div>
  </div>`;
}
function liveEntry(mode, msg, idx) {
  const target =
    mode === "chat"
      ? `#${msg.channel ?? ""}`
      : mode === "unicast"
        ? `→ ${displayNameOf(msg.to, idx)}`
        : `→ @${msg.toService ?? ""}`;
  return {
    type: "msg",
    mode,
    ts: time(msg.ts),
    who: msg.from?.name ?? "?",
    role: msg.from?.role,
    target,
    body: bodyText(msg),
  };
}

function renderAllActivity() {
  const center = $("center");
  const prev = center.querySelector(".feed");
  const atBottom = prev ? prev.scrollHeight - prev.scrollTop - prev.clientHeight < 40 : true;
  const idx = nameIndex();
  const rows = (isDemo ? DEMO.activity : activity.map((e) => liveEntry(e.mode, e.msg, idx))).filter(
    (e) => !e.mode || modes.has(e.mode),
  );
  const sub = isDemo ? "112 recent · live" : `${rows.length} recent · live`;
  center.innerHTML = `
    <div class="feed-head">
      <span class="h">✸ All activity</span>
      <span class="sub">${esc(sub)}</span>
      <span class="ctrls">
        ${toggleAllChip(rows)}
        ${MODES.map((m) => `<span class="chip mode${modes.has(m) ? " on" : ""}" data-mode="${m}">${m}</span>`).join("")}
        <span class="chip pause${paused ? " on" : ""}" id="pause">${paused ? "▶ resume" : "⏸ pause"}</span>
      </span>
    </div>
    <div class="feed">${rows.length ? rows.map(rowHTML).join("") : `<div class="empty">waiting for messages…</div>`}</div>`;
  for (const chip of center.querySelectorAll(".chip[data-mode]"))
    chip.onclick = () => {
      const m = chip.dataset.mode;
      modes.has(m) ? modes.delete(m) : modes.add(m);
      renderAllActivity();
    };
  const pause = center.querySelector("#pause");
  if (pause) pause.onclick = () => ((paused = !paused), renderAllActivity());
  bindToggleAll(center);
  bindBodyToggles(center);
  const feed = center.querySelector(".feed");
  if (atBottom && !paused) feed.scrollTop = feed.scrollHeight;
}

// ── Channel view (centre; members fold into the header) ───────────────────────
function cmsgHTML(m) {
  if (m.type === "unread")
    return `<div class="unread-mark"><span class="line"></span><span class="t">${esc(m.text)}</span><span class="line"></span></div>`;
  return `<div class="cmsg">
    <span class="ts">${esc(m.ts)}</span>
    <span class="dot ${m.status}">${GLYPH[m.status] ?? "●"}</span>
    <div class="c">
      <div class="l1"><span class="who">${esc(m.who)}</span>${m.role ? `<span class="role">${esc(m.role)}</span>` : ""}</div>
      ${bodyBlock(m.body)}
      ${m.thread ? `<span class="thread">${esc(m.thread)}</span>` : ""}
    </div>
  </div>`;
}
function channelMembers(msgs) {
  const seen = new Map();
  for (const msg of msgs) {
    const id = msg.from?.id;
    if (!id || seen.has(id)) continue;
    seen.set(id, { name: msg.from?.name ?? "?", role: msg.from?.role, status: rosterStatus(id) });
  }
  return [...seen.values()];
}
function renderChannel() {
  const name = selected;
  const meta = channels.get(name) || {};
  let items, memberCount, msgCount, desc;
  if (isDemo) {
    items = DEMO.cv.messages;
    memberCount = DEMO.cv.members.length;
    msgCount = meta.messages ?? 51;
    desc = name === "team.backend" ? "Backend coordination — channels, endpoint, NATS." : meta.description || "";
  } else {
    items = channelMsgs.map((msg) => ({
      ts: time(msg.ts),
      status: rosterStatus(msg.from?.id),
      who: msg.from?.name ?? "?",
      role: msg.from?.role,
      body: bodyText(msg),
    }));
    memberCount = channelMembers(channelMsgs).length;
    msgCount = meta.messages ?? items.length;
    desc = meta.description || "";
  }
  // Effective policy chips from /api/channels (server-resolved; never re-derived in the browser).
  const policy = [];
  if (meta.deliveryClass) policy.push(`<span class="chip policy" title="effective delivery class">${esc(meta.deliveryClass)}</span>`);
  if (meta.replay === false) policy.push(`<span class="chip policy" title="join does not backfill history">replay off</span>`);
  else if (meta.replay === true)
    policy.push(`<span class="chip policy" title="join backfills retained history">${meta.replayWindow ? `replay ${esc(meta.replayWindow)}` : "replay on"}</span>`);
  const sub = name.includes(".") ? `subtree of ${name.split(".")[0]}.>` : "";
  const purpose = [desc, `${plural(memberCount, "member")}`, `${plural(msgCount, "message")}`]
    .filter(Boolean)
    .map((b) => esc(String(b)))
    .join("  ·  ");
  $("center").innerHTML = `
    <div class="ch-head">
      <div class="row">
        <div class="title"><span class="h"># ${esc(name)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>
        <div class="ctrls">
          ${toggleAllChip(items)}
          <span class="chip mode on">👥 ${plural(memberCount, "member")}</span>
          ${policy.join("")}
          ${isDemo ? `<span class="chip static" title="demo only">✦ summarize</span><span class="chip static" title="demo only">🔕 mute</span>` : ""}
          ${isDemo ? "" : `<span class="chip danger" id="ch-del" title="Delete this channel and all its messages">🗑 delete</span>`}
        </div>
      </div>
      <div class="purpose">${purpose}</div>
    </div>
    <div class="clist">${items.length ? items.map(cmsgHTML).join("") : `<div class="empty">no messages</div>`}</div>`;
  const list = $("center").querySelector(".clist");
  list.scrollTop = list.scrollHeight;
  bindToggleAll($("center"));
  bindBodyToggles($("center"));
  const del = $("center").querySelector("#ch-del");
  if (del) del.onclick = () => deleteChannel(name);
}

// Delete the channel and its content (steward action). Confirm first — purging the chat
// stream is irreversible. On success the channel drops from the sidebar and the view falls
// back to all-activity; a stray live message would recreate it (deletion clears, not bans).
async function deleteChannel(name) {
  if (!name || name === "*") return;
  if (!confirm(`Delete #${name} and all its messages?\n\nThis purges the channel's history and cannot be undone.`)) return;
  try {
    const r = await fetch("/api/channel/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: name }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    channels.delete(name);
    unread.delete(name);
    activity = activity.filter((e) => e.msg.channel !== name); // drop its rows from all-activity
    select("*");
  } catch (e) {
    alert(`Couldn't delete #${name}: ${e.message}`);
  }
}

// ── Direct-messages thread (centre) ───────────────────────────────────────────
function dmMsgHTML(m, peer, peerName, withName) {
  const to = m.who === peer ? withName : peerName;
  return `<div class="cmsg">
    <span class="ts">${esc(m.ts)}</span>
    <span class="dot ${m.status}">${GLYPH[m.status] ?? "●"}</span>
    <div class="c">
      <div class="l1"><span class="who">${esc(m.whoName ?? m.who)}</span><span class="dir">→ ${esc(to)}</span></div>
      <div class="body md">${MD.render(m.body)}</div>
    </div>
  </div>`;
}
function renderDMThread() {
  const peer = dmSel.peer;
  const pe = dmPeers().find((p) => p.id === peer);
  const conv = pe && (pe.conversations.find((c) => c.with === dmSel.with) || pe.conversations[0]);
  const peerName = pe?.name ?? displayNameOf(peer, nameIndex());
  const withName = conv?.withName ?? displayNameOf(dmSel.with, nameIndex());
  const msgs = conv ? conv.msgs : []; // display-ready (ts, who, status, body) for demo + live
  $("center").innerHTML = `
    <div class="ch-head">
      <div class="row">
        <div class="title"><span class="h">${esc(peerName)} ↔ ${esc(withName)}</span><span class="dtag">direct</span></div>
        <div class="ctrls"></div>
      </div>
      <div class="purpose">unicast · private to the two of them  ·  ${plural(msgs.length, "message")}</div>
    </div>
    <div class="clist">${msgs.length ? msgs.map((m) => dmMsgHTML(m, peer, peerName, withName)).join("") : `<div class="empty">no messages</div>`}</div>`;
  const list = $("center").querySelector(".clist");
  list.scrollTop = list.scrollHeight;
}

// ── NEEDS YOU rail (always on the right) ──────────────────────────────────────
function cardHTML(c) {
  const nav = c.id ? ` nav${c.id === agentSel ? " sel" : ""}` : "";
  return `<div class="card tone-${c.tone}${nav}"${c.id ? ` data-agent="${esc(c.id)}"` : ""}>
    <div class="top">
      <div class="cat-l"><span class="cdot"></span><span class="cat">${esc(c.cat)}</span></div>
      <span class="age">${esc(c.age)}</span>
    </div>
    <div class="title">${esc(c.title)}${c.role ? `<span class="crole">${esc(c.role)}</span>` : ""}</div>
    <div class="desc">${esc(c.desc)}</div>
    ${c.primary ? `<div class="btns"><span class="btn primary">${esc(c.primary)}</span>${c.secondary ? `<span class="btn secondary">${esc(c.secondary)}</span>` : ""}</div>` : ""}
  </div>`;
}
function waitingCards() {
  // Sort by name (stable, honest) — p.ts is last heartbeat, not time-entered-waiting, so we
  // must not present heartbeat order as an age-ordered priority queue.
  return roster
    .filter((p) => p.status === "waiting")
    .sort(
      (a, b) =>
        a.card.name.localeCompare(b.card.name) || a.card.id.localeCompare(b.card.id),
    )
    .map((p) => ({
      tone: "amber",
      cat: "WAITING",
      age: `seen ${ago(p.ts)}`, // Presence.ts = last heartbeat, not blocked-duration
      title: `${p.card.name} is waiting`,
      role: p.card.role,
      // p.activity is the Claude Code Notification text (the actual blocking prompt/permission).
      desc: p.activity || "waiting for input",
      id: p.card.id, // makes the card a clickable drill-down into the Agent Detail view
    }));
}
function renderRail() {
  const cards = isDemo ? DEMO.cards : waitingCards();
  const main = $("main");
  const rail = $("rail");
  // Always-present lane, not always full width: collapse to a strip when nothing needs a human.
  if (!cards.length) {
    main.classList.add("rail-thin");
    rail.className = "rail collapsed";
    rail.innerHTML = `<div class="rail-collapsed" title="nothing waiting">NEEDS YOU · all clear</div>`;
    return;
  }
  main.classList.remove("rail-thin");
  rail.className = "rail";
  rail.innerHTML =
    `<div class="rail-head"><span class="t">NEEDS YOU</span><span class="n">${cards.length}</span></div>` +
    cards.map(cardHTML).join("") +
    `<div class="rail-foot">Everything else stays quiet in the feed.</div>`;
  for (const el of rail.querySelectorAll(".card[data-agent]"))
    el.onclick = () => selectAgent(el.dataset.agent);
}

// ── Agent Detail drill-down (centre) — per-agent frame, rendered from the peer's card (docs/web.md) ──
function selectAgent(id) {
  agentSel = id;
  dmSel = null;
  selected = null;
  renderSidebarNav();
  renderRoster(rosterRows()); // light up the clicked peer (only reached live — demo rows have no id)
  renderCenter();
  renderRail();
}
function renderAgentDetail() {
  const p = roster.find((x) => x.card.id === agentSel);
  if (!p) {
    $("center").innerHTML = `<div class="detail"><div class="empty">agent no longer present — pick another from the roster or NEEDS YOU.</div></div>`;
    return;
  }
  // The AgentCard is the legibility contract: who, in what role, what it can do, on what harness.
  // Render only fields the card actually carries (skills/protocolVersion aren't populated yet).
  const card = p.card;
  const meta = card.meta || {};
  const waiting = p.status === "waiting";
  const who = card.role ? `${esc(card.name)}<span class="crole">${esc(card.role)}</span>` : esc(card.name);
  // p.ts is last heartbeat (Presence.ts), not status-entered-at — never say "waiting 4m".
  const since = `${esc(p.status)} · seen ${esc(ago(p.ts))}`;

  // Model when known; harness agent with no model → "not reported"; no harness and no model → nothing.
  const modelBadge = meta.model
    ? `<span class="d-badge model" title="model">${esc(meta.model)}${meta.variant ? `<span class="var"> · ${esc(meta.variant)}</span>` : ""}</span>`
    : meta.connector
      ? `<span class="d-badge model muted" title="host did not report a model">not reported</span>`
      : "";
  const badges = [
    card.kind ? `<span class="d-badge">${esc(card.kind)}</span>` : "",
    harnessBadge(meta.connector),
    modelBadge,
    attentionChip(p.attention), // open/absent → ""
  ].join("");
  const desc = card.description ? `<div class="d-desc">${esc(card.description)}</div>` : "";
  const blocked = waiting
    ? `<div class="d-label">Blocked on</div><div class="d-block">${esc(p.activity || "waiting for input")}</div>`
    : `<div class="d-label">Activity</div><div class="d-block muted">${esc(p.activity || "no current activity")}</div>`;

  const sec = (label, body) => (body ? `<div class="d-sec"><div class="d-label">${esc(label)}</div>${body}</div>` : "");
  const tags = (card.tags || []).length
    ? `<div class="d-chips">${card.tags.map((t) => `<span class="d-chip">${esc(t)}</span>`).join("")}</div>`
    : "";
  const skills = (card.skills || []).length
    ? `<div class="d-skills">${card.skills
        .map((s) => `<div class="d-skill"><span class="nm">${esc(s.name || s.id)}</span>${s.description ? `<span class="dsc">${esc(s.description)}</span>` : ""}</div>`)
        .join("")}</div>`
    : "";
  // Per-channel attention overrides (quiet/muted). Advisory receive-side presentation, not ACL.
  const modeEntries = Object.entries(p.channelModes || {}).sort(([a], [b]) => a.localeCompare(b));
  const channelModes = modeEntries.length
    ? `<div class="d-chips">${modeEntries
        .map(([ch, m]) => `<span class="d-chip mode-${esc(m)}" title="per-channel attention">#${esc(ch)} · ${esc(m)}</span>`)
        .join("")}</div>`
    : "";
  // Any other meta beyond the badges (connector/model/variant already first-class), generically rendered.
  const extra = Object.entries(meta)
    .filter(([k]) => k !== "connector" && k !== "model" && k !== "variant")
    .sort(([a], [b]) => a.localeCompare(b));
  const metaKv = extra.length
    ? `<div class="d-kv">${extra
        .map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(typeof v === "string" ? v : JSON.stringify(v))}</span></div>`)
        .join("")}</div>`
    : "";
  const proto = card.protocolVersion ? `<span class="d-foot-item">protocol ${esc(card.protocolVersion)}</span>` : "";

  $("center").innerHTML = `
    <div class="detail${waiting ? " amber" : ""}">
      <div class="d-head">
        <span class="dot ${p.status}">${GLYPH[p.status] ?? "●"}</span>
        <span class="d-status">${esc(waiting ? "WAITING" : p.status)}</span>
        <span class="d-age">${since}</span>
      </div>
      <div class="d-who">${who}</div>
      ${badges ? `<div class="d-badges">${badges}</div>` : ""}
      ${desc}
      ${blocked}
      ${sec("Channel attention", channelModes)}
      ${sec("Tags", tags)}
      ${sec("Skills", skills)}
      ${sec("Metadata", metaKv)}
      <div class="d-foot"><span class="d-foot-item id">${esc(card.id)}</span>${proto}</div>
    </div>`;
}

// ── View dispatch ─────────────────────────────────────────────────────────────
function renderCenter() {
  if (agentSel) return renderAgentDetail();
  if (dmSel) return renderDMThread();
  if (selected === "*") return renderAllActivity();
  return renderChannel();
}

function refreshDerived() {
  const counts = { working: 0, waiting: 0, idle: 0, offline: 0 };
  for (const p of roster) counts[p.status] = (counts[p.status] ?? 0) + 1;
  // Stalest heartbeat among LIVE peers only — offline ages grow forever and are pure noise in a
  // golden-signal slot. Among live peers this catches a lapsed heartbeat before the offline flip.
  const live = roster.filter((p) => p.status !== "offline" && typeof p.ts === "number");
  const stalest = live.length ? agoShort(Math.min(...live.map((p) => p.ts))) : "—";
  renderTiles(counts, stalest);
  $("online-c").textContent = roster.filter((p) => p.status !== "offline").length;
  renderRoster(rosterRows()); // online list; offline peers drop out but still ride the header tiles
  renderDMs(); // peer statuses may have changed
  renderRail();
  if (agentSel) renderCenter(); // keep an open Agent Detail live as the peer's status/activity changes
}

let loadSeq = 0;
async function select(key) {
  agentSel = null;
  dmSel = null;
  selected = key;
  if (key !== "*") unread.set(key, 0);
  renderSidebarNav();
  if (!isDemo) renderRoster(rosterRows()); // clear any stale Agent Detail highlight
  if (isDemo) return (renderCenter(), renderRail());
  if (key !== "*") {
    const seq = ++loadSeq;
    channelMsgs = [];
    renderCenter();
    const msgs = await (await fetch(`/api/channels/${encodeURIComponent(key)}/history?limit=200`)).json();
    if (seq !== loadSeq) return;
    channelMsgs = msgs;
  }
  renderCenter();
  renderRail();
}
function selectDM(peer, w) {
  agentSel = null;
  const pe = dmPeers().find((p) => p.id === peer);
  dmSel = { peer, with: w || (pe && pe.conversations[0] ? pe.conversations[0].with : null) };
  selected = null;
  renderSidebarNav();
  if (!isDemo) renderRoster(rosterRows()); // clear any stale Agent Detail highlight
  renderCenter();
  renderRail();
}

async function refresh() {
  roster = await (await fetch("/api/roster")).json();
  refreshDerived();
  const list = await (await fetch("/api/channels")).json();
  // L2 shape is flat {channel,messages,description?,replay,replayWindow?,deliveryClass}.
  // Tolerate a nested-config server briefly (pre-restart) without re-deriving defaults.
  channels = new Map(
    list.map((c) => {
      if (c.replay !== undefined || c.deliveryClass !== undefined || (c.description && !c.config))
        return [c.channel, c];
      const cfg = c.config || {};
      return [
        c.channel,
        {
          messages: c.messages,
          description: cfg.description,
          replay: cfg.replay,
          replayWindow: cfg.replayWindow,
          deliveryClass: cfg.deliveryClass,
        },
      ];
    }),
  );
  dms = await (await fetch("/api/dms?limit=500")).json();
  renderSidebarNav();
  if (agentSel) {
    renderCenter();
  } else if (dmSel) {
    renderCenter();
  } else if (selected !== "*") {
    select(selected);
  } else {
    activity = await (await fetch("/api/activity?limit=200")).json();
    renderCenter();
  }
}

function onMessage(entry) {
  const { mode, msg } = entry;
  if (!activity.some((e) => e.msg.id === msg.id)) {
    activity.push(entry);
    if (activity.length > 500) activity.shift();
  }
  if (mode === "unicast" && !dms.some((m) => m.id === msg.id)) {
    dms.push(msg);
    renderDMs();
  }
  if (msg.channel) {
    // A live message can beat the next channel-registry refresh. Keep its count but leave the
    // effective policy unknown until the server supplies the resolved L2 row.
    const ch = channels.get(msg.channel);
    channels.set(msg.channel, { ...(ch ?? {}), messages: (ch?.messages ?? 0) + 1 });
    if (!dmSel && selected === msg.channel) {
      channelMsgs.push(msg);
      if (channelMsgs.length > 500) channelMsgs.shift();
    } else {
      unread.set(msg.channel, (unread.get(msg.channel) ?? 0) + 1);
    }
    renderChannels();
  }
  if (dmSel ? mode === "unicast" : selected === "*" || selected === msg.channel) renderCenter();
}

function connect() {
  const es = new EventSource("/feed");
  es.addEventListener("open", () => {
    setConn(true);
    refresh();
  });
  es.addEventListener("roster", (e) => {
    roster = JSON.parse(e.data);
    refreshDerived();
  });
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("error", () => setConn(false));
}

// ── Demo scene (the Penpot reference frames) ──────────────────────────────────
const ab = [
  { ts: "10:47", who: "alice", status: "waiting", body: "can you take the API-key wiring while I'm blocked?" },
  { ts: "10:48", who: "bob", status: "working", body: "on it — grabbing the OPENAI_API_KEY wiring now" },
  { ts: "10:50", who: "alice", status: "waiting", body: "🙏 thanks — I'll keep drafting the auth outline" },
];
const ad = [
  { ts: "10:42", who: "dave", status: "working", body: "want me to stub the key so you can keep planning?" },
  { ts: "10:43", who: "alice", status: "waiting", body: "yes please — a no-op stub is perfect for now" },
];
const as = [{ ts: "10:40", who: "scout", status: "idle", body: "logged your block in #incidents" }];
const bd = [
  { ts: "10:09", who: "bob", status: "working", body: "merged your filter-subjects change" },
  { ts: "10:10", who: "dave", status: "working", body: "ty — running the suite now" },
];
const lm = [{ ts: "10:15", who: "maya", status: "idle", body: "sent the NATS v3 notes your way" }];
const DEMO = {
  roster: [
    { name: "alice", role: "planner", status: "waiting", tag: "needs input", act: "blocked — needs OPENAI_API_KEY", harness: "claude" },
    { name: "linus", role: "reviewer", status: "working", act: "reviewing PR #42 · auth guards", harness: "opencode" },
    { name: "bob", role: "builder", status: "working", act: "writing tests · channels.ts", harness: "claude" },
    { name: "dave", role: "builder", status: "working", act: "refactoring endpoint.ts", harness: "hermes" },
    { name: "maya", role: "researcher", status: "idle", act: "—", harness: "opencode" },
    { name: "scout", role: "observer", status: "idle", act: "watching #team.>", harness: "claude" },
  ],
  activity: [
    { type: "sys", text: "— scout joined · observer —" },
    { type: "msg", mode: "chat", ts: "10:38", who: "dave", role: "builder", target: "#general", body: "anyone else hit the flaky CI test on channels.ts?" },
    { type: "rollup", text: "14 status updates · bob, dave, linus, maya" },
    { type: "msg", mode: "chat", ts: "10:41", who: "bob", role: "builder", target: "#team.backend", body: "pushed channels.ts tests — 12 green ✓" },
    { type: "intent", ts: "10:46", who: "linus", note: "about to act", body: "will merge PR #42 once the review check passes" },
    { type: "msg", mode: "unicast", ts: "10:47", who: "alice", role: "planner", target: "→ bob", body: "can you take the API-key wiring while I'm blocked?" },
    { type: "msg", mode: "anycast", ts: "10:49", who: "—", target: "→ @reviewer", sub: "unclaimed · 3m", body: "review needed on PR #51 (channels hierarchy)" },
    { type: "msg", mode: "chat", ts: "10:51", who: "linus", role: "reviewer", target: "#team.review", body: "left 2 comments on PR #42 — small nits" },
  ],
  cards: [
    { tone: "amber", cat: "WAITING", age: "seen 4m", title: "alice is blocked", desc: "Needs OPENAI_API_KEY to keep planning the auth module.", primary: "Provide key", secondary: "Open thread" },
    { tone: "red", cat: "FAILED", age: "seen 1m", title: "bob's task failed", desc: "2 tests failing in channels.ts after the refactor.", primary: "Inspect", secondary: "Retry" },
    { tone: "orange", cat: "UNCLAIMED", age: "seen 3m", title: "Anycast request unhandled", desc: "@reviewer · review PR #51 — no peer has claimed it.", primary: "Assign…", secondary: "Claim" },
    { tone: "blue", cat: "APPROVAL", age: "seen just now", title: "dave requests approval", desc: "Wants to force-push to main — irreversible.", primary: "Approve", secondary: "Deny" },
  ],
  cv: {
    messages: [
      { ts: "09:58", status: "working", who: "bob", role: "builder", body: "scaffolded the hierarchical channel matcher — wildcard subtree works" },
      { ts: "10:05", status: "working", who: "dave", role: "builder", body: "endpoint.ts: collapsed the filter subjects, tests pass", thread: "💬 3 replies · last 2m" },
      { ts: "10:12", status: "idle", who: "maya", role: "researcher", body: "NATS v3 split transports cleanly — notes in #planning" },
      { type: "unread", text: "new since you were away · 4 messages" },
      { ts: "10:39", status: "working", who: "dave", role: "builder", body: "anyone seen the flaky CI test on channels.ts?" },
      { ts: "10:41", status: "working", who: "bob", role: "builder", body: "pushed channels.ts tests — 12 green ✓" },
      { ts: "10:44", status: "waiting", who: "alice", role: "planner", body: "drafted the auth outline; blocked on the API key though" },
    ],
    members: [
      { status: "working", name: "bob", role: "builder" },
      { status: "working", name: "dave", role: "builder" },
      { status: "waiting", name: "alice", role: "planner" },
      { status: "idle", name: "maya", role: "researcher" },
      { status: "idle", name: "scout", role: "observer" },
    ],
  },
  dmPeers: [
    { id: "alice", name: "alice", role: "planner", status: "waiting", unread: 2, threads: 3, conversations: [
      { with: "bob", role: "builder", status: "working", unread: 0, msgs: ab },
      { with: "dave", role: "builder", status: "working", unread: 1, msgs: ad },
      { with: "scout", role: "observer", status: "idle", unread: 1, msgs: as },
    ] },
    { id: "bob", name: "bob", role: "builder", status: "working", unread: 0, threads: 2, conversations: [
      { with: "alice", role: "planner", status: "waiting", unread: 0, msgs: ab },
      { with: "dave", role: "builder", status: "working", unread: 0, msgs: bd },
    ] },
    { id: "dave", name: "dave", role: "builder", status: "working", unread: 1, threads: 2, conversations: [
      { with: "alice", role: "planner", status: "waiting", unread: 1, msgs: ad },
      { with: "bob", role: "builder", status: "working", unread: 0, msgs: bd },
    ] },
    { id: "linus", name: "linus", role: "reviewer", status: "working", unread: 0, threads: 1, conversations: [
      { with: "maya", role: "researcher", status: "idle", unread: 0, msgs: lm },
    ] },
    { id: "maya", name: "maya", role: "researcher", status: "idle", unread: 0, threads: 1, conversations: [
      { with: "linus", role: "reviewer", status: "working", unread: 0, msgs: lm },
    ] },
  ],
};

function renderDemo() {
  $("space").textContent = "· demo";
  setConn(true);
  renderTiles({ working: 4, waiting: 1, idle: 2, offline: 1 }, "6m");
  $("online-c").textContent = "6";
  renderRoster(DEMO.roster);
  // Counts sum to 112 → the "all activity" total matches the reference.
  channels = new Map([
    ["general", { messages: 24, replay: true, deliveryClass: "durable" }],
    ["planning", { messages: 12, replay: true, deliveryClass: "durable" }],
    ["team.backend", { messages: 51, replay: true, deliveryClass: "durable" }],
    ["team.frontend", { messages: 18, replay: true, deliveryClass: "durable" }],
    ["team.review", { messages: 7, replay: true, deliveryClass: "durable" }],
    ["incidents", { messages: 0, replay: true, deliveryClass: "durable" }],
  ]);
  unread = new Map([["planning", 2], ["team.review", 1]]);
  renderSidebarNav();
  renderCenter();
  renderRail();
}

// ── Resizable sidebars ─────────────────────────────────────────────────────────
// Left nav + right rail widths are drag-adjustable and persisted per browser. The centre column is
// minmax(0,1fr), so it just absorbs the remainder; we only clamp the sides so the centre can't be
// squeezed away. Double-click a handle to reset that side.
const SIDES = {
  left: { cssVar: "--nav-w", key: "cotal.navW", def: 300, min: 200, max: 520, other: "right" },
  right: { cssVar: "--rail-w", key: "cotal.railW", def: 340, min: 240, max: 560, other: "left" },
};
const sideW = (side) =>
  parseInt(getComputedStyle(document.documentElement).getPropertyValue(SIDES[side].cssVar)) || SIDES[side].def;
function clampSide(side, px) {
  const s = SIDES[side];
  const hardMax = Math.min(s.max, window.innerWidth - sideW(s.other) - 360); // keep the centre ≥ 360px
  return Math.round(Math.max(s.min, Math.min(Math.max(hardMax, s.min), px)));
}
const applySide = (side, px) => document.documentElement.style.setProperty(SIDES[side].cssVar, px + "px");
function setupResizers() {
  for (const side of Object.keys(SIDES)) {
    const saved = Number(localStorage.getItem(SIDES[side].key));
    if (saved) applySide(side, clampSide(side, saved));
  }
  const bind = (id, side) => {
    const el = $(id);
    if (!el) return;
    el.onpointerdown = (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag");
      const startX = e.clientX, startW = sideW(side);
      const move = (ev) => applySide(side, clampSide(side, side === "left" ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX)));
      const up = () => {
        el.classList.remove("drag");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        localStorage.setItem(SIDES[side].key, String(sideW(side)));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    };
    el.ondblclick = () => (applySide(side, SIDES[side].def), localStorage.removeItem(SIDES[side].key));
  };
  bind("rz-left", "left");
  bind("rz-right", "right");
  // A shrinking window can leave a side too wide for the new centre floor — re-clamp both.
  window.addEventListener("resize", () => { for (const side of Object.keys(SIDES)) applySide(side, clampSide(side, sideW(side))); });
}

// ── Resizable nav sections (ONLINE / CHANNELS / DIRECT MESSAGES) ─────────────────
// Two vertical handles split the three stacked sections. Roster + channels carry explicit heights
// (persisted per browser); dms takes the remainder. Handle 1 (roster|channels) trades height
// between those two and leaves dms fixed; handle 2 (channels|dms) grows channels and shrinks the
// dms remainder. Double-click either handle to reset the split.
const NAV_MIN = { roster: 90, channels: 110, dms: 90 };
const NAV_HANDLES = 14; // two 7px handles
function setupNavResizers() {
  const nav = document.querySelector("aside.nav");
  const rosterSec = $("sec-roster"), channelsSec = $("sec-channels");
  if (!nav || !rosterSec || !channelsSec) return;
  const hOf = (el) => el.getBoundingClientRect().height;
  const setH = (cssVar, px) => document.documentElement.style.setProperty(cssVar, Math.round(px) + "px");

  // Handle 1: keep roster+channels sum constant so dms stays put.
  const dragRoster = (dy, r0, c0) => {
    const sum = r0 + c0;
    const roster = Math.max(NAV_MIN.roster, Math.min(sum - NAV_MIN.channels, r0 + dy));
    setH("--roster-h", roster);
    setH("--channels-h", sum - roster);
  };
  // Handle 2: grow channels; the dms remainder shrinks (floored at its min).
  const dragChannels = (dy, c0) => {
    const room = nav.clientHeight - hOf(rosterSec) - NAV_HANDLES - NAV_MIN.dms;
    setH("--channels-h", Math.max(NAV_MIN.channels, Math.min(room, c0 + dy)));
  };
  const persist = () => {
    localStorage.setItem("cotal.rosterH", String(Math.round(hOf(rosterSec))));
    localStorage.setItem("cotal.channelsH", String(Math.round(hOf(channelsSec))));
  };
  const reset = () => {
    document.documentElement.style.removeProperty("--roster-h");
    document.documentElement.style.removeProperty("--channels-h");
    localStorage.removeItem("cotal.rosterH");
    localStorage.removeItem("cotal.channelsH");
  };
  const bind = (id, onDrag, startVals) => {
    const el = $(id);
    if (!el) return;
    el.onpointerdown = (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag");
      const startY = e.clientY, vals = startVals();
      const move = (ev) => onDrag(ev.clientY - startY, ...vals);
      const up = () => {
        el.classList.remove("drag");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        persist();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    };
    el.ondblclick = reset;
  };
  bind("rz-roster", dragRoster, () => [hOf(rosterSec), hOf(channelsSec)]);
  bind("rz-channels", dragChannels, () => [hOf(channelsSec)]);

  // Restore persisted heights (px), clamped to the current nav height.
  const savedR = Number(localStorage.getItem("cotal.rosterH")), savedC = Number(localStorage.getItem("cotal.channelsH"));
  if (savedR || savedC)
    requestAnimationFrame(() => {
      const navH = nav.clientHeight;
      if (savedR) setH("--roster-h", Math.max(NAV_MIN.roster, Math.min(savedR, navH - NAV_MIN.channels - NAV_MIN.dms - NAV_HANDLES)));
      if (savedC) setH("--channels-h", Math.max(NAV_MIN.channels, Math.min(savedC, navH - hOf(rosterSec) - NAV_MIN.dms - NAV_HANDLES)));
    });
}

setupResizers();
setupNavResizers();
if (isDemo) {
  document.title = "Cotal · demo";
  renderDemo();
} else {
  fetch("/api/meta")
    .then((r) => r.json())
    .then((m) => {
      $("space").textContent = `· ${m.space}`;
      document.title = `Cotal · ${m.space}`;
    });
  refresh();
  connect();
}
