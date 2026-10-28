# Watch a mesh

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

Cotal's watch surfaces show who is present, their reported activity and the messages your
credential permits you to read. The terminal console and plain stream share the CLI's
[`MeshView`](mesh-view.md). The web dashboard owns a separate endpoint and serves HTTP
snapshots and live events. The console also provides authorized operator actions.

| Surface | Command | Use it to |
|---|---|---|
| **web dashboard** | `cotal service start web` after explicit configuration | a god-view browser dashboard: see at a glance what needs a human |
| **console (TUI)** | `cotal console` | drive it interactively in the terminal: drill into agents, channels, DMs |
| **stream** | `cotal console --plain`, or any pipe | tail a passive line log: grep it, pipe it, watch it in CI |

The web dashboard ships inside `cotal-ai` and is seeded automatically; the console ships with
the CLI.

## Terminal console

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
overview. `--space X` skips the picker. On an authenticated mesh the console enters the
resolved space directly. This scopes the view; a broker can host several accounts and spaces.
`D` deletes the selected space once you type its name. A space this
host registered as a static-auth mesh on that server is deleted under a teardown minted from its trust
material, which names the resume transfer buckets the space holds at that moment; any other space is
deleted under the console's own connection, bare on an open mesh or your `--creds` file.

**Lenses and keys** (TUI). The layout is a roster, a live feed, per-channel tabs, a golden-signal
tiles strip, and toggleable lenses. The roster and DM peer list share the same pane sizing:
side by side with content on wide terminals, stacked above it below 80 columns.

The keys are:

| Key | Does |
|---|---|
| `1`–`9`, `[` `]` | select a channel tab |
| `n` | the NEEDS-YOU rail: agents currently blocked or waiting |
| `d` | the DM lens: per-peer roll-up and threads (god-view only; shows "DMs hidden" under chat-only creds) |
| `t`, then `v` / `1`–`3` | the topology lens: who-talks-to-whom, as a swimlane, a heat matrix, or a ring map, with the broker's own membership overlaid when the delivery daemon serves it (a header pill reads live, stale, traffic-only, or unreadable) |
| `/` | search / filter the feed |
| `Ctrl-P` | the modal command palette |
| `D` | kill the selected agent (control-gated, below) |
| arrows / `h` `l` | move focus; select a row for its detail card |
| `?` · `b` · `q` | help · back to overview · quit |

Press Enter on a selected agent or message to open its detail card. On a short terminal,
the card is clipped at the bottom rather than squeezing its rows together. Enlarge the
terminal to see the rest, or press any key to close the card.

List selections stay within the current rows when a list shrinks or empties. Empty-list key
presses do not leave a negative selection when rows arrive. The topology swimlane follows new traffic
while the last row is selected; moving up pauses that following until you return to the end.

