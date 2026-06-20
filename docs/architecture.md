# Cotal: architecture notes

> How Cotal is built: the implementation detail and research grounding, split out of
> [OVERVIEW.md](OVERVIEW.md) to keep the overview lean. These are proposals, not locked,
> except where the *Status* lines say "built today".

## Contents

| Section | What it covers |
|---|---|
| [Influences: A2A + SLIM](#influences-a2a--slim) | Where the vocabulary and shapes come from. |
| [Package layout and dependency tiers](#package-layout-and-dependency-tiers) | The four one-way tiers. |
| [Integration surfaces (Claude Code + OpenCode)](#integration-surfaces-claude-code--opencode) | How a coding agent binds to the mesh. |
| [Manager (agent supervisor)](#manager-agent-supervisor) | Who spawns and configures agents. |
| [Hosting and onboarding](#hosting-and-onboarding) | How a session is launched. |
| [Roles and identity](#roles-and-identity) | The AgentCard, roles, instance continuity. |
| [Technical mapping (NATS / JetStream)](#technical-mapping-nats--jetstream) | Subjects, streams, presence, control plane. |
| [Identity and authorization (auth mode)](#identity-and-authorization-auth-mode) | The JWT/ACL boundary. |
| [Deferred](#deferred) | Designed-for, not built. |

## Influences: A2A + SLIM

Cotal borrows vocabulary and shapes from two agent frameworks so we stay interoperable rather
than siloed, but implements them over NATS/JetStream.

**From A2A** come the *data shapes*: `AgentCard` (identity / role / tags / skills), `Message`
/ `Part` (text and data), `Artifact`, and correlation ids (`contextId`). We do **not** adopt
A2A's HTTP/JSON-RPC transport, `Task` RPCs, or its request/response server model. Those do not
fit lateral pub/sub.

**From SLIM** comes the *addressing and delivery model*:

- **Hierarchical address** `space / service / instance` (SLIM's
  `org/namespace/service/instance`). In Cotal, `space` is the collaboration, `service` is the
  addressable class (a role or agent-type, e.g. `reviewer`), and `instance` is one specific
  endpoint.
- **Three delivery modes:** **multicast** (to a channel, everyone), **unicast** (to one
  instance), and **anycast** (to *any one* instance of a service, for delegation and
  load-balancing).
- **Mentions (a Cotal addition):** a multicast message may carry `mentions: [name…]`, peers
  called out by name. It is a *priority hint*, not a routing target. The message still reaches
  the whole channel, but a mentioned peer is woken immediately while everyone else picks it up
  when next idle (see [two-tier
  delivery](claude-code-integration.md#message-delivery-stream-backed)). **Names**, not
  instance ids, ride the wire, so the receiver's self-match survives reconnects (a
  per-connection id would not). The sender validates names against its roster and **throws**
  on an unknown one, so a typo aborts the whole broadcast rather than silently dropping the
  `@`. The honest limit: you can only mention peers this client has **observed**. A peer
  offline long enough to age out of presence, or one not yet seen after connect, is "unknown".
- **Hierarchical channels** (NATS-subject style): a channel name is dotted. Publish to a
  concrete `team.backend`; subscribe to a subtree with `team.>` (or one level with `team.*`).
  Flat names (`general`) still work. Publishing is always concrete; only subscriptions
  wildcard.
- **Channel membership** (who is on a channel) is **server-known, not self-reported**. A peer
  joins a channel by creating a chat-stream durable consumer, so `consumers.list` *is* the
  membership: unforgeable, with no presence field to lie in. `endpoint.channelMembers(channel)`
  reads that broker truth and joins it with presence for liveness, so a durable whose peer is
  gone but lingering (reconnect grace) shows as a stale member (`live:false`), not a phantom
  listener. This is a privileged read: `consumers.list` needs
  `$JS.API.CONSUMER.LIST.CHAT_<space>`, which only the allow-all **manager** profile holds
  today (agents/observer/admin are denied), so it is manager-served (a dashboard profile is a
  one-line grant away). It is observability only, never an agent gate on sending.
- **Channel registry** (config *about* a channel) lives in a per-space KV bucket
  (`cotal_channels_<space>`, sibling of presence): per-channel `{ replay?, description?,
  instructions? }` plus a space-wide default under a reserved key. It is **channel-global, not
  per-subscriber**, so the same channel replays (or not) for everyone. Writes are
  **privileged** (`cotal up --channels <file>` to seed; `cotal channels set` at runtime), and
  everyone reads it via a live KV watch (`endpoint.getChannelConfig` / `channelReplay`, and
  enriched `listChannels`). `replay` toggles whether a fresh joiner gets history backfilled.
  `description`/`instructions` reach the model, so the registry is a prompt-injection surface:
  text is length-bounded at the write path and surfaced to agents as attributed, advisory data
  (never system-prompt text).
- **Replay mechanism (tail + backfill).** `deliver_policy` is consumer-wide, so it cannot
  honor per-channel replay. Instead the chat durable is a `DeliverPolicy.New` **tail** ("from
  now on") and history is an explicit **per-channel backfill on join** through a short-lived
  single-filter consumer scoped to that one channel (so the read stays within the agent's read
  ACL — see the read-containment note below), gated by the channel's replay policy. A
  per-channel join watermark (the stream frontier at join) lets the tail ack-drop pre-join
  messages, so a
  no-replay channel starts clean and a replay backfill never double-delivers. **How far back**
  is the registry's `replayWindow` (`"24h"`), realized natively as a Direct-Get `start_time`,
  not a client-side count.

  **No-replay is noise control, not confidentiality.** The drop is client-side and every peer
  can read a channel's history on demand (chat is world-readable, agents hold `DIRECT.GET`), so
  it must never be documented or relied on as privacy or access-control. Anything confidential
  uses DM/anycast (private streams, consumer-create-deny), never a no-replay channel.

  *Why one multi-filter durable and not one consumer per channel (which would let the broker
  replay natively)?* A per-channel consumer is named `chat_<id>_<channel>`, and consumer names
  cannot contain `.`, so that is a single ACL token. NATS permission wildcards are
  token-granular, so it cannot be scoped to one agent. One fixed-name durable is what keeps the
  per-agent grant tight *and* makes dynamic join just a filter edit (no per-channel grant).
- **Dynamic subscription.** A peer joins or leaves channels **mid-session**:
  `endpoint.joinChannel`/`leaveChannel` mutate the existing chat durable's `filter_subjects`
  via `consumers.update` (same durable, no teardown; this rides the self-scoped create grant).
  Channel membership is therefore a live view, and join triggers the replay backfill above. On
  **restart** the durable's filter is **reconciled to the agent's current config** (channels
  the config gained are backfilled like a join; channels it lost are dropped); an unchanged
  config is a pure resume.
- **Sessions + moderator** (managed groups with admit/remove) are *deferred*, but the design
  leaves room for them.

We do **not** adopt SLIM's Rust data plane, gRPC transport, or MLS encryption. NATS/JetStream
replaces that layer and adds the durability and presence SLIM leaves to the app. See
[transport.md](transport.md) for the protocol-vs-transport split and the capability contract
any second binding would have to satisfy, which is exactly what NATS gives us for free and a
live-only transport would not.

**Identity** is an A2A `AgentCard` whose `instance` id is a throwaway UUID today, shaped to
later become a **DID** (`did:key`, a self-certifying public-key identifier) so identity can be
cryptographically verifiable and decentralized (see [Deferred](#deferred)).

## Package layout and dependency tiers

Four tiers, one-way dependencies. `packages/` is the standard; everything else builds on it.
`pnpm-workspace.yaml` globs all four (`packages/*`, `extensions/*`, `implementations/*`,
`examples/*`).

- **`packages/*` (core).** The protocol: subjects, schemas, the NATS client, and the shared
  contracts extensions implement (e.g. `Connector`). Everything depends on it; it depends on
  nothing in the repo.
- **`extensions/*` (pluggable adapters).** A connector (Claude Code, OpenCode, …) is the first
  extension *kind*; transport and auth could follow. Each is its own package that
  **peer-depends** on core (so it binds to the host's *single* core instance, not a private
  copy) and exports an object implementing a core contract. They are **picked by explicit
  wiring** at the composition root: the manager is handed the connectors it may spawn, and an
  unknown agent type **throws** (no silent fallback).
- **`implementations/*` (opinionated surfaces).** CLI, web, and so on, each a self-contained
  package over core. **Implementations never import each other**, which keeps the dependency
  graph acyclic (no import loops).
- **`examples/*` (use cases).** Private (never published) packages: demos, benchmarks. An
  example is the **composition root**. It may depend on *several* implementations and picks
  which extensions to wire in.

**Why no sideways imports.** Two implementations do not need each other's code to work
together. They are lateral peers that meet **at runtime in a shared space over NATS**, not at
compile time in an import. A demo that runs both a CLI and a web peer just starts each pointed
at the same `space`; coordination flows through the mesh. So the CLI package and the web
package stay independent, each ignorant of the other, and the example wires them.

```
examples ──→ one-or-more implementations ──→ core ←(peer)── extensions
                      (interoperate at runtime over NATS, not via imports)
```

The migration is done: `demos/` use-cases are now `examples/`. The connector is split into
`@cotal-ai/connector-core` (shared mesh runtime) plus two thin adapters,
`@cotal-ai/connector-claude-code` (`claudeConnector`) and `@cotal-ai/connector-opencode`
(`opencodeConnector`). Those are `extensions/` packages that **peer-depend** on core and export
a `Connector`. `@cotal-ai/cli` and `@cotal-ai/manager` are `implementations/` packages.
Assembly lives at the **composition root**: an example (`examples/01/src/manager.ts`) imports
the manager plus the connectors it wants and hands them to the manager (`new Manager({
connectors: […] })`), which resolves one by agent type when spawning (unknown throws).
Implementations stay self-contained and never import each other: the `cli` drives the manager
purely over the mesh (`start`/`stop`/`ps` control requests), so neither imports the other. Only
the example wires them together.

## Integration surfaces (Claude Code + OpenCode)

Each target agent exposes the same four surfaces. The adapters share one runtime
(`@cotal-ai/connector-core`) and differ only in how they bind to their host. For **Claude
Code** the whole adapter ships as one **plugin**, and three of the four surfaces collapse into
a **single dual-purpose MCP server**:

| | Claude Code |
|---|---|
| **Outbound, ambient** | `http` lifecycle hooks → POST to the local daemon (native http hook, no curl shim) |
| **Outbound, deliberate** | MCP tools `cotal_send`/`cotal_dm`/`cotal_anycast` *(same server as the channel)* plus optional authenticated `cotal_feedback` beta egress |
| **Inbound, pull** | MCP tool `cotal_inbox` *(same server)* |
| **Inbound, push** | Two native paths, see below |

**The dual-purpose server.** A Claude Code *channel* **is** an MCP server that declares the
`claude/channel` capability and pushes events via `notifications/claude/channel`. So one Cotal
MCP server is simultaneously the channel (push), the deliberate-out tools
(`cotal_send`/`cotal_dm`/`cotal_anycast`, one per addressing mode, doubling as the channel's
"reply tools"), and `cotal_inbox` (pull): one process, one stdio connection. Inbound mesh
messages arrive in context as `<channel source="cotal" from="bob" kind="dm"
channel="general">…</channel>`; each meta key becomes a tag attribute the agent can read for
routing.

`cotal_feedback` sits deliberately outside mesh routing. The shared tool surface always exposes
a feedback tool (MCP for Claude Code, native plugin tool for OpenCode). With `COTAL_FEEDBACK_KEY`
set it posts to the keyed intake with `Authorization: Bearer <tester-key>`, and the server maps
the key to a tester. Without a key it posts to the public cotal.ai intake with a contact email
instead. The payload includes `origin` (`human` when the user asked the agent to pass feedback
along, `agent` when the agent auto-reports a major Cotal issue). The intake server writes JSONL
as the source of truth, then publishes an attributed, untrusted feedback item into our internal
Cotal `#feedback` channel for triage.

**OpenCode.** OpenCode has a native plugin runtime, so its adapter is **not** an MCP server at
all. A single plugin, injected at launch via `OPENCODE_CONFIG_CONTENT` (inline config merged
into the operator's, never written to disk), runs inside the OpenCode process and does all four
surfaces. The spawned process keeps the operator's normal home/config/auth roots (`HOME` / XDG on
Unix, `USERPROFILE` / app-data roots on Windows);
only the session SQLite DB is moved per agent with
`OPENCODE_DB=.cotal/opencode/<name>/opencode.db` so concurrent managed agents do not lock each
other. The connector launches the real `opencode` **TUI** (foreground, watchable, like Claude
Code launches `claude`), and the plugin:

- renders the shared `cotal_*` tools as native plugin tools (from `cotalToolSpecs`, the same
  source the MCP adapters render, so the surface cannot drift);
- derives presence from OpenCode's event stream (`session.status` busy → working,
  `session.idle` → idle, `permission.asked` → waiting); and
- **drives the visible session**: it injects each waiting peer batch as a turn via the prompt
  API (`session.promptAsync` on the session the TUI displays, so it cannot race the TUI input
  box and the TUI renders it live), acking on `session.idle`. A human watching the TUI sees the
  agent work and can type into the same session.

So it is push-capable, and unlike Claude Code it needs no separate hooks or control socket. The
plugin holds the mesh connection for the session and closes it in `dispose`. Spawned agents run
autonomously (`permission: "allow"`). The foreground viewer is swappable: an agent file's
optional `face:` id makes the launcher attach an animated avatar viewer to the session instead
of the chat TUI (`COTAL_FACE_BIN` must point at a face-term-compatible script; it watches the
same event stream and can still send prompts into the session). A face-hosted agent is also told
to embed `[[face:X]]` emotion tags in its send text. The viewer reads them from the tool-call
input to animate the avatar, and the send tools strip them before publishing, so they never
reach the wire.

**Connection recovery.** The endpoint self-heals. When nats.js exhausts its own reconnect and
the connection closes terminally, a supervisor rebuilds it (`connectAndBind` is re-runnable;
unacked in-flight messages redeliver on the rebound durables, so nothing is lost across the
gap). A manual `/reconnect` is the human-invoked counterpart. OpenCode has no host reconnect
surface (unlike Claude Code's `/mcp reconnect`), and a plugin cannot register a slash command
via the Hooks API, so the connector injects one through the `OPENCODE_CONFIG_CONTENT` config
layer: a tool-forcing template whose only move is to call the shared `cotal_reconnect` tool,
which tears down and rebuilds the connection **in-process** (it never rides the wedged link).
The connector binds one mesh identity to one live OpenCode process, not one immutable chat: if the
human runs OpenCode's built-in `/new` in that same TUI/process, the plugin adopts the new top-level
session as a context reset, keeps the existing mesh connection/creds alive, and stamps outgoing
messages with the new OpenCode session id as `contextId`.
The rebuild is serialized: manual `/reconnect`, the supervisor's `closed()`, and the retry loop
all funnel through one in-flight rebuild (a second trigger coalesces, never races a second
`connectAndBind`), and a manual reconnect kicks an in-flight backoff to retry immediately.
During the brief null window of a rebuild, user-facing ops throw "reconnecting" rather than NPE.
An in-process agent tracks connectedness off the endpoint's `connection` event (fired on every
(re)bind and every drop), not a local flag, so a self-heal it did not initiate cannot leave it
wrongly believing it is offline (which would make shutdown skip the stop and leak the live
connection). Status (`Reconnected ✓` / `Reconnect failed, still retrying automatically, or run
/reconnect to retry now` / `This session is shutting down, start a new session`) comes from the
tool result, authoritative over the model's prose.

**Two injection paths (different control profiles), composed.**

- **Channel notifications (async push).** We own `content` and tag attributes fully, and the
  daemon owns *emit* timing (drop / queue / coalesce / release, the policy layer). The model
  *sees* it: an idle agent roughly immediately (the event wakes a turn, empirically verified,
  see *Constraints*); a busy agent at the next **turn boundary** (queued events coalesce into
  one batch); mid-turn interrupt is **not** available in attach mode. Research-preview gated
  (see *Constraints*).
- **Hook `additionalContext` (deterministic).** A hook is *our* code at a fixed lifecycle
  point, not research-preview gated. A `UserPromptSubmit` / `Stop` hook injects the pending
  inbox as `additionalContext` at an exact moment; a `Stop` hook returning
  `{decision:"block", reason}` holds the agent in the loop until its mesh obligations are met.

Hooks are the **spine** (no gating, fully deterministic, turn-boundary delivery plus the
keep-working lever); the **channel** adds async "wake me when idle or away."

**Permission relay (same channel, control-plane payoff).** The channel protocol also carries
*tool-permission* requests, so tool approval can happen **over the mesh** on the same
dual-purpose server, with no extra transport. The agent declares the
`claude/channel/permission` capability; a pending tool call surfaces as
`notifications/claude/channel/permission_request` (`{request_id, tool_name, description,
input_preview}`), which the daemon relays onto the mesh, and a verdict returns via
`notifications/claude/channel/permission` (`{request_id, behavior:"allow"|"deny"}`). A peer (a
human at the CLI, a future moderator, or a policy node) can then admit or deny an agent's action
*through Cotal*, making tool approval a first-class control-plane flow rather than a per-terminal
prompt. (Claude Code ≥ v2.1.81; same research-preview gating as the channel.)

**Presence from hooks.** The same lifecycle hooks feed presence: `UserPromptSubmit` /
`PreToolUse` → `working`, `Stop` → `idle`, `Notification` (permission / idle prompt) →
`waiting`, `SessionEnd` → `offline`. Ambient traces reach the mesh for observability, but the
policy layer keeps them out of peers' attention; they never become injections.

**What we control (accepted for the demo):**

| | |
|---|---|
| *What* we inject (content, routing meta) | full, daemon-side |
| *Whether* to inject (ambient vs actionable, allowlist, coalesce, rate-limit) | full, daemon policy |
| *When we emit* | full |
| *When the model sees it* | channel: idle→now, busy→turn boundary · hook: exact lifecycle point |
| *Mid-turn interrupt of a busy agent* | host mode only (Agent SDK) |
| *Whether the model acts* on an injection | steered via the server `instructions` plus meta tags, not forced |

## Manager (agent supervisor)

The CLI does not spawn agents itself. A long-lived **manager** owns their lifecycle, and the
CLI asks it over the mesh. The manager is itself a **node** (presence plus a control subject),
so managing Cotal agents happens *through Cotal*: the control plane's first real consumer.

**Supervisor, not orchestrator.** It owns *process lifecycle plus config binding* (start /
stop / restart, resolve a role, bind env and policy to a session), **not** what work agents do.
Agents still coordinate laterally; the manager only births and configures them. (The
orchestrator-tree we rejected was about delegating *work*; this is *infrastructure*.)

**Supervisor-only scope.** The manager is **off the message hot path**. Each agent
self-connects to the mesh via its own plugin (own presence, messaging, inbound policy). The
manager owns processes and config, as one node among peers, not a daemon that proxies everyone's
traffic.

**Lifecycle is two planes.** *Observing* lifecycle (alive? idle / working / offline) is
**mesh-native via presence**: the agent self-reports through its plugin, so `ps` / `status` read
presence and work **regardless of how the agent was launched** (manager-spawned, a human's own
terminal, or headless). *Forcing* lifecycle (start / stop / restart) is the only part that needs
an OS handle on the process. So the manager owns processes to *control* them, but observes
everything through the mesh, and a bring-your-own-terminal agent the manager never spawned still
shows up and reports status.

**Spawn via a pluggable `Runtime` (no tmux dependency).** Starting, stopping, and attaching are
abstracted behind one interface (`spawn → handle`, `stop`, `status`, `attach`, optional
`interrupt`), like *pm2 or docker for agent TUIs*. `Runtime` is a **core extension contract**
like `Connector`/`Command`: `pty`/`tmux` ship with the manager, and other backends self-register
a `RuntimeProvider` on import (the manager resolves them from the registry, with no compile-time
dependency on them). Selectable backends:

- **`pty` (default).** The manager spawns the real `claude` (plugin plus env) in a
  pseudo-terminal it owns via **`@lydell/node-pty`** (prebuilt binaries for mac/Linux/Windows ×
  x64/arm64: zero compiler, zero `node-gyp`, ABI-stable). A real native TUI. The human watches
  or types in via `cotal attach <name>` (stream the PTY), and the manager keeps full OS-signal
  control (group-kill, restart). No external software to install.
- **`tmux` / `iTerm2` (opt-in).** For users already living in a multiplexer who want native
  panes or persistence; auto-detected (if already inside tmux, use it). You watch it natively,
  so `cotal attach` points you at `tmux attach -t cotal-<space>:<name>` rather than streaming.
- **`cmux` (integration).** Each agent gets its own [cmux](https://github.com/) tab. This is a
  true plug-in: the `cmux` runtime lives in **`@cotal-ai/cmux`** and self-registers a
  `RuntimeProvider` on import, so the manager spawns into tabs without depending on the package
  (a composition root opts in with one `import "@cotal-ai/cmux"`, which the `cotal` binary does).
  Like tmux you watch it natively, so `cotal attach` points you at the `cotal-<name>` tab rather
  than streaming (it is *not* tmux; cmux is its own CLI/app). Teardown is real: the runtime keeps
  the tab's workspace and surface ids, so `stop` types `/exit` for a clean leave then closes the
  tab (graceful) or closes it outright (hard). The manager must run inside a live cmux surface
  (cmux only authorizes its control socket from a real pane). Drives
  [`examples/02`](../examples/02-cmux-handoff/README.md). The package also self-registers a
  **`TerminalLayout`** provider (a host-side extension contract, not wire protocol:
  open/close/list editor tabs). The caller hands it a backend-agnostic `Tab` (panes as argv plus
  an optional split), and the provider builds the cmux-native layout, so `cotal setup` resolves
  it from the registry (`registry.resolve("terminal","cmux")`) to lay out its
  manager/console/`me` tabs with no cmux-specific shape (no layout JSON, no shell quoting)
  leaking into the CLI.
- **`byo` (floor).** The manager does not own the process; a human runs `cotal claude --role …`
  in their own terminal and the manager just tracks it via presence.
- **`host` (upgrade).** Headless via the Agent SDK for structured control plus true mid-turn
  interrupt; no native TUI (rendered from the event stream), observed via `cotal watch`.

**Running one.** `cotal supervise` starts a manager on the default terminal runtime (pty, or
tmux inside tmux); `cotal cmux` starts one that spawns each teammate into its own cmux tab (run
it from a cmux pane). The `cotal` binary aliases the Claude-Code connector as the default agent,
so `cotal_spawn` / `cotal_persona` / `cotal_despawn` work out of the box. For one-command
onboarding, `cotal cmux go` installs the plugin (`cotal setup`), brings up the mesh, and opens
the manager plus console plus a driving session in cmux.

The PTY carries the agent's **terminal I/O only**. Its mesh traffic still flows agent↔NATS
directly through the plugin, so owning the PTY does not put the manager on the message hot path.
**Restart-with-continuity:** a `pty`/`host` restart can `claude --resume <session_id>` to keep
the same context, and therefore the same instance id (see *Instance continuity*).

**Console (watching agents).** The viewer is a **separate entity** from the manager, but the
terminal *stream* comes from whoever owns the PTY (the manager), **not over the mesh**. PTY
frames are high-bandwidth terminal I/O, and routing them through NATS would put the manager back
on the message hot path. So the console uses **two channels**: the **mesh** (presence / `ps`) to
discover *which* agents exist and their status, and a **direct attach connection** to the PTY
owner for the actual pixels (the same stream `cotal attach` consumes, just rendered in a
browser).

- **Stack:** **xterm.js** (`@xterm/xterm` plus official addons `addon-fit`, `addon-webgl`,
  `addon-attach`, `addon-serialize`, all MIT, zero-dep) for the terminal, in **our own
  lightweight UI** (no framework lock-in, no forked dashboard). The manager exposes a local
  **attach endpoint** (HTTP plus WebSocket) that bridges PTY ↔ browser; `addon-attach` wires a
  pane straight to that socket, and `addon-serialize` replays scrollback on late attach.
- **Topology:** the manager hosts the attach endpoint (it holds the PTYs); the **console** runs
  **in-process** today, so the manager serves the page itself (`GET /` console, `GET /agents`
  the managed roster, `/assets/*` the vendored xterm bundles, `WS /attach/<name>` the PTY
  stream) on a loopback port (`COTAL_CONSOLE_PORT`, default `7878`). It can split later into a
  standalone `cotal console` node that discovers managers over the mesh and aggregates their
  streams.

**Control schema (first cut):** `start {role, name, agent}` · `stop {name, graceful?}` ·
`definePersona {name, persona, model?}` · `ps` · `status {instance}` · `attach {instance}` ·
`bind {instance, config}`. These are control-plane request/reply messages any authorized node
(CLI, dashboard, or an agent) can send; spawning is policy-gated. `definePersona` writes
`.cotal/agents/<name>.md` (via `saveAgentFile`), which a later `start` auto-discovers.

**Emergent payoff:** an agent can grow *and* shape the team without a human. It can ask the
manager for a teammate (`cotal_spawn`), mint a brand-new persona on the fly (`cotal_persona`,
saved as config, then spawnable), or tear one down (`cotal_despawn`, graceful or hard). The new
agent is a *peer*, not a child. Clearing space history, by contrast, is **operator-only**:
`cotal history clear` (or the admin-tier `purge` op), never an agent tool. The privileged
`STREAM.PURGE` is denied to agents.

## Hosting and onboarding

**Onboarding is manager-driven, still pure native.** You do not `exec claude` yourself; you ask
the **manager** to start an agent (over the control plane) and it performs the launch in a PTY it
owns (default `pty` runtime, see *Manager*):

```
cotal start --role planner --name alice      # CLI → control msg → manager spawns it
```

Under the hood the manager runs the *real* `claude` with the plugin attached and identity in the
environment, an ordinary Claude Code terminal with no wrapper in front of it:

```
COTAL_SPACE=main COTAL_NAME=alice COTAL_ROLE=planner \
  claude --dangerously-load-development-channels plugin:cotal@cotal-mesh
```

The plugin's MCP server reads `COTAL_SPACE` / `COTAL_NAME` / `COTAL_ROLE` at spawn and
**auto-joins**, so the agent is in presence by the time the session is interactive. `COTAL_ROLE`
resolves a **role template** (see *Roles and identity* below): card, optional persona, channel
and policy defaults, so a role's richness lives in a file, not the launch line. The plugin also
ships `/cotal` slash commands (`/cotal who`, `/cotal dm …`) for in-session control. (`/plugin
install cotal@cotal-mesh` once, beforehand.)

**Hosting mode** still sets how much inbound push is possible:

- **Attach mode (demo default).** The **manager** launches the agent as a native TUI in a PTY it
  owns (`@lydell/node-pty`, default `pty` runtime); you watch or drive it with `cotal attach`.
  Cotal attaches via the plugin (dual MCP server plus http hooks). Soft, between-turn push via
  the channel plus deterministic hook injection.
- **Host mode (upgrade path).** The manager runs the session headless via the Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, streaming input) for true mid-turn interrupt; observed via
  `cotal watch` rather than a native TUI. Documented, not built for the demo.

**Constraints (accepted).** Channels are a **research preview** (Claude Code ≥ v2.1.80;
permission relay ≥ v2.1.81). They require Anthropic auth (claude.ai or Console key, *not*
Bedrock / Vertex / Foundry), Team / Enterprise admins must enable them, and a custom
(non-allowlisted) channel launches with `--dangerously-load-development-channels plugin:cotal@…`
rather than `--channels`; the flag and protocol may still change. **Verified** on Claude Code
2.1.160: a `notifications/claude/channel` event delivered to an otherwise-**idle** session
autonomously wakes a turn (no keystroke, no `send-keys`), so the channel is the **wake** path: a
peer message fires a content-less *nudge* that pokes an idle session into a turn. Delivery itself
is the durable DM/chat stream consumer: the woken turn's `UserPromptSubmit` hook drains the
inbox, injects the messages, and **acks** them (the single, gating-free delivery path). The nudge
never acks or removes anything, so if the channel cannot run, the message simply waits on the
stream for the next turn. Nothing is lost.

**A channel must gate senders.** An ungated channel is a prompt-injection vector. Cotal gates on
the mesh side: the policy layer only emits notifications for allowlisted peers.

> **Adjacent native feature: Agent teams.** Claude Code ships an experimental
> `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` mode: multiple sessions, a shared task list, and
> peer-to-peer messaging (hook events `TeammateIdle` / `TaskCreated` / `TaskCompleted`). It
> validates the premise but is Claude-only, single-machine, and orchestrator-led. Cotal differs
> by being cross-agent (OpenCode too), a standardized NATS wire contract, lateral (not a tree),
> and local→cluster.

## Roles and identity

**Identity is an A2A `AgentCard`.** The **instance id** is the SLIM **instance** (this endpoint:
the presence key, the `to:` target, the future `did:key`). `name` is a cosmetic, reusable human
handle (see *Instance continuity*). `role` is the SLIM **service** (the addressable class). The
role label is therefore *load-bearing*: it is the **anycast** address, so `svc.reviewer` reaches
"whoever is a reviewer," not just a roster label.

**Addressing by name.** The instance id is the authoritative address; a `name` is a best-effort
convenience a client resolves against its observed roster. Resolution is deterministic and
fail-loud — an exact id wins, a unique name resolves (a live peer beats a stale offline one),
and a same-name collision among live peers **throws** with the candidates' ids instead of
silently picking the wrong one (re-address by id). With no live match a unique offline peer
still resolves best-effort, but multiple offline ghosts of one name also throw. Names carry no
uniqueness guarantee (the
manager auto-numbers its own spawns, `reviewer → reviewer-2`), and `/` is reserved in a name for
a future owner-scoped `owner/name` handle.

A **role** is a reusable template that produces a card, in three layers:

- **Advertisement** (A2A): `role`, `description`, and `skills[]` (each `id` / `name` / `tags` /
  `examples`), broadcast in presence for discovery plus anycast. *We use `skills` plus `tags` for
  "what it can do". A2A's `capabilities` field means protocol flags (streaming, push) that Cotal
  does not need yet, so we omit it to avoid the name collision.*
- **Persona** (optional, CrewAI-style role / goal / backstory): free-text instructions that
  condition the session, injected via the MCP server `instructions` plus a `SessionStart` hook.
  Omit it for a pure-primitive role; include it for a batteries-included specialist.
- **Runtime defaults** (Cotal): `channels` to auto-subscribe, inbound `policy` (`push-on-dm` /
  `pull-only` / `coalesce`), optional `model` / `effort`.

**File format:** `<role>.md`, mirroring the `SKILL.md` / agent idiom. Structured fields go in
YAML frontmatter (the machine-readable card plus runtime); the markdown body is the optional
persona (the system prompt).

```markdown
---
role: reviewer                       # → A2A service / anycast address
description: Reviews diffs for correctness, security, and style.
skills:
  - id: diff-review
    name: Diff review
    tags: [review, correctness, security]
subscribe: [general, reviews]        # active read set (auto-subscribe on boot)
allowPublish: [general, reviews]     # post ACL (default-deny if omitted)
inbound: push-on-dm                  # buffer/policy default
model: sonnet                        # optional
---

You are a reviewer on a shared Cotal mesh. Catch correctness and security issues in
peers' diffs before they land; DM the author, post a one-line summary to #reviews.
```

**Resolution and storage.** The plugin's MCP server resolves the role at spawn from
`COTAL_ROLE` (plus `COTAL_NAME` as the human label), reading `<role>.md` from `.cotal/roles/`
(project, version-controlled) layered over `~/.cotal/roles/` (user). So personas work in the
pure-native launch with **no CLI required**; a bare `COTAL_ROLE=reviewer` with no file falls back
to a label-only card.

**Instance continuity.** The instance id must track *context* continuity, not the human label.
`name` (e.g. `alice`) is a reusable, cosmetic handle; the **instance id** is the unique
addressable endpoint (the presence KV key, the `to:` target, the future `did:key`). Bind it to
the session's context. A **resumed** session (same Claude Code `session_id`, same context window)
keeps the **same** instance id, so presence, `contextId` correlation, and in-flight DMs stay
continuous. A **fresh** context window, even reusing the same `name`, is a **new** instance with
a **new** id; it must *not* inherit the prior one. Reusing an id across a discontinuous context
tells peers "same agent, same memory" when the new session has none, breaking reply correlation,
mis-delivering messages meant for the original, and wrongly inheriting its leases and
obligations. Rule: **same context ⇒ same id; new context ⇒ new id**, with `name` as the stable
handle that may map to different instances over time.

OpenCode has one explicit reset-in-place exception: `/new` inside the same managed OpenCode
process keeps the same mesh identity/creds but advances `contextId` to the new OpenCode session
id. That is process continuity, not credential reuse by a second process; two live processes must
never share the same creds.

**CLI (optional ergonomics).**

```
cotal role new reviewer            # scaffold .cotal/roles/reviewer.md ($EDITOR or flags)
cotal role list | show reviewer
cotal join claude --role reviewer --name carol   # resolve the role, build the card, exec native claude
```

`cotal join claude …` is sugar over the env launch: it resolves the role file, sets the env, and
`exec`s the real `claude` with the plugin, so the session stays pure Claude Code. Inline
`--description` / `--skill` override the file for a one-off that does not deserve a saved role.

## Technical mapping (NATS / JetStream)

**Status.** *Built today:* all three delivery modes over **JetStream streams** (durable
per-reader consumers, explicit ack-on-surface, `Nats-Msg-Id` dedup), presence via a KV bucket,
and the control plane via a hand-rolled queue subscription. *Decided next:* swap the control
plane to the **NATS Services API**, and move the rest of the routing meta into **message
headers** (only `Nats-Msg-Id` lives there today; the envelope is still JSON in the body). The
subject names and envelope shape below are stable across both.

**Why streams, not fire-and-forget.** Core NATS is at-most-once: a message is delivered only to
whoever is subscribed *at that instant*. Agents are constantly `working` or `offline`, so a DM, a
task, or a channel post sent while an agent is mid-turn is silently lost. JetStream **stores**
each message and gives every reader its own bookmark, so an agent catches up *at its own pace*
when it frees up, with nothing missed and no interruption required. One mechanism then covers
three things at once: live delivery, the inbound buffer, and late-join history.

- **Subjects (delivery modes).** The **sender is encoded in the subject**, a server-policeable
  fact, not a self-asserted payload field. `parseSubject()` is the single authority on the layout
  (the sender position is asymmetric: `[3]` for chat, `[4]` for the rest; read it through
  `parseSubject`, never index a subject directly).
  - multicast → `cotal.<space>.chat.<sender>.<channel…>` (broadcast to a channel)
  - unicast → `cotal.<space>.inst.<target>.<sender>` (one specific endpoint)
  - anycast → `cotal.<space>.svc.<role>.<sender>` (any one instance of a service, i.e. role)
  - control → `cotal.<space>.ctl.<service>.<sender>` (request/reply to a service)
  - Receivers read the sender **from the subject**; the payload `from` is advisory and is
    rejected on mismatch (fail-closed, on every receive path, see *Identity and authorization*).
  - The message *class* (channel/dm/anycast) is likewise **derived from the delivering subject**
    and surfaced to listeners as `MessageMeta.kind`: authenticated, **not** read from the
    forgeable payload `to`/`toService`. A peer publishing a broadcast with payload `{to:victim}`
    can no longer make it classify as a DM.
  - `*` matches one token, `>` matches trailing tokens. Subscribers wildcard the sender position
    (`chat.*.<channel>`, `inst.<myId>.*`); an observer taps `cotal.<space>.chat.>`.
- **Streams (one model, three read patterns).**
  - **`CHAT_<space>`** (multicast) captures `chat.>`, with **Limits** retention and
    `MaxMsgsPerSubject` (a capped per-channel backlog). **Every** agent reads **every** message
    via its **own** consumer/bookmark, at its own pace; a late joiner replays the window. This
    *is* both the inbound channel buffer and history.
  - **`DM_<space>`** (unicast) captures `inst.>`, with **Limits** retention. Each agent has a
    **per-instance durable consumer** (durable name = instance id, filter `inst.<id>.*`): its
    private inbox. Retained for **session length** (an `InactiveThreshold` retires the consumer
    when the context ends, mirroring the *Instance continuity* rule). Under auth this durable is
    **pre-created by the provisioner** and the agent only binds it (see *Identity and
    authorization*; the create-time filter is the DM confidentiality surface). `cotal_inbox`
    pulls the unread batch; push is the consumer delivering on attach.
  - **`TASK_<space>`** (anycast) captures `svc.>`, with **WorkQueuePolicy**. A **shared pull
    consumer per role** (durable `svc_<role>`, filter `svc.<role>.*`): a task with no worker
    online *waits*; the first available instance of the role grabs it; multiple online instances
    load-balance; the task is removed once acked. Under auth this durable is **pre-created
    per-role by the provisioner** and agents bind it (same create-time-filter reason as DM, to
    prevent cross-role work-stealing).
  - **Admin cleanup:** `cotal history clear --force` purges retained `CHAT_<space>` history;
    `--dms` also purges `DM_<space>`. `TASK_<space>` is deliberately untouched, because it is
    queued work, not replay history.
  - **Acks** are explicit and happen when a message is actually surfaced or injected (not on
    pull), so a crash before injection redelivers (`AckExplicit` plus `AckWait`).
- **Presence.** A NATS **KV bucket per space** (key = instance id), with bucket-level TTL plus a
  client-side expiry sweep (correct without relying on server delete-markers: per-key TTL on an
  updated key is unreliable on current servers, and heartbeats re-put the same key). States:
  `idle` / `waiting` / `working` / `offline`. Heartbeat is roughly TTL/3; a graceful leave
  publishes a final `offline`; a lapsed heartbeat is swept to `offline`. Offline peers stay in
  the roster. (Instant offline via `$SYS` disconnect events is a documented upgrade, see
  [Deferred](#deferred).) **Attention modes** (`open`/`dnd`/`focus`) are a local, per-agent
  *delivery preference*, not broadcast as presence or any wire field (the only core/wire change
  is `MessageMeta.kind` above).
- **Identity/discovery.** An A2A `AgentCard` (`id`=instance, `name`=handle, `role`=service,
  `kind`, `skills`/`tags`) carried in the presence record (our equivalent of `.well-known`). We
  omit A2A's `capabilities` field (protocol flags Cotal does not need) to avoid the name
  collision; "what it can do" lives in `skills`/`tags`.
- **Message envelope.** `{ id, ts, space, from:{id,name,role}, channel?, to?, toService?,
  parts[], replyTo?, contextId? }`. Routing meta (`id`, `from.id`, `contextId`, `replyTo`) moves
  to **NATS headers**: `id` as `Nats-Msg-Id` gives free server-side **dedup** under JetStream
  redelivery, and lets the buffer/policy layer peek (who / kind) without decoding the body;
  `parts[]` stay in the body. Exactly one delivery target: `channel` = multicast, `to` = unicast
  (instance), `toService` = anycast (service).
- **Artifacts.** Large `data` parts and A2A `Artifact`s exceed the roughly 1 MB message cap, so
  they go to a **JetStream Object Store** bucket per space (chunked); the message carries a
  reference part `{ kind:"artifact", ref:{ bucket, name, size, mime } }` and the recipient
  fetches on demand. (Part shape reserved now; delivery later.)
- **Control plane.** The **NATS Services API** (`micro`): the manager registers a service
  (endpoints `start`/`stop`/`ps`/`status`/`bind` under `ctl.<service>`, auto queue-grouped),
  which brings built-in **discovery** (`$SRV.PING`/`INFO`) and **stats** for free. The
  `ControlRequest`/`ControlReply` envelope is unchanged; only the transport underneath swaps.
- **Isolation.** One NATS **account** per space (later: split `space` into `org/namespace`). Auth
  mode (the default) makes the account a real boundary; `--open` is one shared account. See
  [spaces.md](spaces.md) for the space-vs-channel model and how spaces connect (export/import
  within an operator, a narrow bridge across operators).
- **Transport choice.** JetStream streams for all three delivery modes (durability plus
  per-reader bookmarks plus history), KV for presence, Object Store for artifacts, and the
  Services API for the control plane.
- **Auth and onboarding.** Open mode uses connection auth (token or user/password, optional TLS)
  via explicit `connect()` options (nats.js ignores credentials embedded in a URL), bundled into
  a one-string join link (`cotal(s)://token@host/space`,
  [`link.ts`](../packages/core/src/link.ts)). This is the `--open` dev path. The **default** is
  decentralized JWT auth, see *Identity and authorization* below.

## Identity and authorization (auth mode)

**On by default** (`cotal up`); `cotal up --open` runs an unauthenticated dev mesh instead. The
mesh binds **loopback** (`127.0.0.1`) by default in both modes; `--host 0.0.0.0` widens the bind,
independently of auth, so "network-reachable" never silently means "unauthenticated" (an open
network mesh takes `--open --host 0.0.0.0`, explicitly). Auth mode makes the mesh a real boundary
against untrusted peers *within* a shared space: an agent can only emit messages **as itself**,
only to its **declared `allowPublish` channels** (default-deny), and can only read **its own DMs**
and **chat within its `allowSubscribe`**, enforced by the NATS server, not by agent goodwill. It
is containment plus authenticity for a single trusted broker
(not non-repudiation; it does not survive an untrusted relay, which needs signed envelopes,
later).

- **Account = space, user = agent.** Decentralized **JWT**: an operator signs the account (=
  the space), and an account **signing key** signs per-agent users. Generated programmatically
  with `@nats-io/jwt` (no `nsc` dependency). The server runs operator mode plus a MEMORY resolver
  (operator JWT plus `system_account` plus the demo and SYS account JWTs); `cotal up` renders this
  config and is **load-or-create** on `.cotal/auth` (so the signing key that minted creds is
  always the one the server trusts).
- **The provisioner** ([`provision.ts`](../packages/core/src/provision.ts)) is the *signer
  capability*: it holds the account signing key and mints profile-scoped creds. The manager hosts
  it in Demo 1, but it is not manager-special: privilege attaches to the signer, and a space can
  run with no manager. `cotal mint <name> --profile <agent|observer|admin>` is the out-of-band
  path; the manager calls the same lib at spawn.
- **Identity = the agent's nkey public key**, used identically everywhere: `card.id`, the subject
  sender token, the JWT subject, and the DM/inbox durable names. Generated locally
  ([`identity.ts`](../packages/core/src/identity.ts)); the provisioner signs over only the public
  key (`fromPublic`). The endpoint accepts a creds file and adopts its identity as `card.id`
  (asserting any explicitly-set id matches, else publishes would silently deny).
- **Profiles** (a default-deny allow-list each, built from the shared subject/stream/durable
  builders so the ACLs cannot drift from the wire layout):
  - **agent:** publish only `chat.<ownId>.<ch>` for each `allowPublish` channel (the post ACL —
    **default-deny**, declared in the agent file; wildcard subtrees like `team.>` flow through),
    plus `inst.*.<ownId>` / `svc.*.<ownId>`, and `ctl.self.<ownId>` (self-service control, every
    agent — also carries the mediated join/leave op). The privileged `ctl.manager.<ownId>` is
    granted **only** when the agent file declares `capabilities: [spawn]` (default-deny otherwise).
    Presence PUT is scoped to its own key. **Reads are bounded by the read ACL (`allowSubscribe`):**
    the multi-channel live-tail durable `chat_<ownId>` is **bind-only** (pre-created by the
    provisioner, filter moved only by the mediated join/leave op — the agent can't self-widen),
    and history reads go through a single-filter `chathist_<ownId>` consumer with one create grant
    per `allowSubscribe` channel (the server pins the filter to the body, so no other channel is
    reachable; **no unfiltered Direct Get**). **DM and TASK are bind-only**, create denied.
    `sub.allow = [_INBOX_<ownId>.>]`.
  - **observer:** read-only. `sub.allow = [chat.>, _INBOX_<ownId>.>]`, pub = CHAT plus presence
    read verbs only. No chat/inst/svc publish (cannot post); DM streams are never named (DMs
    invisible). `cotal watch/console/web` run `consume:false` and narrow their tap to `chat.>`.
  - **admin:** elevated read-only (a "god-view" auditor). It has observer's pub allow plus
    DM-stream read verbs (still **write-nothing**, it cannot post), and `sub.allow` widened to the
    whole space (`cotal.<space>.>`), so its tap sees DMs (`inst.>`) and anycast (`svc.>`) *live*
    and it can backfill DM history (an ephemeral consumer on `DM_<space>`). DMs are plaintext plus
    ACL-gated, so this is a deliberate opt-in: `cotal web --admin` with an admin cred.
    `CONSUMER.CREATE` on `DM_<space>` is the DM-confidentiality surface, granted here only for
    this profile.
  - **manager:** privileged (broad), the provisioner host; pre-creates others' DM/TASK durables.
    (Eventually it should be scoped too, see limitations.)
- **The control plane is split into three privilege tiers**, op↔tier routed **fail-closed** by
  the manager (a misrouted op is rejected before anything acts: the cred gates *who reaches* a
  subject, this gates *what each subject honors*):
  - `ctl.self.<id>` (every agent): only the no-name self stop/despawn; the target resolves from
    the authenticated sender, so there is no field to forge.
  - `ctl.manager.<id>` (**privileged**, default-denied to agents, granted only when the agent
    file declares `capabilities: [spawn]`): spawn, plus stop/despawn/attach of the caller's
    **own** children (`spawner == caller`) and redefining its own personas. So spawn is a
    *declared capability*, off by default, enforced by nats-server, not a handler.
  - `ctl.admin.<id>` (reached only by the manager's allow-all profile, **no agent ever gets
    it**): the destructive / cross-agent operator ops: `purge`, and stop/despawn/attach/
    `definePersona` of *any* agent. Admin is transport-proven (reaching the subject = holding
    manager creds), so the handler never guesses it. `purge` lives here on purpose: on the
    privileged tier any spawn-capable agent could wipe space history.
- **`definePersona` separates content from policy.** Its write path takes only content (`model`
  / `persona`); `role` / `publish` / `capabilities` / `owner` are policy and have no slot, so a
  peer cannot grant itself a capability or seize ownership by redefining. A fresh name records its
  creator as `owner`; redefining an existing file preserves all policy and is allowed on the
  privileged tier only if `owner == caller`, else admin. Fail-closed: an ownerless (legacy or
  operator-written) file is admin-only.
- **Spawn is bounded (availability).** A synchronous gate caps concurrent plus in-flight agents
  (`MAX_AGENTS`), and a minimum-lifetime "cooling" floor bounds spawn↔despawn churn, so a
  capability-holding-but-compromised peer cannot fork-bomb the host. The ceiling holds under
  **every** runtime. *Caveat:* reaping a self-**exited** agent's slot is wired only where the
  runtime streams an exit signal (pty/tmux); under cmux a self-exited agent lingers until
  explicitly despawned. The cap still holds (it counts the corpse), only the reaping is deferred.
  Runtime-agnostic exit-reaping (cmux liveness → sweep-at-gate) is a tracked follow-up.
- **Spawned children get a declared env, not the manager's.** Runtimes pass only an explicit
  allow-list (`launchEnv()`: PATH / HOME / locale / TERM, plus the one model key the connector
  needs, plus the named `${VAR}` secrets any opted-in shared MCP server declares — all forwarded
  *by name*), never `process.env`, so the operator's *unrelated* secrets (cloud creds, tokens) stop
  bleeding into every agent. Honest scope: this closes **env-var** bleed only. It does **not**
  close model-key exfil (the agent holds the key in-process to do inference, which needs per-agent
  model auth) or filesystem reads (`HOME` is forwarded, so a child can still read `~/.aws` /
  `~/.ssh` off disk, which needs a workspace sandbox).
- **DM and TASK confidentiality close two leak paths.** *Delivery path:* all NATS delivery rides
  the connection inbox, and NATS delivers a subject to every subscriber, so a wildcard `_INBOX.>`
  subscribe would sniff peers' deliveries. Fix: a **per-identity inbox prefix**
  (`connect({inboxPrefix: _INBOX_<ownId>})`) plus `sub.allow = [_INBOX_<ownId>.>]`. *Stream
  path:* the consumer **create-time `filter_subject`** is not ACL-constrainable (it is in the
  request payload for the durable API), so an allowed create could filter to a victim's inbox or
  another role's queue. Fix: the privileged provisioner **pre-creates** the DM (`dm_<id>`, filter
  `inst.<id>.*`) and TASK (`svc_<role>`, filter `svc.<role>.*`) durables; agents **bind only**,
  and **all** create forms on `DM_<space>`/`TASK_<space>` are denied.
- **Streams are infrastructure**, pre-created at `cotal up` for **both** modes (agents are denied
  `STREAM.CREATE` under auth; open connects with no creds). The presence and channels KV buckets
  are streams too, pre-created the same way. Open mode also keeps the endpoint's lazy first-join
  create, so a mesh started without `cotal up` still works. But pre-creating means stream-touching
  ops that run before any endpoint has joined (`cotal spawn`'s DM-inbox provisioning, `cotal
  history clear`) find the streams instead of failing with `StreamNotFound`.
- **Denials are loud, never silent.** NATS publish permission violations surface only on the
  connection status stream, so the endpoint routes them to its `error` event with a "denied, not
  absent" message. This is why an over-tight ACL shows up as a logged denial, not a peer that
  mysteriously looks absent.

**Known limitations (Demo 1):**

- **Standalone/late-join DM receipt** needs a *connected* provisioner (the manager) to pre-create
  `dm_<id>`; chat/task/presence late-join works with no manager. The full fix is the callout
  stage. (It fails loud via the denial log, not silent.)
- **Signing key plus operator seed are hot** in `.cotal/auth` (the mint/manager box), not yet
  key-confined; the "real boundary" holds only given operator-controlled cred distribution. The
  operator seed should be cold-stored (it is the root; only needed for account setup/rotation).
- **No credential revocation or TTL** on minted creds yet, and this bounds containment.
  `cotal_despawn` cuts an agent's **session**, not its **credential**. A compromised agent that
  copied its own (no-TTL bearer) creds can reconnect afterward, from any host, until the space
  signing key is **rotated** (which re-mints *everyone*, the only per-cred revocation today) or it
  is cut at the network. Despawn is the immediate lever, not full containment of a compromised
  identity; per-cred TTL/rotation is the deferred fix (auth-callout, below).
- `isReachable` conflates auth-failure with server-down (a misleading "run cotal up").
- The **manager profile is allow-all**, fine for Demo 1, but the most-privileged identity should
  eventually be scoped for the full untrusted-peer claim.
- **Callout stage (later, additive):** auth-callout (NATS 2.10+) mints creds *at connect* from a
  per-space/per-profile bootstrap token (the `token@` the join link already parses), moving the
  signing key into the callout service (true key-confinement) and removing the out-of-band mint.

## Deferred

Designed-for, not built.

- **Sessions + moderator:** managed group membership (admit/remove), per SLIM's Group session.
- **Verifiable identity:** NKey/JWT decentralized auth plus the account-per-space boundary are
  **built** (on by default, see *Identity and authorization* above). What remains deferred is
  *non-repudiation*: signed message envelopes (and `instance` as a `did:key`) so authenticity
  survives an untrusted relay or federation hop, not just a single trusted broker.
- **Instant offline (`$SYS`):** subscribe the manager to `$SYS.ACCOUNT.<id>.DISCONNECT` for
  immediate offline detection instead of waiting out the heartbeat window. Needs `system_account`
  config plus a privileged connection, connection names that carry the instance id (not just the
  handle), and the manager as presence reconciler (a dead agent cannot mark itself offline). The
  heartbeat sweep remains the floor when no reconciler is running.
- **Artifact delivery:** the Object Store path above (shape reserved, transfer not built).
