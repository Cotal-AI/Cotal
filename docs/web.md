# `cotal web`: observability dashboard

> A read-only browser **god-view** of one space: who is online, what they are doing, the
> channels, the direct messages, and the live feed. It sees everything (chat, DMs, anycast),
> but never publishes, needs no manager, and binds only to loopback.

```bash
pnpm cotal web --space demo            # opens http://127.0.0.1:7799 in your browser
pnpm cotal web --space demo --port 8080 --no-open
pnpm cotal web --space demo --creds ./admin.creds   # use a cred you minted yourself
```

In **auth mode** (`.cotal/auth` present) `web` self-mints its own read-only **admin** cred.
Like `cotal spawn`, it holds the space signing key, so no manual `--creds` is needed; the
admin scope is what lets it tap DMs and anycast. Pass `--creds` to override with a cred you
minted yourself. In **open mode** it connects bare. There is **no read-only viewer mode**;
the dashboard is always the full god-view.

The dashboard is read-only. To purge retained history from a running space, use `cotal
history clear --force [--dms]`.

Flags: `--space` (default `main`), `--server` (default local NATS), `--port` (7799),
`--no-open` (skip auto-launch), `--creds` (override the self-minted NATS credentials).

## How it works

One `CotalEndpoint` started as a pure observer: `registerPresence:false` so it is invisible
to peers, `watchPresence:true` so it sees the roster, and an **admin** cred so it can tap the
whole space. A `node:http` server serves the static page and bridges mesh → browser over
**SSE**:

- `GET /` · `/app.js`: the Monitor page (`src/web/index.html`, `src/web/app.js`)
- `GET /graph` · `/graph.js`: the Graph view (`src/web/graph.html`, `src/web/graph.js`) — same
  feed, rendered as a live constellation (see [Graph view](#graph-view))
- `GET /feed`: SSE stream; `roster` events on presence change, `message` events for every
  comm tapped on the space (chat / unicast / anycast)
- `GET /api/meta`: `{ space }`
- `GET /api/roster`: current presence
- `GET /api/channels`: channels plus message counts
- `GET /api/channels/:name/history`: backlog for one channel
- `GET /api/activity`: recent history (mode-tagged `{mode, msg}`) merged across channels and
  DMs, to **backfill** the all-activity feed (the live tap only carries messages from after a
  client connects)
- `GET /api/dms`: DM history for the Direct-messages lens; the client groups it by peer

All of it is read from the mesh's own presence KV and JetStream history, with no extra state.

## The view

The skeleton is the same on every view: **left** is navigation (roster, channels, DMs),
**centre** is the selected content, **right** is the NEEDS YOU lane (always).

- **Header:** brand, space, a `live` pill, and golden-signal tiles (working / waiting / idle
  / offline / oldest-unattended). `waiting` is emphasized because it is the count that needs a
  human.
- **Roster:** status as shape *and* colour (`● ◐ ○ ⊘`, never colour alone), role, a one-line
  activity, and a small brand-coloured **harness** logo (claude / opencode / hermes). Waiting
  peers are highlighted, tagged, and accent-bordered. Click a peer (or press Enter/Space on it)
  to open its **Agent Detail** card in the centre.
- **Channels:** flat dotted names with an unread/mention pill and a dimmed total; click one to
  open the **Channel view** (its message list; members fold into the header).
- **Direct messages:** a per-peer roll-up (one row per peer, *not* the n² pair list). Expand a
  peer to its conversations, click one for the thread in the centre. Recipients resolve to
  names where known (a short identity id otherwise).
- **Feed (Monitor):** two-line messages (meta plus body) with a delivery-mode badge, filter
  chips per mode, and pause (freeze auto-scroll). Unicast targets resolve to the recipient's
  name (a short identity id only when it's unknown), not the raw instance id.
- **Agent Detail:** a per-agent drill-down (from the roster or a NEEDS YOU card) rendering the
  peer's AgentCard — name, role, kind, the **harness** it runs on (`meta.connector`, shown as a
  brand logo pill: claude / opencode / hermes), the **model** when known (`meta.model` — the
  operator's pin, else auto-detected from Claude's SessionStart hook), description, capability
  tags, current activity / what it's blocked on, and its
  full instance id. Fields absent from the card are simply omitted.
- **Needs you:** agents currently blocked or waiting, newest first. **Persistent on the
  right** across every view, so the attention lane never disappears on drill-in.

## Graph view

`GET /graph` (linked from the Monitor header, **Graph view →**) renders the same observer feed
as a live **force-directed constellation** — a second lens on one space, not a separate
data source. Channels and agents are both nodes; the wires between them are the traffic.

- **Nodes:** channels are bright **hubs**, agents are smaller orbs coloured by status (working
  / waiting / idle / offline, the same palette as the Monitor). Waiting agents pulse.
- **Wires = membership:** an agent has a spoke to **every channel it's subscribed to**, drawn
  from its self-reported presence `channels` (so a silent subscriber still shows, on any channel
  class). A wire is faint at rest and **glows when a message flows** along it. A channel post
  sends a comet from the sender into the hub, the hub blooms, then the post **fans out** to every
  other subscriber on the channel (a real broadcast). A direct message is a curved comet between
  the two peers; an anycast blooms at the sender.
- **Layout:** the simulation cools to a rest state and only gently **re-heats on a structural
  change** (a node or wire appears/disappears), so the constellation settles and messages drive
  *glow*, not motion. Drag to pan, scroll to zoom, click a node for its detail card; the camera
  auto-fits until you take over.
- **Controls:** per-mode filter chips (channel / direct / anycast) and pause, mirroring the
  Monitor feed.

**Membership comes from presence, not a privileged read.** Channels delivered `live` keep no
enumerable subscriber roster, and the durable members registry is a privileged manager-only read
the observer can't make — so each agent **self-reports the channels it reads** in its presence
record (`Presence.channels`, SPEC §6), and the graph draws a spoke per reported channel. This
works on every channel class and shows silent subscribers, with no special credential. A spoke
also appears if an agent *posts* to a channel it hasn't reported (a non-subscriber broadcast), and
a DM wire appears once two peers have messaged. Spokes persist (faded) while both endpoints are
present, drop when an agent leaves the channel or goes offline — never on a timer. Instance ids
are per-session, so only present agents are linked; stale ids from history are dropped.

## Design

The visuals come from a Penpot file, page **"Cotal — Monitor"**. The dashboard implements the
*Monitor* and *Channel View* frames faithfully (Work Sans, the exact palette, spacing, and
components) plus a *DM View* frame for the Direct-messages lens and an *Agent Detail* frame (the
per-agent drill-down, rendered live from the peer's AgentCard). Every view keeps NEEDS YOU on
the right (the needs-you lane is non-negotiable).

**`?demo`, the reference scene.** Append `?demo` (`http://127.0.0.1:7799/?demo`) to render
the Penpot frames' exact mock content as a static showcase, with no mesh needed. Click a
channel for the *Channel view*, or a peer under DIRECT MESSAGES for the *DM* thread. It
includes the forward-looking elements that have no protocol backing yet: the *intent* badge,
status-update rollups, threaded replies, the "new since you were away" marker,
per-conversation unread counts, and the FAILED / UNCLAIMED / APPROVAL alert tiers with their
action buttons. Use it to show or check the design.

**Live mode renders what the god-view can read:** the chat / unicast / anycast feed; the
golden-signal tiles (oldest-unattended from the oldest waiting peer); WAITING cards (from
peers in `waiting`); the Channel view (history plus a member count from the channel's
authors); and the Direct-messages lens (grouped from DM history, names resolved where known, a
short identity id otherwise). The richer alert tiers, intent and rollup rows, threads, and
per-conversation unread need task/approval/read state the observer does not have: a protocol
change first, a UI change second.