**Operator control.** Watching stays read-only, but the console can also drive the
[manager](architecture.md#manager-supervision). The observer endpoint never carries
control: each action is one call through the same per-action path `cotal stop`, `cotal ps`, and
`cotal spawn --detach` take. It resolves the mesh, mints a one-shot instrument (or connects bare
on an open mesh, or rides your bearer on a user-auth mesh), calls the manager over the endpoint
rails, and keeps nothing. That gate is `canControl`, decided by whether that path can produce a
caller at all (a raw `--creds` file cannot), and it is independent of `canWrite`, which gates
chat. `D` kills the selected agent behind a confirm (`y` graceful stop, `f` force-kill), and the
`Ctrl-P` palette adds **Spawn agent** (waits for the join, like `cotal spawn --detach`),
`status <agent>`, `ps`, `purge` (type the space name to confirm, like the space delete), and
`delchan <channel>` (type the channel name to confirm). Channel deletion calls core's
`clearChannel`, which purges the channel's history and removes its registry entry. It uses a
one-shot `channel-purger` credential minted from the
resolved mesh's seed on a static mesh, a `channel-purger` view on a user mesh, a bare connection
on an open one; no manager is involved. A wildcard is refused, so the one destructive control
names one channel. A refusal, from the broker, the manager, or a user mesh's login, lands on the
status line, and so does selecting a palette action the session cannot take: a row marked
`read-only` (no publish permission) or `no control path` answers Enter with that refusal. Targeted actions (`D`, `status`, and `a`) locate the manager hosting the seat.
On static-auth and open meshes, `ps` gathers and merges the managers' rows. A silent manager's
last known rows remain marked as silent; a manager's error withholds its old rows. The
user-auth console uses the bearer-backed owner route for `ps` rather than this scatter.
Untargeted `spawn` and `purge` use manager resolution without an instance pin; a routing
refusal is shown rather than silently choosing a different manager.

Choose **Spawn agent** in the palette to open the launch form. Searching for `spawn` or
`new agent` finds the same action. Set an application, persona,
model, name and optional first request, then choose **Launch agent**. Empty application,
model and name fields keep the CLI's native defaults. Events are off by default in the
console and can be enabled in the form. A space that requires events refuses an explicit
opt-out. The form runs `spawn --detach` and reports its joined receipt or failure. An
unconfirmed outcome must be inspected before another launch. The agent runs in the background;
use the roster's attach action where supported. `Esc` returns from the form to the palette.
The modal palette replaces the old `:` shortcut.
Complete typed commands such as `spawn <persona> [name]` still work.

Selecting `dm` or `call` lists agents and endpoints. `attach` and `status` list seats from
the manager, including seats absent from presence. `msg` and `delchan` list channels;
`ask` lists advertised roles. Use the arrows and Enter to choose. Messaging commands then
wait for text before sending. You can also type a complete command, or use Tab to complete
an `@agent` or `#channel` token. Empty lists and manager read failures are shown in the palette.

`a` on a roster agent (or `attach <agent>` in the palette) suspends the console and hands the terminal to the
seat: it is `cotal attach` run in place, the same one-use holder-bound mesh session, the same
reconnect on a lost link, the same end reasons, with the observer running in the background
throughout. `Ctrl-]` (or `COTAL_DETACH_KEY`) returns and repaints the console, and the verdict
lands on the status line: detached, the seat is gone, or why it could not attach. A bad
`COTAL_DETACH_KEY` is refused before the screen is handed over. Attach is `canControl`-gated and
needs a `pty` seat. Session redemption follows the registered mesh mode: open meshes use a
bare connection, static-auth meshes require the space's local signing material, and user-auth
meshes redeem the grant through the identity service. A user-auth attach does not use a local
static seed.

**Operator participant mode.** By default the operator is invisible, and a message it sends is
one-way: an agent's DM reply has no peer to land on. On an open mesh, the operator's **first send**
(`dm`, `call`, `ask`, `msg`, or a compose) puts the operator on the roster: the console starts
a second, presence-only endpoint carrying the observer's own card (the same id, name, and
`role: "operator"`, so it is the `from` of everything the observer sends), the status bar says
`on roster` for the rest of the session, and the god-view tap the console already runs shows the
replies in the DM lens. The heartbeat survives a broker
reconnect, and the operator leaves cleanly (an offline record) on exit. This is `canWrite`-gated,
so a pure-watch session never registers, and a peer the broker refuses stays invisible, blocks that
send, and leaves the refusal on the status line so the operator is never told replies can land when
they cannot. Concurrent sends wait for the same startup result; the next later send retries after a
refusal. Under auth the console does not upgrade: the read-only default cannot
send at all, and an agent-grade `--creds` holds no live read of its own DM inbox (DMs ride its
lifecycle-keyed durable, which the observer does not consume), so a send there is one-way and the
status line says so once. An auth participant needs a credential profile that can publish
presence and chat and read its own inbox; that profile does not exist yet.

The stream is line-oriented, so the signals stay out of it; it is just a timestamped log of
presence changes and messages, ready for `grep`.

## Web dashboard

