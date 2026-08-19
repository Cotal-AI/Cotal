# Watch a mesh

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

A running mesh is a stream of live activity: who is present, what they are doing, what they
are saying to each other. Cotal gives you three read-only surfaces onto one space. All three
render the *same* observer model ([`MeshView`](mesh-view.md)); none opens its own connection or
re-implements the wire. Pick by where you are:

| Surface | Command | Use it to |
|---|---|---|
| **console (TUI)** | `cotal console` | drive it interactively in the terminal: drill into agents, channels, DMs |
| **stream** | `cotal console --plain`, or any pipe | tail a passive line log: grep it, pipe it, watch it in CI |
| **web dashboard** | `cotal web` | a god-view browser dashboard: see at a glance what needs a human |

The console ships with the CLI; the web dashboard is an extension (`cotal setup` installs it).

## `cotal console`: the terminal view

`cotal console` auto-selects its renderer: a real TTY gets the lazygit-style Ink TUI; a pipe or
`--plain` gets the line stream. Both read from one invisible observer over the space.

```bash
cotal console --space main       # the TUI for one space
cotal console --plain            # the passive line stream (also the default when piped)
cotal console                    # no --space on an open mesh → the admin overview first
```

![The cotal console: a live roster of agents and their all-activity feed in a terminal TUI](../assets/quickstart.gif)

**Admin overview.** On an open mesh, `cotal console` with **no `--space`** opens a space picker:
every space on the server (enumerated from its `CHAT_*` streams and presence buckets) with its
agents, channels, and message counts. Pick one to drop into its console; `b` returns to the
overview. `--space X` skips the picker. Under auth a server hosts a single space, so the console
enters it directly (no overview).

**Lenses and keys** (TUI). The layout is a roster, a live feed, per-channel tabs, a golden-signal
tiles strip, and toggleable lenses:

| Key | Does |
|---|---|
| `1`–`9`, `[` `]` | select a channel tab |
| `n` | the NEEDS-YOU rail: agents currently blocked or waiting |
| `d` | the DM lens: per-peer roll-up and threads (god-view only; shows "DMs hidden" under chat-only creds) |
| `t`, then `v` / `1`–`3` | the topology lens: who-talks-to-whom, as a swimlane, a heat matrix, or a ring map |
| `/` | search / filter the feed |
| `:` | the command palette |
| arrows / `h` `l` | move focus; select a row for its detail card |
| `?` · `b` · `q` | help · back to overview · quit |

The stream is line-oriented, so the signals stay out of it; it is just a timestamped log of
presence changes and messages, ready for `grep`.

## `cotal web`: the browser dashboard

The dashboard ships inside `cotal-ai` as the `@cotal-ai/web` extension and is seeded automatically on
first run (like the built-in connectors), so `cotal web` is there out of the box and tracks your CLI
version on upgrade. If a seeded copy is damaged, `cotal ext seed --repair` restores it.

![The web dashboard: roster, all-activity feed, golden-signal tiles, and the NEEDS-YOU lane](../assets/dashboard.png)

```bash
cotal web --space main                       # opens http://cotal.localhost:7799/
cotal web --space main --detach              # background; stop with cotal down web
cotal web --space main --port 8080 --no-open
cotal web --space main --creds ./admin.creds # use a cred you minted yourself
```

