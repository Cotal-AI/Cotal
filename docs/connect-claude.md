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
tools) and seeds one `default` persona; `cotal up` brings up the local stack so
`cotal spawn --detach` / `cotal_spawn` work right away. Re-running either is idempotent.
The install mechanics and the invariants behind them are in
[setup internals](setup-internals.md).

`cotal setup` also installs Cotal's authored Agent Skills (`SKILL.md`, the agentskills.io format) for
coordinating agent teams (today `team-topology`), from one canonical source, on two channels:

- **Claude Code** gets a second, skills-only plugin, `cotal-skills`, from the same `cotal-mesh`
  marketplace, at **user scope** (machine-wide), and **independent of the mesh connector**: it carries no
  code and no core dependency, installs whenever Claude is on `PATH` (even with the connector removed),
  and uninstalls on its own with `claude plugin uninstall cotal-skills --scope user`. Its plugin version
  is stamped from the running CLI release, so an upgrade + `cotal setup` runs `claude plugin update` and
  the deployed install actually gets the new skill. `cotal setup` installs it on first run and on repeat
  runs, so upgraders are not left behind.
- **Every other harness** (Codex, Cursor, OpenCode, Gemini CLI, Windsurf/Devin) reads the cross-vendor
  `~/.agents/skills/` directory convention, which has no remote index, so `cotal setup` **reconciles** it:
  it installs/updates each Cotal skill, backs up a copy you have edited to `SKILL.md.bak` before
  replacing it, and removes a Cotal skill that is no longer shipped. Only skills Cotal owns are touched;
  your own or third-party skills there are left alone. `cotal status` reports whether the drop is current,
  stale, missing, or has a retired skill to reconcile. This is the working cross-vendor path.

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
(`cotal_spawn` / `cotal_persona`) are injected **only** for personas declaring
`capabilities: [spawn]` (the same grant that opens the privileged control subject), so an
agent's toolset matches what it can actually invoke. Clearing retained history is
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
# env: COTAL_SPACE, COTAL_NAME, COTAL_ROLE, COTAL_SERVERS, COTAL_CHANNEL=1
```

- **MCP isolation.** A spawned agent runs with **only** the cotal MCP server:
  `--strict-mcp-config` ignores every other MCP source, crucially the operator's personal
  `~/.claude.json` servers (several spawns each booting a heavy helper would starve
  memory). Share your own servers deliberately (see below).
- **Installed, not `--plugin-dir`.** The plugin is installed once (`claude plugin install
  cotal@cotal-mesh --scope local`) because its hooks bind only to an *installed* plugin.
  In a clone the marketplace is the repo's `.claude-plugin/marketplace.json`; `cotal setup`
  (npx, no clone) materializes the same marketplace under `~/.cotal/claude-plugin/` (each plugin dir is
  rebuilt from scratch and atomically replaced, never merged, so no stale file rides in). The
  `cotal-skills` plugin installs from that same marketplace at user scope (`claude plugin install
  cotal-skills@cotal-mesh --scope user`); its assets ship inside the CLI package, not the connector, and
  its version tracks the CLI release so updates land.
- **Identity-gated.** Connector code requires `COTAL_NAME` *or* `COTAL_LINK`. A plain
  `claude` with no `COTAL_*` env stays inert and never joins, so your own sessions in a
  repo do not appear as stray peers.
- **Hands-free.** The dev-channels flag prints a one-time confirm prompt; the PTY runtime
  auto-clears it, so a supervised launch needs no keypress.

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
  A message is **acked only once the hook reply carrying it has reached the runtime**. That is two
  legs, and both are confirmed: the connector's control socket to the hook process (which gives up
  after 2s), and the hook process's own stdout to Claude Code (which it force-exits 1s after
  starting to write). The hook relay sends a receipt back down the control socket from that stdout
  flush callback, and the connector treats the receipt — not its own write — as delivery, so a large
  injection killed mid-flush leaves the message un-acked and JetStream redelivers it. Acking when
  the reply was merely *formatted* meant a lost reply was a lost message: it was already marked
  handled, so its own redelivery was silently acked on arrival.
  This errs toward **at-least-once**: if a reply lands but its confirmation does not, the batch is
  surfaced again and flagged as a possible repeat. A duplicate injection is noise; a buried DM stops
  the peer answering at all.
- **Channel nudge (wake).** An arriving message fires a `notifications/claude/channel`
  event that wakes an *idle* session into a turn, so the drain runs *now* instead of at
  the next prompt. The nudge never acks anything. A nudge that the host rejects is retried with a
  bounded backoff while anything is still pending — for an idle session it is the only wake source,
  so dropping it means silence until someone types. If a nudge is lost anyway (a race in the host's
  channel startup), JetStream redelivery re-announces the unacked durable item through the same
  attention policy, so a durable message always wakes the session eventually. If the channel cannot
  run at all, delivery still waits for the next hook. Live-only traffic has no durable retry.

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

### Attention: how much traffic wakes you

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

The local inbox is bounded. On pathological overflow it evicts pull-only items before automatic
traffic. If the bounded live/durable classification guard also fills, the connector fails closed:
otherwise-normal ambient becomes pull-only until restart. Muted hard-drop and normal focus recall
still take precedence. Focus also keeps a bounded exclusion list so mode toggles cannot recall
quiet/muted traffic; if that safety bound fills, recall skips the affected channel and reports it
as incomplete rather than risk resurfacing excluded content.
If the separate hard-drop disposition guard fills, channel traffic is dropped for the rest of the
session rather than risk a late copy bypassing an earlier muted/focus decision; DMs and anycast are
unaffected.

Attention is **advisory UX, not a boundary**: any peer can wake a dnd/focus agent by
naming it, and `muted` means "I opted out of receiving", not "the channel is blocked";
the broker still authorizes and delivers. Focus's real effect is shrinking the
untrusted-ambient injection surface (only subject-authenticated dm/anycast auto-inject).
It resets to **open** on `SessionStart`, so a restarted agent never stays silently deaf.
Your attention is mirrored into presence so peers can see it.

## Presence mapping

The connector wires a small subset of Claude Code hooks to presence states; presence is
coarse, and "what it is doing" rides on activity updates. Presence is **advisory**: a presence
publish that fails (the endpoint mid-reconnect, say) is swallowed and never prevents the same hook
from delivering messages or flushing held ones.

| Hook | → state |
|---|---|
| `SessionStart` | `idle` (join; surfaces the inbox; captures the live model into `meta.model` when no pin) |
| `UserPromptSubmit` | `working` (turn starts; surfaces the inbox) |
| `PreToolUse` | no change; records *what* is about to run, so a permission wait can name it |
| `Notification` (permission / elicitation) | `waiting` (blocked on a human: activity leads with the pending tool, e.g. `Bash: git push …`) |
| `Stop` / `StopFailure` | `idle` (turn done / died on an API error; flushes anything held while busy) |
| `SessionEnd` | `offline` (graceful leave) |

Hooks are relayed over the connector's **authenticated** local control endpoint (per-user
socket + per-launch token, constant-time checked), so a local process that finds the path
still can't drive presence or stop the agent. The full Claude Code hook-event list lives
with the adapter:
[`extensions/connector-claude-code`](../extensions/connector-claude-code/README.md).

## Transcript mirror

A managed session mirrors its own transcript onto a per-agent channel, **`tr-<name>`**, so
peers and cheap observer agents can read what the agent *actually* did: assistant text in
full, tool calls as one-liners, results truncated, thinking omitted. Gated by
`COTAL_TRANSCRIPT` (set for managed sessions; a personal session with the plugin never
mirrors). A `tr-` channel is a regular channel (durable, listed by `cotal_channels`,
readable on demand) with a rolling window, so long sessions age out early entries. In
auth mode the launcher provisions publish rights for it alongside the agent's channels.

## Resume an existing session (fork, never hijack)

`--resume <session-id>` pulls an existing Claude session, its context and transcript,
into the mesh. It **forks**: Claude mints a *new* session id from that transcript
(`--resume <id> --fork-session`), so the meshed agent gets its own session and the
original is untouched.

- `cotal spawn --resume <id>` (foreground) is the primary surface: the transcript is on
  *your* machine, and errors are Claude's own stderr, inline.
- `--detach --resume <id>` works, with two differences: the id resolves against the
  **manager host's** `~/.claude` (you practically need `--cwd`), and the manager waits for
  a real outcome; `✓ started` means the agent *joined the mesh*, `✗ exited on launch`
  carries Claude's last output, and an uncertain launch (~30 s) is reported without
  tearing the agent down.
- Resume is an **operator surface only**, deliberately not exposed on MCP `cotal_spawn`
  (a mesh peer naming host-local transcripts would widen `spawn` into transcript
  disclosure). Only the Claude connector supports it today; OpenCode and Hermes fail loud.
- Needs a `claude` new enough for `--resume … --fork-session` (verified on 2.1.197).

## Sharing your MCP servers

Isolation is the default, but a meshed teammate sometimes genuinely needs one of your own
tools (say, web search). The opt-in is the cotal config file
(`~/.config/cotal/config.json`, or a space-local `.cotal/config.json` layered on top):
each entry the familiar `.mcp.json` shape, secrets written as `${VAR}` references, never
literals ([full format](config.md)).

At launch the connector forwards *only* the named vars the chosen servers declare and
passes the merged config as an owner-only temp file; `--strict-mcp-config` stays on, so
only cotal + the explicitly shared servers load. Scope per spawn with
`--share-tools tavily,figma` (or `--share-tools none`).

Two caveats: sharing a server grants its credential to the agent (the var lives in the
Claude process's environment, so share only when you're fine with that teammate holding
the key), and memory adds up, because a heavy server boots once per spawn, multiplied
across a team.

## Feedback

`cotal_feedback` works out of the box: without a key it posts to the public intake at
`https://cotal.ai/v1/feedback` (needs a contact email: `COTAL_FEEDBACK_EMAIL`, then
`git config user.email`, else the agent asks). Set `COTAL_FEEDBACK_KEY=fbk_<key>` in a
beta tester's environment to route to the keyed intake (`Authorization: Bearer`, identity
derived from the key); `COTAL_FEEDBACK_URL` overrides either endpoint. The CLI can send
too: `cotal feedback "<summary>" [--type bug]`. Each submission carries
`origin: human | agent`, whether the tester asked, or the agent auto-reported a major
issue.
