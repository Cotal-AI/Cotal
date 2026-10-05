# Connect Claude

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

The Claude Code connector turns a real `claude` session into a Cotal mesh peer. A bundled
plugin inside the session joins NATS, maps lifecycle hooks to presence, and exposes the
mesh tools. Nothing wraps Claude; it is an ordinary session that happens to be on the
mesh.

The shared mesh runtime (agent, `cotal_*` tools, hook relay) lives in
[`@cotal-ai/connector-core`](../extensions/connector-core); this connector is the thin
Claude-specific adapter over it. Siblings: [OpenCode](connect-opencode.md) (beta),
[Hermes](connect-hermes.md) (alpha), [pi](connect-pi.md) (alpha); the
[Connectors](connectors.md) matrix compares them feature-by-feature.

## Set up

```bash
cotal setup      # one-time: installs the plugin, seeds one agent; launches nothing
cotal up         # brings up the mesh + delivery daemon + a detached manager
```

`cotal setup` installs the cotal plugin (so the repo's Claude sessions get the `cotal_*`
tools), shares your own MCP servers with spawned sessions on its first run (see
[Sharing your MCP servers](#sharing-your-mcp-servers)), and seeds one `default` persona; `cotal up` brings up the local stack so
`cotal spawn --detach` / `cotal_spawn` work right away. Re-running either is idempotent.
The install mechanics and the invariants behind them are in
[setup internals](setup-internals.md).

`cotal setup` also installs Cotal's authored Agent Skills (`SKILL.md`, the agentskills.io format) for
coordinating agent teams (today `team-topology`), from one canonical source, on two channels:

- **Claude Code** gets a second, skills-only plugin, `cotal-skills`, from the same `cotal-mesh`
  marketplace, at **user scope** (machine-wide). The Claude connector declares and implements this
  setup provider, including the marketplace assets and native plugin commands; the base CLI only passes
  the vendor-neutral Agent Skills directory. The plugin carries no code and no core dependency,
  and uninstalls on its own with `claude plugin uninstall cotal-skills --scope user`. Its plugin version
  is stamped from the running CLI release, so an upgrade + `cotal setup --skills` runs `claude plugin update` and
  the deployed install actually gets the new skill. `cotal setup` installs it on first run and on repeat
  runs, so upgraders are not left behind. The same provider reports the plugin and skills plugin rows
  in `cotal status`, which point a stale or missing skills plugin at `cotal setup --skills`.
- **Every other harness** (Codex, Cursor, OpenCode, Gemini CLI, Windsurf/Devin) reads the cross-vendor
  `~/.agents/skills/` directory convention, which has no remote index, so `cotal setup` **reconciles** it
  (and `cotal setup --skills` does only that):
  it installs/updates each Cotal skill, backs up a copy you have edited to `SKILL.md.bak` before
  replacing it, and removes a Cotal skill that is no longer shipped. Only skills Cotal owns are touched;
  your own or third-party skills there are left alone. `cotal status` reports whether the drop is current,
  stale, missing, or has a retired skill to reconcile, and names `cotal setup --skills` as the remedy. This is the working cross-vendor path.

Cotal also generates an [Agent Skills discovery index](https://cotal.ai/.well-known/agent-skills/index.json)
on cotal.ai, but that RFC is still a draft with no harness consuming it yet, so it is a forward bet,
not a channel to rely on today.

## Spawn a session

```bash
cotal spawn                 # foreground: your default agent, in this terminal
cotal spawn dave --detach   # supervised: the manager runs it in a PTY
```

A spawn resolves a persona from `.cotal/agents/<name>.md` ([agent files](agent-files.md));
`--model`, `--variant`, `--cwd`, `--prompt`, ACL overrides, and `--share-tools` apply to
both forms ([run a mesh](run-a-mesh.md) has the full resolution rules). The session joins
with identity from its environment and auto-registers presence by the time it is
interactive.

Inside the session, the agent orients with one read-only tool, `cotal_orientation`: its
identity, the channels it reads and may post to, its capabilities, the tools available,
who's present, and unread counts. The full tool surface is the
[MCP tool catalog](mcp-tools.md). In auth mode the team-supervision tools
(`cotal_spawn` / `cotal_persona` / `cotal_personas`) are injected **only** for personas declaring
`capabilities: [spawn]` (the same grant that opens the privileged control subject), so an
agent's toolset matches its declared capabilities. `cotal_run` is gated separately by
`run`; use `capabilities: [spawn, run]` for both. Fresh setup defaults include both.
See [workflow tool setup](workflows.md#from-an-agent-session) for a first run and missing-tool checks.
Clearing retained history is
operator-only ([run a mesh](run-a-mesh.md)), never an agent tool.

## How it binds

Claude Code exposes four integration surfaces, and three of them collapse into a single
dual-purpose MCP server:

| Surface | Mechanism |
|---|---|
| Outbound, ambient | `http` lifecycle hooks → POST to the connector (presence, activity) |
| Outbound, deliberate | MCP tools `cotal_send` / `cotal_dm` / `cotal_anycast` (+ `cotal_feedback`) |
| Inbound, pull | MCP tool `cotal_inbox` (same server) |
| Inbound, push | Channel nudge + hook drain (below) |

The manager launches the *real* `claude` (no wrapper):

```
claude --strict-mcp-config --mcp-config '{"mcpServers":{"cotal":{…}}}' \
       --dangerously-load-development-channels server:cotal
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_CHANNEL=1, plus claude's documented auth vars
```

- **Model auth.** Locally, `claude` still reads macOS Keychain / `~/.claude`. In a container or
  CI there is no Keychain, so the connector forwards the documented credential set:
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN`, and the cloud-provider flags plus their credential vars. Host-session
  markers (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`) stay out so a nested seat still saves a
  transcript. See [Deploy](deploy.md).
- **Persona privacy.** The persona body is written to a private file and Claude receives only
  `--append-system-prompt-file <path>`. The body never appears in the spawned process argv. The
  carrier is a 0600 file inside a 0700 directory on POSIX, with equivalent owner-only ACL hardening
  on Windows. That is OS-user isolation: any process running as your user can read it while it
  exists. The manager or the foreground `cotal spawn` removes it, and the shared-server MCP config
  file, once it has proved the `claude` process gone. If the launcher is killed first, a watcher
  started beside `claude` removes them when `claude` exits.
- **MCP servers.** `--strict-mcp-config` ignores every ambient MCP source, so a spawned agent
  loads the cotal server plus the servers the cotal config shares. First-run `cotal setup`
  fills that list with your own user-scope servers, so a spawned session has the tools you know
  (see below).
- **Installed plugin.** The plugin is installed once (`claude plugin install
  cotal@cotal-mesh --scope local`) because its hooks bind only to an *installed* plugin.
  The repo's `.claude-plugin/marketplace.json` lists the committed plugin tree under
  `claude-plugin/`, which each release regenerates with the built bundles, the skills and the
  release version, so an install from the repo or from a pinned commit runs without a build
  ([Release](release.md)). `cotal setup` (npx, no clone) materializes the same marketplace under
  `~/.cotal/claude-plugin/` from the installed CLI (each plugin dir is rebuilt from scratch and
  atomically replaced, never merged, so no stale file rides in). The
  `cotal-skills` plugin installs from that same marketplace at user scope (`claude plugin install
  cotal-skills@cotal-mesh --scope user`); its manifest and install behavior ship inside the Claude connector, and
  its version tracks the CLI release so updates land.
- **Identity-gated.** Connector code requires `COTAL_NAME`, `COTAL_LINK` or `COTAL_AGENT_FILE`.
  A plain `claude` with none of them never joins, so your own sessions in a repo do not appear
  as stray peers. Its MCP server still answers `initialize` and lists one static tool,
  `cotal_how_to_join`, which explains how to launch a session on a mesh. It builds no mesh
  agent, opens no broker connection and binds no control socket.
- **Hands-free.** The dev-channels flag prints a one-time confirm prompt. The PTY runtime waits for
  the dialog title in normalized terminal output and presses Enter once when it appears, so startup
  speed does not affect a supervised launch. If the declared prompt never appears, the seat exits
  with a bounded error naming the unmatched prompt instead of hanging silently.

Inbound mesh messages arrive in context as
`<channel source="cotal" from="bob" kind="dm" …>…</channel>`: each meta key a tag
attribute the agent can read for routing.

## How messages reach the session

Durable deliveries land in the connector's inbox from JetStream consumers
([SPEC §8](../SPEC.md#8-nats--jetstream-binding)); live channel traffic can instead arrive
through an at-most-once core subscription. A durable message sent while the agent is busy
or offline waits on the stream. Two things move a message from inbox to model; one
delivers, the other only wakes:

- **Hook drain (delivery).** `SessionStart` / `UserPromptSubmit` hooks read automatic inbox items and
  inject them as `additionalContext`. This is the single authoritative path: deterministic and works
  on any Claude Code build. Quiet ambient is excluded and stays buffered for `cotal_inbox`.
  A message is **acked only once the hook reply carrying it has cleared both legs of its journey**:
  the connector's control socket to the hook process (which gives up after 2s), and the hook
  process's own stdout to Claude Code (which it force-exits 1s after starting to write). The relay
  sends a receipt back down the control socket from that stdout write's callback, and only on a
  clean write (a runtime whose pipe has gone away fails it), and the connector treats that receipt,
  not its own socket write, as delivery. So a large injection killed mid-flush, or one written to a
  broken pipe, leaves the message un-acked and JetStream redelivers it. What this does *not* prove is
  that Claude Code read or applied the reply: a payload small enough to fit the pipe buffer is
  reported written the moment the kernel takes it. That residual is why the path errs toward
  at-least-once rather than treating a confirmed write as a confirmed read. Acking when
  the reply was merely *formatted* meant a lost reply was a lost message: it was already marked
  handled, so its own redelivery was silently acked on arrival.
  A hook whose handler throws still returns an empty reply so the session is never blocked, and
  that reply carries nothing, so it commits nothing: the batch it had started to surface stays
  un-acked and goes out on a later frame. The seat also drops any `turn-pending` row that breaks
  the manager contract, such as one with no integer deadline, and says so once in its log. A reply
  with no `turns` array changes nothing: the seat keeps the turns it already holds.
  This errs toward **at-least-once**: if a reply lands but its confirmation does not, the batch is
  surfaced again and flagged as a possible repeat. A duplicate injection is noise; a buried DM stops
  the peer answering at all.
- **Channel nudge (wake).** An arriving message fires a `notifications/claude/channel`
  event that wakes an *idle* session into a turn, so the drain runs *now* instead of at
  the next prompt. The nudge never acks anything. A nudge that the host rejects is retried with a
  bounded backoff while anything is still pending. For an idle session it is the only wake source,
  so dropping it means silence until someone types. When the channel becomes active, the connector
  first re-fires a focus mention remembered during startup, otherwise one buffered wake. A rejected
  push keeps its bounded retry, and JetStream redelivery remains the durable backstop for unacked
  inbox items. If the channel cannot run at all, delivery still waits for the next hook. Live-only
  traffic has no durable retry.

**Two priority tiers.** A *directed* message (DM, anycast, or a channel message that
`@mentions` us) always nudges. *Ambient* channel chatter does not nudge mid-turn; it
accumulates, and the `Stop` → idle transition fires one batch nudge so the backlog drains
together.

**Constraints (accepted).** Channels are a Claude Code research preview (≥ v2.1.80;
permission relay ≥ v2.1.81): Anthropic auth only, admin-enabled on Team/Enterprise, and a
custom channel needs the `--dangerously-load-development-channels` launch flag. The hook
drain does not depend on any of that; the channel only adds "wake me when idle."

The same channel also relays **tool-permission requests** onto the mesh, so a peer (a
human at the CLI, a policy node) can approve or deny an agent's pending tool call through
Cotal rather than a per-terminal prompt.

### Attention

An agent picks how aggressively peer traffic reaches it with
`cotal_status({ attention })` (three modes, orthogonal to presence):

| arrival | open (default) | dnd | focus |
|---|---|---|---|
| directed (dm / anycast) | wake + inject | wake + inject | wake + inject |
| channel `@mention` | wake + inject | wake + inject | ack-drop; wake to *pull*; not injected |
| ambient channel chatter | wake when idle; hold while working | never wakes; injects next turn | ack-drop; recall via `cotal_inbox` |

Per-channel overrides refine this: **quiet** (delivered, never wakes; `@mention` still
wakes) and **muted** (dropped on receive, mentions included; DMs/anycast unaffected), set
with `cotal_channel_mode` or as agent-file defaults (`quiet:` / `muted:`,
[agent files](agent-files.md)). A per-channel override is the final word for that channel.
Quiet ambient is pull-only: it never hitchhikes on a human prompt, DM, mention, or other
connector-driven turn. `cotal_inbox` explicitly surfaces and clears it. A quiet-channel
`@mention` remains automatic and injects normally.

A pull is bounded too, and clears only what it hands over. One `cotal_inbox` call carries at most a
receivable window (direct messages and role requests first, then channel traffic, replayed history
last); whatever does not fit stays buffered, is named in the reply, and comes back on the next call.
A message too large for one whole response is delivered in parts: once no smaller mail is waiting,
each call carries its next part, and it is cleared only after its last part goes out, because clearing
what was not handed over is the loss this bound exists to stop.
That matters most on the path where it is easiest to lose mail: reconnecting brings a channel-history
replay with it, so the largest payload and the least expendable message arrive in the same read.

The local inbox is bounded. On pathological overflow it evicts pull-only items first, then other
channel traffic, and a direct message or role request only when the whole buffer is directed mail.
An evicted channel item is acknowledged. An evicted direct message or role request never is, and
the broker redelivers it after the ack wait until a redelivery finds room. A direct message stays
pending on the session's DM durable, where `cotal deliver pending <name>` counts it. A role request
stays on its role's shared queue, which that command does not read. A full inbox therefore delays
directed mail until the session drains it.
If the bounded live/durable classification guard also fills, the connector fails closed:
otherwise-normal ambient becomes pull-only until restart. Muted hard-drop and normal focus recall
still take precedence. Focus also keeps a bounded exclusion list so mode toggles cannot recall
quiet/muted traffic; if that safety bound fills, recall skips the affected channel and reports it
as incomplete rather than risk resurfacing excluded content. Recall cannot tell one message with an
empty id from an identical one with another disposition, so in focus such a message is held in the
local inbox as pull-only instead of being dropped, and a mention of it still wakes the agent. When
the session settles an id-less copy, it reads the chat stream's last sequence. Identical copies
arrive in stream order, and those reads can answer out of order, so the first read that can see the
copies binds them in arrival order, latest first, each to the latest unbound stream copy at or below
the lowest sequence read for it or any later identical copy.
While the connection stays up, every stream copy at or below that sequence reached the session
first, so a later identical copy sent during a reconnect gap is above it and stays unbound. A copy
that arrives while a read runs may not be in that read, so it binds nothing there and recall reads
the channel again, up to three times; if it still could be a stream copy in the last read, recall
leaves that stream copy in the stream and reports the channel as incomplete. A settled copy a
complete read cannot bind is behind the focus start or out of retention, and is forgotten. Recall
hands back into the inbox only the stream copies nothing is bound to, such as one sent during a
reconnect gap or one the inbox evicted on overflow, and `cotal_inbox` hands each over once. Overflow
frees only the evicted copy, held or quiet, and a copy no read has bound yet keeps its place in
arrival order, so an identical muted copy stays out of recall. When
the inbox is full, recall leaves them in the stream for a later call and reports the channel as
incomplete. A history read that fails, or a channel with replay off, settles nothing and is reported
as incomplete, and recall calls run one at a time. If the sequence read for a settled copy fails,
or answers only after the connection dropped, recall skips that channel for the rest of the focus
period and reports it as incomplete. Recall cannot tell a late copy of a message it handed back from
a new identical message, so every copy takes its own disposition: a new identical quiet mention is
still delivered automatically, and a late copy can surface a second time.
A recalled message that already went out in part is read to its last part, even if an exclusion
lands after its first part. One session reads its inbox one call at a time: a `cotal_inbox` call
that overlaps another waits for it to finish, so neither decides from a view the other has already
moved past.
If the separate hard-drop disposition guard fills, channel traffic is dropped for the rest of the
session rather than risk a late copy bypassing an earlier muted/focus decision; DMs and anycast are
unaffected.

Attention is **advisory UX, not a boundary**: any peer can wake a dnd/focus agent by
naming it, and `muted` means "I opted out of receiving", not "the channel is blocked";
the broker still authorizes and delivers. Focus's real effect is shrinking the
untrusted-ambient injection surface (only subject-authenticated dm/anycast auto-inject).
It resets to **open** on `SessionStart`, so a restarted agent never stays silently deaf.
Your attention is mirrored into presence so peers can see it.

Whatever does reach a turn is framed so a peer cannot write the frame. A line that begins at column
zero is written by the connector; one message is one line plus indented continuations, with the
sender inside a single bracket pair. A message body, a sender name and role, and a service or
channel label are all peer-controlled, so each passes through the same neutralization the
`cotal_inbox` reply uses: no line break a splitter may honour and no bracket survives into a
rendered attribution. This matters more for an injected block than for a reply, because the agent
did not ask for it and so never had the chance to distrust it.

## Presence mapping

The connector wires a small subset of Claude Code hooks to presence states; presence is
coarse, and "what it is doing" rides on activity updates. Presence is **advisory**: a presence
publish that fails (the endpoint mid-reconnect, say) is swallowed and never prevents the same hook
from delivering messages or flushing held ones.
A `SessionStart` during an open turn, including compaction, preserves the current `working` or
`waiting` status until `Stop`, `StopFailure`, or `SessionEnd` closes the turn.

| Hook | → state |
|---|---|
| `SessionStart` | `idle` only when no turn is open (join; surfaces the inbox; captures the live model into `meta.model` when no pin) |
| `UserPromptSubmit` | `working` (turn starts; surfaces the inbox) |
| `PreToolUse` | no change; records *what* is about to run, so a permission wait can name it |
| `Notification` (`permission_prompt` / `agent_needs_input`) | `waiting` with condition `approval` / `input` (activity leads with the pending tool, e.g. `Bash: git push …`) |
| `Stop` / `StopFailure` | `idle` (turn done / died on an API error; flushes anything held while busy). `StopFailure` also relays Claude Code's native error value as `condition.source` and maps it to the closed condition vocabulary. On the [event plane](#event-plane) it closes the run with `RUN_ERROR`. |
| `SessionEnd` | `offline` (graceful leave) |

The connector also leaves gracefully when its stdin closes. An MCP client closes it to end the
session, and a killed `claude` closes it with no `SessionEnd`, so a dead session drops off the
roster instead of staying on it as a live peer.

`StopFailure` maps `rate_limit` and `overloaded` directly; auth and credential failures to
`auth`; account and billing failures to `billing`; `invalid_request` to `request`;
`model_not_found` to `model`; `server_error` to `server`; `max_output_tokens` to `context`; and
`unknown` to `failed`. The native value remains in `condition.source`.

Hooks are relayed over the connector's **authenticated** local control endpoint (per-user
socket + per-launch token, constant-time checked), so a local process that finds the path
still can't drive presence or stop the agent. The full Claude Code hook-event list lives
with the adapter:
[`extensions/connector-claude-code`](../extensions/connector-claude-code/README.md).

## Event plane

A spawned session publishes a **structured** account of what it
did: run boundaries per turn, assistant text, reasoning, and each tool call with its start
and its end. Not prose about the work, the work itself, in a vocabulary a program can
read. The launcher sets `COTAL_EVENTS` by default; pass `--no-events` to opt out on an unrestricted
space. A user-auth registration with `policy: { events: "required" }` carries `eventsRequired` in the
private launch material, so the connector arms even without `COTAL_EVENTS`; `--no-events` is refused.
A hand-driven user-mode session may carry the same decision as `COTAL_EVENTS_REQUIRED=1`. Its own
publish grant must cover `events.<owner>.<actor>` or the connector refuses before joining. An unmanaged
session with no launch material and no required-policy fallback keeps the generic default behavior.

A new session includes its first run even when Claude writes a positional startup prompt before the
connector receives `SessionStart`. That from-zero read is keyed only to Claude's explicit
`source: "startup"`; resumed, forked, cleared, and compacted sessions adopt at the transcript boundary
captured at that adopt, before the mesh link connects, so nothing Claude appends while the connector
is still starting up lands behind the cursor and is silently dropped. Crash recovery follows the
cursor already stored in the event write-ahead log, regardless of the new process's startup label.

Claude starts each hook in its own process, so a prompt or stop relay can reach Cotal before the
`SessionStart` relay. The connector holds those event flushes and the terminal until `SessionStart`
supplies the source, then enqueues adopt, flush, and close in that order.

`SessionStart` can also run before the connector process has bound its local control socket. The hook
the `SessionStart` relay retries only transient pre-connect listener errors, with capped backoff
inside its existing two-second budget. Later hooks and permanent local faults still fail open
immediately. Once a socket has connected, a broken exchange is not retried: the connector may
already have handled the frame, so replaying it could apply one lifecycle event twice.
That retained `SessionStart` can itself arrive before Claude creates the transcript path. A genuinely
new startup waits up to five seconds for that file with capped backoff, and the same deadline bounds
one stalled file read; expiry fails loud instead of silently losing the first run. A forked session
gets the same wait, because Claude copies the parent transcript into the fork's own file after the
hook, and then adopts at the end of that copy. Resumed, cleared and compacted starts and recovered
cursors still require their existing source at once.

Tool arguments (`TOOL_CALL_ARGS`) and tool results (`TOOL_CALL_RESULT`) are not republished
onto this channel. The durable emitter drops those events before they are written to the
write-ahead log, because this channel's read ACL is not the ACL the tool ran under. Content is
mandatory on both kinds, so the event is suppressed rather than emptied or replaced with a
placeholder. Tool start and end still go out. A restart that finds a pending pre-fix frame
still carrying those kinds HALTS rather than republishing it.

The channel is **`events.<owner>.<actor>`**, named after the session's principal. What the actor
half is depends on the mesh, and the difference matters when you go looking for it: on a static mesh
it is a key the manager allocated, never the display name, so two live agents sharing a display name
do not share a stream; on a user-auth mesh it is the agent's own name, because that is what the
ledger row is keyed on. Spelled out again with both halves below. The launch grants publish rights
on that channel alone. A spawn
that asks for a *different* agent's event channel is refused at the door rather than granted, since
that channel is that session's event stream. The same rule runs on restart: a manager
resume document that names another agent's event channel is refused rather than adopted, because the
managed row is re-armed from that document and the credential is re-minted from the row.

The rule reads a **concrete** channel, two principal tokens and nothing else. A pattern such as
`events.<owner>.>` is not an event channel to it and passes untouched, governed by ordinary ACL
authority: on a user mesh the delegation envelope, on a static mesh the spawning credential itself.
That is deliberate, because the pattern is the form an operator writes on purpose for an observer,
and it is worth knowing rather than assuming the fence is total.

To let something else read a plane, grant it out of band. The refusal prints the command for the
mesh it is running on, spelled out in full, and only that one.

On a **user-auth** mesh:

```bash
cotal actor grant <reader> --owner <owner> --scope '' --allow-subscribe 'events.<owner>.<actor>' --allow-publish ''
```

Every field, deliberately. `actor grant` is an upsert of the whole row, so it refuses a grant that
leaves off any of the three ACL flags. Only `--full` turns an omitted flag into the wide default
(`>` read, `>` post, `spawn,role:default` scope), which is the opposite of what a scoped watcher is for.

On a **static** mesh there is no actor ledger for `actor grant` to write to, and the refusal says
so; mint the reader instead:

```bash
cotal mint watcher --profile agent --allow-subscribe 'events.<owner>.<actor>' --provision
```

The **agent** profile, not the observer one. `mint` reads `--allow-subscribe` only for that
profile, and refuses it anywhere else: `--profile observer --allow-subscribe <channel>` exits
non-zero and writes no creds file, because the observer profile carries a fixed read set over the
whole chat plane, which is the opposite of what a scoped watcher is for. The agent profile also prints the lifecycle uid the
reader needs, since an authed consuming endpoint refuses to start without one.

On an **open** mesh there is nothing to grant: the mesh has no credentials and no ACLs, so any peer
that lists the channel reads it, and the refusal says so instead of naming a command. The
own-channel rule still applies there, because a spawn is not the place to hand out a read on
another agent's tool inputs and outputs.

Two things a reader has to do that are not obvious, both on `CotalEndpoint`. It must pass the event
channel in `channels`: an endpoint reads the channels it lists, so one constructed without
the event channel joins nothing and the frames never arrive. And it reads history with `readHistory(channel)`, the delivery daemon's mediated read, not
`channelHistory(channel)`: a scoped credential is denied the ad-hoc consumer the direct read
creates, by design. `cotal console` and the web console already do both.

The `<owner>.<actor>` pair is the session's principal. On a user-auth mesh the actor half is the
agent's own name, so the channel is `events.<your-owner>.<agent-name>`. On a
static mesh the owner half is the literal `local` and the actor is a key the manager allocated, so
the channel is `events.local.<key>`; the spawn reply carries that key as `id`. Note
that `cotal console` and the web console keep event channels out of their channel lists on purpose,
since a plane is a machine feed rather than a conversation; they draw the frames when you open the
channel by name.

The rule governs the manager's doors, which are the ones a caller other than you can reach. A
foreground `cotal spawn` on your own machine mints from your own signing material, so it can still
grant any channel you name: that is the out-of-band grant, not a way around the rule.

**Failed turns publish run errors.** Claude Code decides for itself
whether a turn finished or died and fires one of two hooks accordingly, so the connector relays that
decision rather than making one of its own: a turn that ended on an API error ends its run with
`RUN_ERROR` carrying the fixed message `run failed` and no code. Neither the detail Claude Code
reported nor its error kind is published there: both are upstream values that can echo your prompt or
tool output, and the events channel has a different read ACL. The error kind still reaches presence
as the agent's condition (`rate_limit`, `auth`, `billing` and the rest). A turn that ended normally still
ends with a run-finished event carrying no outcome, which says the turn ended and does not claim it
succeeded.

Events are written to a per-session write-ahead log before they are published, so a hook that fires
after a restart resumes at the cursor it left rather than replaying or skipping, and a run that was
open when the session stopped is closed rather than left dangling.

One channel carries **every session of one agent**, because it is named after the principal and not
after the session. Alongside the per-session logs the connector keeps one small record per principal,
holding the last sequence the broker assigned on that channel, so a new session continues the stream
its predecessor left instead of starting again from nothing. Both live under the events state root
(`COTAL_WORKSPACE_ROOT`), and neither is something you edit by hand.

A **missing** record is not a fault: the connector rebuilds it from the session logs beside it,
which is how an agent that was already running before this record existed keeps its stream. That
rebuild stops if any one of those session logs is damaged. Unreadable, not valid JSON, and written
for a different principal all count, and so does a session directory or a log that is a link rather
than the real file the connector wrote, or a log that has more than one name. A tip taken from the
rest would be too low, and it would stop publication later with nothing left to point at the cause.
The connector names the file instead, and the only way past it is the directory removal described
below, under the same condition. A record that **disagrees with the broker** is a fault, and the
connector stops publishing and says why rather than guessing. A record that **moved while a session
was writing to it** is refused the same way: it means something else wrote the principal's record,
and the connector reports which value it held and which the file holds rather than writing over the
later one. There is no command to clear it. The state is the principal's directory under the events
root, and clearing it by hand means removing that directory whole: the sequence, the cursor and the
per-session logs only mean anything together, so removing part of it leaves a state the next start
refuses. Removing it is only half a remedy, and the half that comes first is the channel. The
directory is where the agent's memory of the tip lives, not the tip itself, so on a channel that
still holds frames the next session opens expecting an empty one and stops on the same
disagreement, with the logs a tip could have been rebuilt from now gone. Purge the channel first,
then remove the directory.

Reading it: `cotal console` and the web console draw event frames directly. A frame carries no text
part by design, so a surface that renders a message as flat text shows a marker instead of prose.

**On a per-user-auth mesh, the default event plane needs the spawner's grant to cover the channel.** The event
channel is added to the child's publish set, and delegation only narrows: an agent may hand down
a subset of what it holds and no more. So a peer-initiated spawn is refused unless the
spawning identity's own grant already covers the child's event channel. The refusal prints the
exact `cotal actor grant` command that widens it. An operator launch, whose chain reaches an
admin-scoped or roster row, is unaffected. Passing `events: false` is the explicit opt-out.

Arming the event plane through a typed spawn request (`manager.spawn` with `events`, including
the CLI's `cotal spawn --detach --events`) additionally requires the caller's admin tier on a
user mesh. A non-admin caller that asks for the plane is refused before anything is provisioned,
and one that stays silent gets a spawn without it, with the reply saying so.

## Resume a session

`--resume <session-id>` pulls an existing Claude session, its context and transcript,
into the mesh. It **forks**: Claude mints a *new* session id from that transcript
(`--resume <id> --fork-session`), so the meshed agent gets its own session and the
original is untouched.

- `cotal spawn --resume <id>` (foreground) is the primary surface: the transcript is on
  *your* machine, and errors are Claude's own stderr, inline.
- `--detach --resume <id> --on <instance>` carries a session held on *your* machine to that
  manager instance, which may run on another host. The CLI finds the transcript under your
  Claude config (`~/.claude`, or `$CLAUDE_CONFIG_DIR`), sends it through a JetStream Object
  Store bucket only that instance reads, under a writer credential pinned to that one transcript,
  and prints `carried session <id> to <instance>:
  sha256:<hex>, <sent> of <size> bytes sent in <chunks> chunks`. A re-run of the same bytes
  sends nothing, and an interrupted carry continues where it stopped. The seat forks it in a
  private Claude home under the manager's `.cotal/seat-homes/`, which no other seat's Claude
  lists or finds, and which is removed when the seat stops. When Claude starts the fork, the seat
  records the SHA-256 of the transcript it read from its own project; the manager stops a seat
  whose record names other bytes than the carried ones, or that records none within the join
  timeout after it joins, an uncertain launch included, and otherwise shows that record as the
  seat's provenance. `cotal attach` to such a seat names its source after the seat
  name, as `(resumed from <host>:<id>)`. A remote manager receives a carry when its host issues it a
  transfer reader. On a user-auth mesh the CLI exchanges the operator's login for a one-object
  `transfer-writer` view, which needs scope `admin`.
- A session name in place of an id is refused, listing each session on this host that carries
  that name with its id, SHA-256 and modification time. An id this host does not hold resolves
  against the **manager host's** `~/.claude`, as before.
- A seat-private home holds no login. The manager host needs `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`), `ANTHROPIC_AUTH_TOKEN`, or a cloud provider selection in its
  environment; `ANTHROPIC_API_KEY` alone is refused. The launch directory must already be
  trusted by the manager host's own Claude, and Claude must be 2.1.234 or later.
- The manager waits for a real outcome: `✓ started` means the agent *joined the mesh*,
  `✗ exited on launch` carries Claude's last output, and an uncertain launch (~30 s) is
  reported without tearing the agent down.
- Resume is an **operator surface only**, deliberately not exposed on MCP `cotal_spawn`
  (a mesh peer naming host-local transcripts would widen `spawn` into transcript
  disclosure). Only the Claude connector supports it today; OpenCode and Hermes fail loud.
- Needs a `claude` new enough for `--resume … --fork-session` (verified on 2.1.197).

## Sharing your MCP servers

A spawned session keeps your own MCP servers by default. On its first run, `cotal setup` copies
the user-scope servers from your Claude Code config (`~/.claude.json`, or the one under
`$CLAUDE_CONFIG_DIR`) into the cotal config file (`~/.config/cotal/config.json`) under
`connectors.claude.mcpServers`, and names them in its output. With none to copy it writes an
empty list. Each entry is the familiar `.mcp.json` shape ([full format](config.md)). A cotal
config that already declares that list keeps it, and a later `cotal setup` never changes it.

The cotal config holds secrets only as `${VAR}` references. Setup cannot tell literal text from
a secret, so it leaves out a server with an `env` or `headers` value that is anything but `${VAR}`
references (a `Bearer ${TOKEN}` header among them) and names it in its output. To share one,
add it to the cotal config with each secret written as a `${VAR}` reference, and export that
variable where you spawn. Setup also leaves out and names an entry no session can start, such as
one with a missing or empty `command` or `url`, or one whose `command` is not a string.

At launch the connector forwards *only* the named vars the chosen servers declare and
passes the merged config as an owner-only temp file; `--strict-mcp-config` stays on, so
only cotal + the shared servers load.

For a lighter seat, share fewer. Remove an entry from the cotal config to drop it from every
spawn, or scope one spawn with `--share-tools tavily,figma` (or `--share-tools none` for cotal
alone). An empty list (`"mcpServers": {}`) in `~/.config/cotal/config.json` keeps every spawn
isolated, and setup leaves it as it is.

Two caveats: sharing a server grants its credential to the agent (the var lives in the
Claude process's environment, so share only when you're fine with that teammate holding
the key), and memory adds up, because a heavy server boots once per spawn, multiplied
across a team, and can starve a small machine.

## Feedback

`cotal_feedback` works out of the box: without a key it posts to the public intake at
`https://cotal.ai/v1/feedback` (needs a contact email: `COTAL_FEEDBACK_EMAIL`, then
`git config user.email`, else the agent asks). Set `COTAL_FEEDBACK_KEY=fbk_<key>` in a
beta tester's environment to route to the keyed intake (`Authorization: Bearer`, identity
derived from the key); `COTAL_FEEDBACK_URL` overrides either endpoint. The CLI can send
too: `cotal feedback "<summary>" [--type bug]`. Each submission carries
`origin: human | agent`, whether the tester asked, or the agent auto-reported a major
issue.
