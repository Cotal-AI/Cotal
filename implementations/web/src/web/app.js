// Browser data controller for the Astro/React dashboard. Shared protocol helpers remain classic
// scripts so the graph and monitor use the same ordering, snapshot and part-rendering contracts.
let spaceName = "Connecting";
let connected = false;
let loading = true;
const listeners = new Set();
let snapshot;
let scheduled = false;
function publish() {
  snapshot = undefined;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; for (const listener of listeners) listener(); });
}
function setConn(value) { connected = value; publish(); }
function renderStale() { publish(); }
function renderRoster() { publish(); }
function renderSidebarNav() { publish(); }
function renderChannels() { publish(); }
function renderDMs() { publish(); }
function renderRail() { publish(); }
function renderCenter() { publish(); }
function refreshDerived() { publish(); }

const STATUS = ["working", "waiting", "idle", "offline"];


const MODES = ["chat", "unicast", "anycast"];

let channelDeleteSupported = false;

let roster = [];

let channels = new Map();

let unread = new Map();

let dms = [];

let selected = "*";

let dmSel = null;

let agentSel = null;

let activity = [];

let channelMsgs = [];

let feedOrder = window.COTAL_EVENT_ORDER.create();

let channelOrder = window.COTAL_EVENT_ORDER.create();

let orderNotes = [];

function noteOrder(notes) {
  for (const n of notes) orderNotes.push(n);
  if (orderNotes.length > 50) orderNotes = orderNotes.slice(-50);
}

let refreshing = null;


let modes = new Set(MODES);

let paused = false;

let expandAll = false;


const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const bodyText = (msg) => window.COTAL_PARTS.partsToText(msg.parts);

const MD = window.COTAL_MD;

let staleNow = [];


function setStale(stale) {
  staleNow = stale;
  renderStale();
}

function markStale(name, entry) {
  const rest = staleNow.filter((s) => s.name !== name);
  setStale(entry ? [...rest, entry] : rest);
}

function applyPresenceView(view) {
  if (!view || view.fresh) {
    markStale("roster", null);
    return;
  }
  if (view.state === "unpopulated") {
    markStale("roster", { name: "roster", reason: "observer presence snapshot still loading" });
    return;
  }
  const since = typeof view.staleSince === "number" ? new Date(view.staleSince).toISOString() : "unknown";
  markStale("roster", { name: "roster", reason: `observer presence watch silent since ${since}` });
}

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
      host: p.card.meta?.host,
      attention: p.attention, // open/absent both render as nothing
      tag: p.status === "waiting" ? "needs input" : null,
    }));
}

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

function nameIndex() {
  const idName = new Map();
  for (const p of roster) if (p.card?.id) idName.set(p.card.id, p.card.name);
  return idName;
}

function displayNameOf(x, idx) {
  if (!x) return "?";
  if (typeof x === "object") return displayNameOf(x.id, idx);
  if (idx.has(x)) return idx.get(x);
  // Principal ids are exactly two NATS-safe tokens, owner.actor. Keep the opaque owner for
  // namespace disambiguation, but require a long actor so ordinary dotted display names survive.
  const principal = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(x);
  if (principal && principal[2].length >= 32)
    return `${principal[1]}.${principal[2].slice(0, 6)}…`;
  return /^[A-Z2-7]{32,}$/.test(x) ? x.slice(0, 6) + "…" : x; // legacy bare identity
}