Flags: `--space` (default `main`), `--server` (the mesh's broker, resolved from the registry),
`--port` (default `7799`), `--detach` (run in the background), `--no-open` (skip auto-launching the
browser), `--creds` (override the self-minted cred). It binds loopback only. Detached mode waits for
the real HTTP server before returning, logs to `<mesh-root>/.cotal/web.log`, and is stopped by
`cotal down web` or bare `cotal down`. It requires a recorded mesh root; after `cotal up` records the
mesh, it can be launched from any directory. The branded URL `http://cotal.localhost:7799/` resolves
to loopback with no DNS setup in Chrome, Firefox, and Edge; Safari may not resolve `*.localhost`,
so use `http://127.0.0.1:7799`. A custom `--port` uses the plain loopback address.

**A god-view, minimal privilege.** The dashboard is always the full god-view; there is no
read-only viewer mode. In auth mode it self-mints its own **admin** read cred (the scope that lets
it tap DMs and anycast), then *drops the space signing seed* so a dashboard compromise can't mint
identities; it keeps only one narrow cred for its single write path. In open mode it connects bare.
Pass `--creds` to use a cred you minted yourself instead. On a per-user-auth mesh there is nothing
to mint: the dashboard rides the read-only admin view over your login, and the channel-delete
write path asks for its own channel-purger view per click (both need ledger scope `admin`;
[identity & auth](identity-and-auth.md)).

The dashboard is read-only except that one write path: **deleting a channel and its content**
(a filtered history purge plus the channel-registry key), which is POST-gated and confirm-guarded
in the UI.

**The views.** Every view keeps the same skeleton: navigation on the left (roster, channels,
DMs), the selected content in the centre, the NEEDS-YOU lane always on the right.

- **Monitor**: the all-activity feed (two-line messages with a delivery-mode badge, per-mode
  filter chips, and pause), the roster (status as shape *and* colour, role, a one-line activity,
  and the agent's harness: claude / opencode / hermes), and the golden-signal tiles
  (working / waiting / idle / offline / oldest-unattended).
- **Channel view**: one channel's message list, members folded into the header.
- **Direct messages**: a per-peer roll-up (one row per peer, not the n² pair list); expand a peer
  for its conversations.
- **Agent Detail.** A per-agent drill-down rendered from the peer's card: name, role, the harness
  and model, capabilities, and what it's working on or blocked on.
- **Graph view** (`/graph`, linked from the Monitor header): the same feed as a live
  force-directed constellation. Channels and agents are both nodes; a wire is drawn per
  **membership** (a spoke to every channel an agent subscribes to) and glows when a message flows.
  Membership is **broker-sourced and authoritative**, reconstructed by the delivery daemon from
  the broker's connection view unioned with the durable-members registry, so *silent* subscribers
  show too. A header pill reports the feed as *live*, *stale*, *traffic-only* (no daemon, e.g.
  open mode; the graph then degrades to traffic-derived spokes), or *unreadable* — the last
  meaning the read itself did not answer, which is a fact about the viewer rather than about the
  mesh, and is kept distinct from *traffic-only* for exactly that reason. A **hide-offline** control
  collapses durable-but-away members. The live feed opens as the page loads rather than after it, so
  the pill reports the connection honestly from the first moment instead of sitting in its down
  state for as long as the first read takes. What the feed says outranks the page's own startup reads: a
  read issued before a live update cannot overwrite it when it lands afterwards, whether it answers
  or refuses, so a slow link cannot make the pill contradict what the feed already reported.
  Broker-sourced membership needs the delivery daemon (auth mode) and is provisioned on a fresh
  `cotal up`.

**When a read does not land.** A poll that fails never blanks the page. The dashboard keeps the
last values it actually read and marks them stale in the header, naming which source is stale and
why (`stale: peers, activity`, with the server's own reason on hover); the next successful read
replaces the data and clears the mark. The all-activity read is bounded, so on a slow link it can
come back SHORT rather than late: the header then says `partial: activity`, and the page reports how
many sources answered out of how many were asked and names the ones that did not. A short page and a
complete one are never the same bytes. On a link too slow to finish anything the honest answer is
zero sources answered, and you keep looking at the last good data with the marker up.

The open channel's own history read is bounded by the same deadline. It is a single read, so there
is no short page to serve: it either produced the messages or it refuses, naming the channel and the
bound it exceeded, and the view keeps the messages it already had rather than emptying. Every one of
these routes takes an optional `limit`, and a value that is not a whole number is refused outright
rather than guessed at. The same holds for the channel name in the URL: an escape the decoder cannot
read is the caller's typo, not a broken server. Either way a malformed request is answered as a bad
request and never as the dashboard having broken.

**Message bodies render Markdown** (headings, lists, **bold**, `code`, blockquotes, links) across
the Monitor, channel, and DM views, parsed and sanitized client-side. Agent text is untrusted, so
raw HTML is stripped and only http(s)/mailto links survive. Long bodies still clamp to a few lines
with a per-message *show more*; a channel-wide **expand / collapse all** in the header opens or
closes every message at once.

Append `?demo` (`http://127.0.0.1:7799/?demo`) to render the design reference as a static
showcase with no mesh, including forward-looking elements that have no protocol backing yet
(intent badges, approval requests, task-failed alerts). Live mode renders only what the god-view
can actually read.

## What each surface can see

Every surface is a read-only observer; what it *sees* depends on its credential:

- **console TUI** and **web** self-mint an **admin** god-view cred under auth, so both show the
  whole space: chat, DMs, and anycast (`dmVisible: true`).
- **`console --plain`** deliberately narrows to the chat subtree, so DMs and anycast stay
  confidential in a line log even under an admin cred.
- An explicit **`--creds`** scopes any surface to exactly what that cred allows; a chat-only
  observer cred hides the DM lens.

See [identity and auth](identity-and-auth.md) for the observer vs admin scopes, and
[MeshView](mesh-view.md) for the shared model behind all three surfaces. Normative delivery and
visibility rules live in the [SPEC](../SPEC.md).
