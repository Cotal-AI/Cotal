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
| `p` / `D` | pause–resume / kill the selected agent (control-gated, below) |
| arrows / `h` `l` | move focus; select a row for its detail card |
| `?` · `b` · `q` | help · back to overview · quit |

**Operator control.** Watching stays read-only, but the console can also drive the
[manager](architecture.md#manager-agent-supervisor): the observer endpoint never carries
control; each action makes its own tier-scoped request. On an auth mesh the console mints a
per-action, five-minute control cred from the trust material it holds (its own god-view cred
stays read-only); on an open mesh it goes bare; an explicit `--creds` is used as-is. That gate
is `canControl`, distinct from `canWrite` (chat publishes). Affordances follow how destructive
they are: `p` pauses or resumes with no confirm (recoverable; the roster shows a `⏸ paused`
badge merged from a low-rate `ps` poll, since a frozen agent's presence reads offline), `D`
kills behind a confirm (`y` graceful stop, `f` force-kill), and the `:` palette adds
`spawn <persona> [name]`, `status <agent>`, `ps`, and `purge` (type the space name to confirm,
like the space delete).

**Operator participant mode.** By default the operator is invisible, and a message it sends is
one-way: an agent's DM reply has no inbox to land in. On the operator's **first send** (`:dm` /
`:call` / `:ask` / `:msg`, or a compose) the console lazily upgrades itself: it registers
presence so the operator joins the roster as a `role:"operator"` peer agents can reply to, and
the DM lens starts capturing the operator's own inbox. Outbound DMs are recorded locally so a
thread shows both sides, and the operator leaves cleanly (offline presence) on exit. This is
`canWrite`-gated, so a pure-watch session never registers; it works where the console can send —
an open mesh, or an auth mesh with a capable `--creds`. Under the auth-default read-only
god-view cred the console cannot send at all, so participant mode never activates there (a
dedicated auth `participant` cred profile is future work).

The stream is line-oriented, so the signals stay out of it; it is just a timestamped log of
presence changes and messages, ready for `grep`.

## `cotal web`: the browser dashboard

The dashboard ships as the `cotal-web` extension. `cotal setup` installs it automatically; if
that step was skipped, run `cotal ext add cotal-web` and the `web` command appears in the CLI.

![The web dashboard: roster, all-activity feed, golden-signal tiles, and the NEEDS-YOU lane](../assets/dashboard.png)

```bash
cotal web --space main                       # opens http://cotal.localhost:7799/
cotal web --space main --port 8080 --no-open
cotal web --space main --creds ./admin.creds # use a cred you minted yourself
```

Flags: `--space` (default `main`), `--server` (the mesh's broker, resolved from the registry),
`--port` (default `7799`), `--no-open` (skip auto-launching the browser), `--creds` (override the
self-minted cred). It binds loopback only. The branded URL `http://cotal.localhost:7799/` resolves
to loopback with no DNS setup in Chrome, Firefox, and Edge; Safari may not resolve `*.localhost`,
so use `http://127.0.0.1:7799`. A custom `--port` uses the plain loopback address.

**A god-view, minimal privilege.** The dashboard is always the full god-view; there is no
read-only viewer mode. In auth mode it self-mints its own **admin** read cred (the scope that lets
it tap DMs and anycast), then *drops the space signing seed* so a dashboard compromise can't mint
identities; it keeps only one narrow cred for its single write path. In open mode it connects bare.
Pass `--creds` to use a cred you minted yourself instead.

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
  show too. A header pill reports the feed as *live*, *stale*, or *traffic-only* (no daemon, e.g.
  open mode; the graph then degrades to traffic-derived spokes). A **hide-offline** control
  collapses durable-but-away members. Broker-sourced membership needs the delivery daemon (auth
  mode) and is provisioned on a fresh `cotal up`.

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