function dmPeers() {
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
      id: m.id,
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

function liveEntry(mode, msg, idx) {
  const fromId = msg.from?.id;
  const target =
    mode === "chat"
      ? `#${msg.channel ?? ""}`
      : mode === "unicast"
        ? `→ ${displayNameOf(msg.to, idx)}`
        : `→ @${msg.toService ?? ""}`;
  return {
    mode,
    ts: time(msg.ts),
    // who/role come from the roster by authenticated id; the payload's from.name/from.role are
    // sender-chosen display text and are never rendered (#1399).
    who: fromId ? displayNameOf(fromId, idx) : "?",
    role: fromId ? roleOf(fromId) : undefined,
    target,
    body: bodyText(msg),
  };
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
    .map((p) => {
      const wording = window.COTAL_PRESENCE.describe(p);
      return {
        tone: "amber",
        cat: "WAITING",
        age: wording.heartbeat,
        status: wording.status,
        title: `${p.card.name} is waiting`,
        role: p.card.role,
        // p.activity is the Claude Code Notification text (the actual blocking prompt/permission).
        desc: wording.activity || "No current activity reported",
        id: p.card.id, // makes the card a clickable drill-down into the Agent Detail view
      };
    });
}

function selectAgent(id) {
  agentSel = id;
  dmSel = null;
  selected = null;
  renderSidebarNav();
  renderRoster(); // light up the clicked peer
  renderCenter();
  renderRail();
}

let loadSeq = 0;

let shownChannel = null;

let selecting = null;

async function select(key) {
  agentSel = null;
  dmSel = null;
  selected = key;
  if (key !== "*") unread.set(key, 0);
  renderSidebarNav();
  renderRoster(); // clear any stale Agent Detail highlight
  if (key !== "*") {
    // SINGLE FLIGHT PER CHANNEL, for the reason the feed has one. `refresh()` calls `select(selected)`
    // on every poll, so two bootstraps for the SAME open channel overlapped routinely: the second
    // re-armed `channelOrder` while the first was still fetching, and the first machine, holding every
    // frame that arrived in that window, became unreachable. The staleness guard did not save it,
    // because returning early is exactly what left the buffer undrained.
    if (selecting && selecting.key === key) return selecting.promise;
    const seq = ++loadSeq;
    // HELD BEFORE THE CLEAR, and only when it belongs to THIS channel. A fresh selection must not
    // inherit the last channel's messages, so a switch holds nothing and starts empty as before.
    const held = shownChannel === key ? channelMsgs : [];
    channelMsgs = [];
    // ARMED BEFORE THE FETCH IS ISSUED, which is the whole ordering. Re-armed on every selection
    // because each one is a fresh two-phase bootstrap: a new history read, and a live tap that is
    // already delivering into it. Held in a LOCAL as well, so this bootstrap settles the machine it
    // armed even if a selection of a different channel has since rebound the global.
    const order = window.COTAL_EVENT_ORDER.create();
    channelOrder = order;
    let release;
    selecting = { key, promise: new Promise((r) => (release = r)) };
    renderCenter();
    // Same reason as the activity feed: a failed history read must not leave the boundary unpassed
    // and the frames of this channel held out of the view that was opened to look at them. What it
    // is NOT any more is an empty batch: it is the last history that was actually read, so a refused
    // poll on the open channel keeps what is on screen instead of emptying it.
    let msgs = [];
    let refused = null;
    try {
      // READ THROUGH THE SAME GATE AS EVERY OTHER SOURCE. This was the one read on either page that
      // still consumed a body without consulting the status, and it is the read behind the open
      // channel. A 500 here answers `{"error":"..."}`, which is valid JSON that `fetch` does not
      // reject, so the catch below never fired: the object was handed to the order machine as a
      // history, the channel drew empty, and nothing said why. Measured on the shipped code before
      // this line changed: last-good gone, no backfill-failed note, no stale mark.
      msgs = await window.COTAL_SNAPSHOT.readJson(
        await fetch(`/api/channels/${encodeURIComponent(key)}/history?limit=200`),
        `#${key} history`,
      );
    } catch (err) {
      // A REFUSED READ KEEPS WHAT THE READER ALREADY HAD, for the same reason the four polled
      // sources do. `refresh()` re-selects the open channel on EVERY poll, so on a link where the
      // read keeps missing, an empty batch here emptied the open channel once per poll. The held
      // messages take the place of the history that could not be read, which keeps the merge and
      // the ordering below identical to the successful path.
      refused = err && err.message ? err.message : String(err);
      msgs = held;
      noteOrder([{ type: "backfill-failed", channel: key, reason: refused }]);
    } finally {
      // SETTLED ON EVERY PATH, INCLUDING THE STALE ONE. A superseded load must not rebind the view it
      // no longer owns, and it must still drain the machine it armed; skipping the settle is what
      // orphaned frames. When the selection has moved on, the released rows are dropped with the rest
      // of that view, which is correct because the reader is no longer looking at that channel.
      const settled = order.backfill(msgs);
      if (seq === loadSeq) {
        noteOrder(settled.notes);
        // Same merge as the activity feed and for the same reason: chat that arrived live during this
        // fetch is only in `channelMsgs`, released frames are only in `settled.emit`, and an assignment
        // either way round drops one of them.
        const merged = settled.emit.slice();
        const ids = new Set(merged.map((m) => m && m.id));
        for (const m of channelMsgs) if (m && !ids.has(m.id)) merged.push(m);
        channelMsgs = merged.slice(-500);
        shownChannel = key;
        // SAID, NOT JUST KEPT. Retention without the mark shows old messages as though they were
        // current, which is the half of this rule that turns a silent wipe into a silent lie. Marked
        // per source: a refused history does not erase the poll's other marks, and a read that lands
        // clears this one without touching theirs.
        markStale(`#${key} history`, refused ? { kind: "refused", name: `#${key} history`, reason: refused } : null);
      }
      if (selecting && selecting.key === key) selecting = null;
      release();
    }
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
  renderRoster(); // clear any stale Agent Detail highlight
  renderCenter();
  renderRail();
}

async function refresh() {
  // ── ONE BOOTSTRAP AT A TIME, AND IT ALWAYS ENDS ─────────────────────────────────────────────────
  //
  // SINGLE FLIGHT. Arming a machine and settling it are two ends of ONE bootstrap, and this function
  // could previously be re-entered between them. The stock startup does exactly that: the file ends
  // with `refresh(); connect();`, and `connect()`'s open handler calls `refresh()` again, so a second
  // call re-armed `feedOrder` while the first was still fetching. The first machine, holding whatever
  // arrived in that window, was then unreachable: the settle ran on the NEW binding and the old
  // machine's buffer went with it. Measured on the shipped merge logic, a frame held on the first
  // machine was simply absent from the feed afterwards. A reconnect flap did it too.
  //
  // Overlapping callers now share the in-flight bootstrap instead of starting a rival one. A
  // concurrent duplicate would have re-fetched the same pages anyway, so nothing is lost by
  // coalescing, and the pairing of one arm to one settle is restored.
  if (refreshing) return refreshing;
  let release;
  refreshing = new Promise((r) => (release = r));
  // Captured before the first await: `onMessage` appends here while every request below is in flight,
  // and the settle rebinds `activity`.
  const live = activity;
  feedOrder = window.COTAL_EVENT_ORDER.create();
  // The batch the settle will use. Only the all-activity path fills it; every other path settles on
  // empty, which is the machine's specified empty-history arm rather than a shortcut.
  let batch = [];
  let activityPage = null;
  try {
    // ── A FAILED READ KEEPS WHAT IS ON SCREEN ─────────────────────────────────────────────────────
    //
    // This was a sequential chain of `(await fetch(u)).json()`, and both of its properties were
    // wrong on a slow link. A 500 body is valid JSON and `fetch` does not reject on one, so the
    // REFUSAL was assigned into `roster` / `channels` / `dms` as if it were the snapshot; and the
    // first read that did throw skipped every read after it, so one slow route emptied the feed and
    // left the rest of the page un-refreshed with nothing saying so. Measured against a broker
    // behind a 160ms link: `/api/activity` 500 `{"error":"timeout"}` produced
    // `Uncaught TypeError: activity is not iterable` fifteen times in twenty-five seconds.
    //
    // `refreshAll` reads all four concurrently, applies ONLY the ones that succeeded, and returns
    // what did not land. `apply` is the only writer, so a refusal cannot reach page state at all.
    const SNAP = window.COTAL_SNAPSHOT;
    // The all-activity backfill is a source ONLY when the reader is on all-activity. The other three
    // lenses settle the order machine on an empty batch, which is its specified empty-history arm,
    // and asking for a page nobody will draw is exactly the per-channel fan-out this change bounded.
    const onAllActivity = !agentSel && !dmSel && selected === "*";
    const stale = await SNAP.refreshAll([
      // The space name used to be a one-shot at boot with a bare `fetch().then((r) => r.json())`, so
      // a refusal arrived as data and the header read `· undefined` for the rest of the session:
      // the same defect as the rest of this change, on the one read that never came back to correct
      // itself. It is a source like any other now, so it is gated, named when it is stale, and
      // replaced by the next poll that lands. `/api/meta` is `{space, pid}` computed in process, so
      // reading it every poll costs no broker work.
      {
        name: "space",
        read: async () => SNAP.readJson(await fetch("/api/meta"), "space"),
        apply: (meta) => { channelDeleteSupported = meta.channelDeleteSupported === true; spaceName = meta.space; document.title = `Cotal · ${meta.space}`; },
      },
      {
        name: "peers",
        read: async () => SNAP.readJson(await fetch("/api/roster"), "peers"),
        apply: (v) => { roster = v; refreshDerived(); },
      },
      {
        name: "channels",
        read: async () => SNAP.readJson(await fetch("/api/channels"), "channels"),
        // L2 shape is flat {channel,messages,description?,replay,replayWindow?,deliveryClass}.
        // Tolerate a nested-config server briefly (pre-restart) without re-deriving defaults.
        apply: (list) => {
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
        },
      },
      {
        name: "direct messages",
        read: async () => SNAP.readJson(await fetch("/api/dms?limit=500"), "direct messages"),
        apply: (v) => { dms = v; },
      },
      // Read alongside the other three rather than after them, so a refusal on it is reported in the
      // same place instead of being swallowed, and so it no longer waits for them on a slow link.
      //
      // `/api/activity` answers an ENVELOPE now, never a bare array, and the shape change is a guard
      // rather than a nuisance: a caller that ignores `partial` breaks here instead of rendering a
      // short page as a complete one. NO TOLERANCE FOR A BARE ARRAY either, and that is not
      // pedantry: `[].entries` is a real Array METHOD, so a `page.entries ?? page` tolerance quietly
      // hands a FUNCTION to the merge when the answer is a list. It is read exactly one way.
      ...(onAllActivity
        ? [{
            name: "activity",
            read: async () => SNAP.readJson(await fetch(`/api/activity?limit=200`), "activity"),
            apply: (page) => { batch = page.entries; activityPage = page; },
          }]
        : []),
    ]);
    // A PARTIAL PAGE IS NOT A REFUSAL AND IS NOT SILENCE. The entries it carries are real and are
    // applied; what the reader is told is that some sources did not answer in time, which sources,
    // and how many did. Reported on the same marker as a refusal so there is one place to look.
    if (activityPage && activityPage.partial)
      stale.push({
        kind: "partial",
        name: "activity",
        reason: `${activityPage.read} of ${activityPage.of} sources answered within ${activityPage.deadlineMs}ms; missing ${activityPage.missing.map((m) => `${m} (${activityPage.reasons[m]})`).join(", ")}`,
      });
    const rosterView = staleNow.find((s) => s.name === "roster");
    if (rosterView && !stale.some((s) => s.name === "roster")) stale.push(rosterView);
    setStale(stale);
    // The order machine's own failure arm keeps its own note: a refused history read is what makes a
    // backfill incomplete, and the notice that draws it is about ordering. The other three sources
    // are carried by the stale pill and are not backfill failures, so they are not reported as ones.
    const backfillRefused = stale.find((s) => s.name === "activity" && s.kind !== "partial");
    if (backfillRefused) noteOrder([{ type: "backfill-failed", reason: backfillRefused.reason }]);
    renderSidebarNav();
    // THE BOUNDARY MUST PASS EVEN WHEN THE FETCH DOES NOT, and this is not a soft failure mode
    // invented here. `pending` is drained only by the settle, so a rejected request used to mean the
    // machine never settled and every frame held during it stayed invisible for the life of the page,
    // with nothing on screen saying so. That is strictly worse than what this code replaced, where a
    // failed fetch simply left the live arrivals in place.
    //
    // A failed history read IS an empty history batch: the machine already specifies that case, and
    // specifies that the baseline then comes from the earliest BUFFERED frame. So the boundary is
    // settled on empty rather than skipped, and the refusal is SURFACED (as a stale mark above and a
    // note here) instead of being swallowed. Reporting it is what keeps this from being a silent degrade.
    if (agentSel || dmSel) {
      renderCenter();
    } else if (selected !== "*") {
      select(selected);
    }
  } finally {
    // ── THE SETTLE, ON EVERY EXIT PATH ────────────────────────────────────────────────────────────
    //
    // IT USED TO RUN ONLY ON THE ALL-ACTIVITY BRANCH, while the arm ran unconditionally at the top.
    // So whenever the reader was on a channel, a DM or an agent, every live frame was held by a
    // machine that this function had armed and would never settle, and none of them reached the feed.
    // Switching back to all activity showed a feed that had never received them, and the next refresh
    // replaced the machine and took the buffer with it. A `finally` is the only placement that
    // survives all four branches plus a throw from anything between the arm and here. The source
    // reads no longer supply that throw, because a refusal is reported rather than propagated; the
    // renders below the reads still can, and the cost of missing it is the same.
    activity = batch;
    // Same trust rule as the live feed: the backfill is tagged with the channel the SERVER
    // requested, so the payload claim is overwritten at ingress rather than downstream.
    for (const e of activity) if (e?.msg) e.msg.channel = e.channel;
    // MERGED, NOT ASSIGNED OVER. This read `activity = await fetch(...)`, which DISCARDED every live
    // entry `onMessage` had appended while the fetch was in flight. Retention hid it: the backfill
    // re-read the same messages from the broker, so the overwritten arrivals came back. Event
    // channels are no longer in that backfill, by the server's filter, so for a frame there is
    // nothing to come back and the assignment would be a silent deletion of exactly the traffic this
    // lane exists to make visible. The two halves of this change are that tightly coupled: the filter
    // is what turns the pre-existing overwrite into a loss, and this is what makes the filter safe.
    const settled = feedOrder.backfill(activity);
    noteOrder(settled.notes);
    // Live frames were HELD by the machine and come back inside `settled.emit` in seq order; live
    // chat passed straight through and is only in `live`. Both have to survive, so the backfill is
    // the BASE and unseen live arrivals are appended after it, newest last, deduped by id against
    // what the backfill already carried.
    //
    // WHAT THIS ORDER DOES AND DOES NOT CLAIM. Frames of one chain are exactly ordered, by `seq`,
    // which is the claim this file exists to make. Where a released frame sits relative to a chat
    // message that arrived during the same fetch is approximate. It is deliberately not fixed by
    // sorting the merged rows on `ts`: a producer's clock is not its sequence, so two frames whose
    // timestamps disagree with their sequence numbers would be swapped back by that sort, trading the
    // guarantee for the cosmetic.
    const merged = settled.emit.slice();
    const ids = new Set(merged.map((e) => e && e.msg && e.msg.id));
    for (const e of live) if (e && e.msg && !ids.has(e.msg.id)) merged.push(e);
    activity = merged.slice(-500);
    renderCenter();
    refreshing = null;
    loading = false;
    publish();
    release();
  }
}

function onMessage(entry) {
  const { mode, msg } = entry;
  // TRUST IS DECIDED ONCE, HERE. The server sends the channel it took from the SUBJECT (a publish
  // grant is per-channel, so that token is covered by the minted grant); `msg.channel` is the
  // publisher's own claim and is backed by nothing. Overwrite the claim at this boundary so no
  // downstream reader — the channel list, the counts, the unread badges, the transcript — has to
  // know which of the two it is holding.
  //
  // THE ASSIGNMENT IS UNCONDITIONAL, AND THAT IS THE WHOLE FIX. This first read
  // `if (entry.channel) msg.channel = entry.channel;`, which FAILS OPEN: on `inst` and `svc` there
  // is no authoritative channel, so the guard was false and the publisher's claim SURVIVED. `tap()`
  // only JSON-decodes, so a DM or anycast payload can carry any `channel` string it likes — and
  // `msg.channel` is consumed below with NO MODE GATE, which filed that message into the named
  // channel's transcript and incremented its count. A sender could appear to post into a channel it
  // holds no publish grant for. Assigning unconditionally leaves a non-chat message with
  // `undefined`, which is the truth: it has no channel.
  //
  // A conditional trust rule is not a trust rule. "Overwrite when I have something better" leaves
  // the untrusted value in place exactly when the trusted one is missing.
  msg.channel = entry.channel;
  // ORDERED, NOT JUST DEDUPED. Message-id dedupe answers "have I seen this exact message"; it cannot
  // answer "is a frame missing between these two", because the thing that would say so is `seq`. A
  // frame arriving before the backfill it belongs after is HELD here and released by `backfill()` in
  // `seq` order; everything else passes through and is deduped by id exactly as before.
  const fed = feedOrder.live(entry);
  noteOrder(fed.notes);
  for (const e of fed.emit) {
    if (activity.some((a) => a.msg.id === e.msg.id)) continue;
    activity.push(e);
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
      // The selected-channel view runs the same race: `select()` fetches this channel's history with
      // the feed already open, so a live frame can arrive before the retained range it follows.
      const sel = channelOrder.live(msg);
      noteOrder(sel.notes);
      for (const m of sel.emit) {
        channelMsgs.push(m);
        if (channelMsgs.length > 500) channelMsgs.shift();
      }
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
  es.addEventListener("presence-view", (e) => applyPresenceView(JSON.parse(e.data)));
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("error", () => setConn(false));
}

function getSnapshot() {
  if (snapshot) return snapshot;
  const counts = Object.fromEntries(STATUS.map(status => [status, roster.filter(p => p.status === status).length]));
  const live = roster.filter(p => p.status !== "offline" && typeof p.ts === "number" && Number.isFinite(p.ts));
  const idx = nameIndex();
  const peers = dmPeers();
  const pe = dmSel && peers.find(p => p.id === dmSel.peer);
  const conversation = pe && (pe.conversations.find(c => c.with === dmSel.with) || pe.conversations[0]);
  snapshot = {
    space: spaceName, connected, loading, channelDeleteSupported,
    roster: roster.slice(), online: rosterRows(), counts,
    stalest: live.length ? window.COTAL_PRESENCE.heartbeatAge(Math.min(...live.map(p => p.ts))) : "—",
    channels: [...channels].map(([name, ch]) => ({...ch, name, unread: unread.get(name) || 0})),
    dmPeers: peers, selected, dmSel, agentSel,
    agent: roster.find(p => p.card.id === agentSel),
    rows: activity.map(e => ({...liveEntry(e.mode, e.msg, idx), id:e.msg.id})).filter(e => !e.mode || modes.has(e.mode)),
    channelRows: channelMsgs.map(m => ({id:m.id, ts:time(m.ts), status:rosterStatus(m.from?.id), who:displayNameOf(m.from?.id, idx), role:roleOf(m.from?.id), body:bodyText(m)})),
    members: [...new Set(channelMsgs.map(m => m.from?.id).filter(Boolean))].map(id => displayNameOf(id, idx)),
    conversation: conversation ? {...conversation, peerName:pe.name, withName:conversation.withName || conversation.with} : undefined,
    waiting: waitingCards(), stale: staleNow.slice(), orderNotes: orderNotes.slice(),
    modes:[...modes], paused, expandAll,
  };
  return snapshot;
}
async function deleteChannel(name) {
  if (!channelDeleteSupported || !name || name === "*") throw new Error("Channel deletion is unavailable in this session");
  const r = await fetch("/api/channel/delete", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({channel:name})});
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  channels.delete(name); unread.delete(name);
  activity = activity.filter(e => e.msg.channel !== name);
  await select("*");
}
window.COTAL_DASHBOARD = {
  getSnapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  select, selectAgent, selectDM, refresh, deleteChannel,
  setModes(value) { modes = new Set(value); publish(); },
  togglePause() { paused = !paused; publish(); },
  toggleExpand() { expandAll = !expandAll; publish(); },
  markdown: text => MD.render(text),
};
refresh();
connect();
setInterval(publish, 1000); // Advance displayed ages without polling the mesh.