The dashboard ships as the `@cotal-ai/web` service preset. It is not part of stack startup. The
service requires a registered static-auth root, an existing protected credential file
and explicit read-only intent. It never substitutes a cached operator login, an account signer or
an open connection. User-auth targets require a supported caller handoff and remain unavailable in
this route. See the [CLI service instructions](cli.md#web-dashboard) for the complete limits. A page file the
dashboard cannot read is answered with a `500` that names the failed read.

![The web dashboard: roster, all-activity feed, golden-signal tiles, and the NEEDS-YOU lane](../assets/dashboard.png)

```bash
cotal service add web --preset web --space main --root /absolute/registered/root --creds /absolute/private/dashboard.creds --read-only
cotal service start web --space main
cotal service logs web --space main
cotal service stop web --space main --yes
```

The native child checks the file's signature, matching user key and current validity against the
registered root's full validated static trust chain and current signing key before claiming PID
custody. No alternate signer or cached credential replaces a mismatch; a user-auth or stripped-
signer-only root is unsupported. Native broker admission remains a separate requirement.
The child retains the broker's registered TLS requirement. Its browser listener remains HTTP; broker TLS does not encrypt remote browser traffic. Its process-initialization phase
follows the HTTP listener and signal handlers, not a new authenticated endpoint reply. `host` and
`port` are definition options: the defaults are `127.0.0.1` and 7799; wildcard hosts and port 0
refuse. It starts no dependency and opens no browser automatically.

The bootstrap URL and readiness credential stay in an owner-private create-only session record
bound to the full instance and launch request. Logs contain its reference path only. Read that
private file locally and open its single-use link in the browser/profile you intend to use.
Opening it exchanges the token for an HttpOnly, same-site session cookie. Another browser cannot
reuse a spent token. The session belongs to its origin; localhost names and literal loopback
addresses do not share it. Confirmed native close removes only the unchanged original private
record. Do not upload it or paste its contents into logs.

This service is explicitly read-only. The page says so and hides delete; the server independently
refuses channel-delete requests before acquiring mutation authority or using another transport.
The broker enforces what the selected file may observe, so a restricted read is not an empty mesh
or proof that a hidden DM does not exist. `channel remove` remains a separate authorized CLI action.
An old cached web command requires the matching extension update, not an implicit reinstall.

**The views.** Every view keeps the same skeleton: navigation on the left (roster, channels,
DMs), the selected content in the centre, the NEEDS-YOU lane always on the right.

- **Monitor**: the all-activity feed (two-line messages with a delivery-mode badge, per-mode
  filter chips, and pause), the roster (status as shape *and* colour, role, a one-line activity,
  and the agent's harness: claude / opencode / hermes), and the golden-signal tiles
  (working / waiting / idle / offline / stalest live heartbeat). The roster groups live peers by the
  machine each one reports as its host, with a count per machine, so placement across machines
  reads at a glance. A peer that reports no host, such as a manager, is listed last under *host
  not reported*. Seats do not report which manager runs them, so the roster has no manager grouping.
- **Channel view**: one channel's message list, members shown in the header.
- **Direct messages**: a per-peer roll-up (one row per peer, not the n² pair list); expand a peer
  for its conversations. Threads key on authenticated ids, and every shown name, role, and status
  comes from the roster by id, never from the message payload.
- **Agent Detail.** A per-agent drill-down rendered from the peer's card: name, role, the harness
  and model, capabilities, and what it's working on or blocked on.
- **Graph view** (`/graph`, linked from the Monitor header): the same feed as a live
  force-directed constellation. Channels and agents are both nodes; a wire is drawn per
  **membership** (a spoke to every channel an agent subscribes to) and glows when a message flows.
  Membership is **broker-sourced and authoritative**, reconstructed by the delivery daemon from
  the broker's connection view unioned with the durable-members registry, so *silent* subscribers
  show too. A header pill reports the feed as *live*, *stale*, *traffic-only* (no daemon, e.g.
  open mode, where the graph degrades to traffic-derived spokes), or *unreadable*. The last
  meaning the read itself did not answer, which is a fact about the viewer rather than about the
  mesh, and is kept distinct from *traffic-only* for that reason. A **hide-offline** control
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
replaces the data and clears the mark.

**When the observer itself goes deaf.** Presence liveness is derived from heartbeat timestamps, so
a watch that hears nothing for longer than the TTL used to flip every peer `offline` at once. The
sidebar is an online-only list, so the page emptied while the browser's connection pill stayed
live: that pill is the local SSE link, not the observer's upstream. Whole-bucket silence past
TTL is now a fact about the *view*: the header says `stale: roster` (`observer presence watch
silent since T`) and the last-known online list stays on screen until the watch delivers again.
A single peer whose own heartbeat lapses while the watch is live still drops out. A stall
shorter than TCP-level detection never reconnects, which is why this is a freshness gate on the
watch rather than a `connection` event.

**How the all-activity page is ordered.** When the page loads, the dashboard reads the newest chat
messages in the order the broker stored them and the newest direct messages, orders the two sets
together by `ts`, the time each sender wrote into its message, and keeps the newest of them. Chat
and direct messages are stored in separate streams with no arrival order in common, so `ts` is the
one key both carry. Where a sender's clock disagrees with the broker, messages can appear in an
order different from the one they arrived in. Messages with the same `ts` keep the order the broker
stored them in, and chat comes before direct messages.

The all-activity read is bounded by an 8000 ms deadline, so on a slow link it can
come back SHORT rather than late: the header then says `partial: activity`, and the page reports how
many sources answered out of how many were asked and names the ones that did not. Each missing source
also carries its reason in the response's `reasons` and in the line the server prints: `the read did
not finish within <deadline>ms` when the deadline cut it, or `the read failed:` and the error when it was
refused, such as a chat read whose filter list exceeds the broker's `max_payload`. A short page and a
complete one are never the same bytes. On a link too slow to finish anything the honest answer is
zero sources answered, and you keep looking at the last good data with the marker up. When the
deadline wins, Cotal also cancels the unfinished history pulls and removes their ephemeral consumers;
an abandoned poll does not keep occupying the link and starve the next one.

The open channel's own history read is bounded by the same deadline. It is a single read, so there
is no short page to serve: it either produced the messages or it refuses, naming the channel and the
bound it exceeded, and the view keeps the messages it already had rather than emptying. A sparse
channel (fewer messages than the page) is bounded by that channel's own first and last matching
sequences, not by walking the stream back to sequence 1. Every one of
these routes takes an optional `limit`, and a value that is not a whole number is refused outright
rather than guessed at. The same holds for the channel name in the URL: an escape the decoder cannot
read is the caller's typo, not a broken server. Either way a malformed request is answered as a bad
request and never as the dashboard having broken.

A refusal names the value it received, and it renders that value so you can read it. Characters that
would otherwise be invisible, rearrange the text around them, or mark part of it as an annotation
come back as their escape in both the response and the line printed in the terminal, so what you
read is what was actually sent. Ordinary text, accents and non-Latin scripts included, is left
alone: a character that renders as itself is left as itself.

Channel reads accept dotted segments of letters, digits, `_` and `-`, or a `*` or `>`
where the mesh reads a subtree. Invalid names are refused rather than rewritten into a
different channel. Read routes reject announced request bodies with `413` and close that
connection. A request refused by the session gate is also closed if it announced a body.
Ordinary bodyless requests keep their connection.

The service route refuses channel deletion. The older embedded web handler retains a
separate delete route with an 8 KiB body limit and no wildcard targets; that route is not
an operator action in the current service. Use the console or the authorized CLI
`channel remove` command to delete a channel.

**Message bodies render Markdown** (headings, lists, **bold**, `code`, blockquotes, links) across
the Monitor, channel, and DM views, parsed and sanitized client-side. Agent text is untrusted, so
raw HTML is stripped and only http(s)/mailto links survive. A peer's name, role and activity show
as plain text, including inside an attribute such as the activity's hover title. Long bodies still
clamp to a few lines
with a per-message *show more*; a channel-wide **expand / collapse all** in the header opens or
closes every message at once.

Append `?demo` (`http://127.0.0.1:7799/?demo`) to render the design reference as a static
showcase with no mesh, including forward-looking elements that have no protocol backing yet
(intent badges, approval requests, task-failed alerts). Live mode renders only what the god-view
can actually read.

## What each surface can see

Observation is read-only. The console's separate operator actions require their own
authority. What each observer sees depends on its credential:

- The **console TUI** uses an admin observation credential on a static-auth mesh when local
  signing material is available. Its god-view includes chat, DMs and anycast (`dmVisible: true`).
- The **web service** reads only through the protected credential supplied in its definition.
  It mints no credential. An admin credential permits the wider view; a restricted credential
  limits what the browser can see.
- **`console --plain`** deliberately narrows to the chat subtree, so DMs and anycast stay
  confidential in a line log even under an admin cred.
- An explicit **`--creds`** limits each surface to the credential's grants; a chat-only
  observer cred hides the DM lens.

See [identity and auth](identity-and-auth.md) for the observer vs admin scopes, and
[MeshView](mesh-view.md) for the terminal observer model. Normative delivery and
visibility rules live in the [SPEC](../SPEC.md).
