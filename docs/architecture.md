# Cotal — Architecture notes (draft)

> Implementation detail and research grounding, split out of [OVERVIEW.md](OVERVIEW.md)
> to keep the overview lean. All proposals, not locked.

## Influences: A2A + SLIM

Cotal borrows vocabulary and shapes from two agent frameworks so we stay interoperable
rather than siloed — but implements them over NATS/JetStream.

**From A2A** — the *data shapes*: `AgentCard` (identity / role / tags / skills),
`Message` / `Part` (text & data), `Artifact`, and correlation ids (`contextId`). We do
**not** adopt A2A's HTTP/JSON-RPC transport, `Task` RPCs, or its request/response server
model — those don't fit lateral pub/sub.

**From SLIM** — the *addressing and delivery model*:
- **Hierarchical address** `space / service / instance` (SLIM's `org/namespace/service/
  instance`). In Cotal: `space` = the collaboration; `service` = the addressable class
  (a role / agent-type, e.g. `reviewer`); `instance` = one specific endpoint.
- **Three delivery modes:** **multicast** (to a channel — everyone), **unicast** (to one
  instance), **anycast** (to *any one* instance of a service — delegation / load-balancing).
- **Mentions (Cotal addition):** a multicast message may carry `mentions: [name…]` — peers
  called out by name. It's a *priority hint*, not a routing target — the message still reaches the
  whole channel, but a mentioned peer is woken immediately while everyone else picks it up when
  next idle (see [two-tier delivery](claude-code-integration.md#message-delivery-stream-backed)).
  **Names**, not instance ids, ride the wire, so the receiver's self-match survives reconnects (a
  per-connection id wouldn't). The sender validates names against its roster and **throws** on an
  unknown one (a typo aborts the whole broadcast rather than silently dropping the @) — with the
  honest limit that you can only mention peers this client has **observed**: a peer offline long
  enough to age out of presence, or one not yet seen after connect, is "unknown".
- **Hierarchical channels** (NATS-subject style): a channel name is dotted — publish to a
  concrete `team.backend`, subscribe to a subtree with `team.>` (or one level with `team.*`).
  Flat names (`general`) still work. Publishing is always concrete; only subscriptions wildcard.
- **Channel membership** (who's on a channel) is **server-known, not self-reported**: a peer
  joins a channel by creating a chat-stream durable consumer, so `consumers.list` *is* the
  membership — unforgeable, no presence field to lie in. `endpoint.channelMembers(channel)`
  reads that broker truth and joins it with presence for liveness: a durable whose peer is gone
  but lingering (reconnect grace) shows as a stale member (`live:false`), not a phantom
  listener. Privileged read: `consumers.list` needs `$JS.API.CONSUMER.LIST.CHAT_<space>`, which
  only the allow-all **manager** profile holds today — agents/observer/admin are denied, so it's
  manager-served (a dashboard profile is a one-line grant away). Observability only, never an
  agent gate on sending.
- **Channel registry** (config *about* a channel) lives in a per-space KV bucket
  (`cotal_channels_<space>`, sibling of presence): per-channel `{ replay?, description?,
  instructions? }` plus a space-wide default under a reserved key. **Channel-global, not
  per-subscriber** — the same channel replays (or not) for everyone. Writes are **privileged**
  (`cotal up --channels <file>` to seed; `cotal channels set` at runtime); everyone reads it via
  a live KV watch (`endpoint.getChannelConfig` / `channelReplay`, and enriched `listChannels`).
  `replay` toggles whether a fresh joiner gets history backfilled; `description`/`instructions`
  reach the model, so the registry is a prompt-injection surface — text is length-bounded at the
  write path and surfaced to agents as attributed, advisory data (never system-prompt text).
- **Replay mechanism — tail + backfill.** `deliver_policy` is consumer-wide, so it can't honor
  per-channel replay; instead the chat durable is a `DeliverPolicy.New` **tail** ("from now on")
  and history is an explicit **per-channel backfill on join** via JetStream Direct Get (a read
  verb — no consumer create), gated by the channel's replay policy. A per-channel join watermark
  (the stream frontier at join) lets the tail ack-drop pre-join messages, so a no-replay channel
  starts clean and a replay backfill never double-delivers. **How far back** is the registry's
  `replayWindow` (`"24h"`), realized natively as a Direct-Get `start_time` — not a client-side
  count. **No-replay is noise control, not confidentiality** — the drop is client-side and every
  peer can read a channel's history on demand (chat is world-readable, agents hold `DIRECT.GET`),
  so it must never be documented or relied on as privacy/access-control. Anything confidential
  uses DM/anycast (private streams, consumer-create-deny), never a no-replay channel. *Why one multi-filter durable and not one consumer per channel (which would let the
  broker replay natively)? A per-channel consumer is named `chat_<id>_<channel>`, and consumer
  names can't contain `.`, so that's a single ACL token — and NATS permission wildcards are
  token-granular, so it can't be scoped to one agent. One fixed-name durable is what keeps the
  per-agent grant tight AND makes dynamic join just a filter edit (no per-channel grant).*
- **Dynamic subscription.** A peer joins/leaves channels **mid-session** —
  `endpoint.joinChannel`/`leaveChannel` mutate the existing chat durable's `filter_subjects` via
  `consumers.update` (same durable, no teardown; rides the self-scoped create grant). So channel
  membership is a live view, and join triggers the replay backfill above. On **restart** the
  durable's filter is **reconciled to the agent's current config** (channels the config gained are
  backfilled like a join; channels it lost are dropped) — an unchanged config is a pure resume.
- **Sessions + moderator** (managed groups with admit/remove) — *deferred*, but the design
  leaves room for it.

We do **not** adopt SLIM's Rust data plane, gRPC transport, or MLS encryption — NATS/
JetStream replaces that layer and adds the durability + presence SLIM leaves to the app.

**Identity** is an A2A `AgentCard` whose `instance` id is a throwaway UUID today, shaped
to later become a **DID** (`did:key` — a self-certifying public-key identifier) so identity
can be cryptographically verifiable and decentralized (see *Deferred*).

## Package layout & dependency tiers

Four tiers, one-way dependencies — `packages/` is the standard, everything else builds on
it. `pnpm-workspace.yaml` globs all four (`packages/*`, `extensions/*`, `implementations/*`,
`examples/*`).

- **`packages/*` — core.** The protocol: subjects, schemas, the NATS client, and the shared
  contracts extensions implement (e.g. `Connector`). Everything depends on it; it depends on
  nothing in the repo.
- **`extensions/*` — pluggable adapters.** A connector (Claude Code, Codex, …) is the first
  extension *kind*; transport / auth could follow. Each is its own package that
  **peer-depends** on core (so it binds to the host's *single* core instance, not a private
  copy) and exports an object implementing a core contract. They're **picked by explicit
  wiring** at the composition root — the manager is handed the connectors it may spawn, and an
  unknown agent type **throws** (no silent fallback).
- **`implementations/*` — opinionated surfaces.** CLI, web, … — each a self-contained package
  over core. **Implementations never import each other** — keeps the dependency graph
  acyclic (no import loops).
- **`examples/*` — use cases.** Private (never published) packages — demos, benchmarks. An
  example is the **composition root**: it may depend on *several* implementations and picks
  which extensions to wire in.

**Why no sideways imports.** Two implementations don't need each other's code to work
together — they're lateral peers that meet **at runtime in a shared space over NATS**, not at
compile time in an import. A demo that runs both a CLI and a web peer just starts each pointed
at the same `space`; coordination flows through the mesh. So the CLI package and the web
package stay independent, each ignorant of the other, and the example wires them.

```
examples ──→ one-or-more implementations ──→ core ←(peer)── extensions
                      (interoperate at runtime over NATS, not via imports)
```

The migration is done: `demos/` use-cases are now `examples/`, the connector is split into
`@cotal-ai/connector-core` (shared mesh runtime) plus three thin adapters — `@cotal-ai/connector-claude-code`
(`claudeConnector`), `@cotal-ai/connector-codex` (`codexConnector`), and `@cotal-ai/connector-opencode`
(`opencodeConnector`) — `extensions/` packages that
**peer-depend** on core and export a `Connector`, and `@cotal-ai/cli` + `@cotal-ai/manager` are
`implementations/` packages.
Assembly lives at the **composition root** — an example (`examples/01/src/manager.ts`) imports
the manager + the connectors it wants and hands them to the manager (`new Manager({ connectors:
[…] })`), which resolves one by agent type when spawning (unknown ⇒ throws). Implementations
stay self-contained and never import each other: the `cli` drives the manager purely over the
mesh (`start`/`stop`/`ps` control requests), so neither imports the other — only the example
wires them together.

## Integration surfaces (Claude Code + Codex + OpenCode)

Each target agent exposes the same four surfaces; the adapters share one runtime
(`@cotal-ai/connector-core`) and differ only in how they bind to their host. For **Claude Code**
the whole adapter ships as one **plugin**, and three of the four surfaces collapse into a
**single dual-purpose MCP server**:

| | Claude Code | Codex CLI |
|---|---|---|
| **Outbound — ambient** | `http` lifecycle hooks → POST to the local daemon (native http hook, no curl shim) | — (hooks are sandboxed; presence is self-reported via `cotal_status`) |
| **Outbound — deliberate** | MCP tools `cotal_send`/`cotal_dm`/`cotal_anycast` *(same server as the channel)* plus optional authenticated `cotal_feedback` beta egress | MCP tools (same) |
| **Inbound — pull** | MCP tool `cotal_inbox` *(same server)* | MCP tool (same) |
| **Inbound — push** | Two native paths — see below | — (pull-only: `cotal_inbox`) |

**The dual-purpose server.** A Claude Code *channel* **is** an MCP server that declares the
`claude/channel` capability and pushes events via `notifications/claude/channel`. So one
Cotal MCP server is simultaneously the channel (push), the deliberate-out tools
(`cotal_send`/`cotal_dm`/`cotal_anycast` — one per addressing mode, doubling as the channel's
"reply tools"), and `cotal_inbox` (pull): one process, one stdio connection.
Inbound mesh messages arrive in context as
`<channel source="cotal" from="bob" kind="dm" channel="general">…</channel>`; each meta key
becomes a tag attribute the agent can read for routing.

`cotal_feedback` is deliberately outside mesh routing: the shared tool surface always exposes a
feedback tool (MCP for Claude/Codex, native plugin tool for OpenCode). With `COTAL_FEEDBACK_KEY` set
it posts to the keyed intake with `Authorization: Bearer <tester-key>` and the server maps the key to
a tester; without a key it posts to the public cotal.ai intake with a contact email instead. The
payload includes `origin` (`human` when the user asked the agent to pass feedback along, `agent` when
the agent auto-reports a major Cotal issue). The intake server writes JSONL as the source of truth,
then publishes an attributed, untrusted feedback item into our internal Cotal `#feedback` channel for
triage.

**Codex.** The Codex adapter ships the same `cotal_*` MCP server, injected at launch via `codex -c`
config overrides (no plugin; the operator's `~/.codex` is never written). Codex is **pull-only**: it
sandboxes lifecycle hooks (they can't reach a control socket), so there is no hook injection or
`claude/channel` push — the agent reads peer messages with `cotal_inbox` and reports presence with
`cotal_status`. Spawned agents run autonomously (`approval_policy="never"` +
`sandbox_mode="workspace-write"`). Attention modes (`open`/`dnd`/`focus`) are a push concept, so on
pull-only Codex they're inert — `cotal_inbox` already drains everything on demand.

**OpenCode.** OpenCode has a native plugin runtime, so its adapter is **not** an MCP server at all:
a single plugin — injected at launch via `OPENCODE_CONFIG_CONTENT` (inline config merged into the
operator's, never written to disk) — runs inside the OpenCode process and does all four surfaces. The
connector launches the real `opencode` **TUI** (foreground, watchable — like Claude Code launches
`claude`), and the plugin renders the shared `cotal_*` tools as native plugin tools (from
`cotalToolSpecs`, the same source the MCP adapters render, so the surface can't drift); derives
presence from OpenCode's event stream (`session.status` busy → working, `session.idle` → idle,
`permission.asked` → waiting); and **drives the visible session** — it injects each waiting peer
batch as a turn via the prompt API (`session.promptAsync` on the session the TUI displays, so it
can't race the TUI input box and the TUI renders it live), acking on `session.idle`, so a human
watching the TUI sees the agent work and can type into the same session. So unlike Codex it is
push-capable, and unlike Claude Code it needs no separate hooks or control socket — the plugin holds
the mesh connection for the session and closes it in `dispose`. Spawned agents run autonomously
(`permission: "allow"`). The foreground viewer is swappable: an agent file's optional `face:` id
makes the launcher attach an animated avatar viewer to the session instead of the chat TUI
(`COTAL_FACE_BIN` must point at a face-term-compatible script; it watches the same event stream and
can still send prompts into the session). A face-hosted agent is also told to embed `[[face:X]]`
emotion tags in its send text — the viewer reads them from the tool-call input to animate the
avatar, and the send tools strip them before publishing, so they never reach the wire.

**Two injection paths (different control profiles), composed.**

- **Channel notifications** — async push. We own `content` and tag attributes fully, and the
  daemon owns *emit* timing (drop / queue / coalesce / release — the policy layer). The model
  *sees* it: idle agent → ~immediately (the event wakes a turn — **empirically verified**, see
  *Constraints*); busy agent → at the next **turn boundary** (queued events coalesce into one
  batch); mid-turn interrupt → **not in attach mode**. Research-preview gated (see *Constraints*).
- **Hook `additionalContext`** — deterministic. A hook is *our* code at a fixed lifecycle
  point, not research-preview gated. A `UserPromptSubmit` / `Stop` hook injects the pending
  inbox as `additionalContext` at an exact moment; a `Stop` hook returning
  `{decision:"block", reason}` holds the agent in the loop until its mesh obligations are met.

Hooks are the **spine** (no gating, fully deterministic, turn-boundary delivery + the
keep-working lever); the **channel** adds async "wake me when idle/away."

**Permission relay (same channel, control-plane payoff).** The channel protocol also carries
*tool-permission* requests, so tool approval can happen **over the mesh** on the same dual-purpose
server — no extra transport. The agent declares the `claude/channel/permission` capability; a
pending tool call surfaces as `notifications/claude/channel/permission_request`
(`{request_id, tool_name, description, input_preview}`) which the daemon relays onto the mesh, and
a verdict returns via `notifications/claude/channel/permission` (`{request_id,
behavior:"allow"|"deny"}`). A peer — a human at the CLI, a future moderator, or a policy node —
can then admit or deny an agent's action *through Cotal*, making tool approval a first-class
control-plane flow rather than a per-terminal prompt. (Claude Code ≥ v2.1.81; same research-preview
gating as the channel.)

**Presence from hooks.** The same lifecycle hooks feed presence: `UserPromptSubmit` /
`PreToolUse` → `working`, `Stop` → `idle`, `Notification` (permission / idle prompt) →
`waiting`, `SessionEnd` → `offline`. Ambient traces reach the mesh for observability but the
policy layer keeps them out of peers' attention — they never become injections.

**What we control (accepted for the demo):**

| | |
|---|---|
| *What* we inject (content, routing meta) | full — daemon-side |
| *Whether* to inject (ambient vs actionable, allowlist, coalesce, rate-limit) | full — daemon policy |
| *When we emit* | full |
| *When the model sees it* | channel: idle→now, busy→turn boundary · hook: exact lifecycle point |
| *Mid-turn interrupt of a busy agent* | host mode only (Agent SDK) |
| *Whether the model acts* on an injection | steered via the server `instructions` + meta tags, not forced |

## Manager (agent supervisor)

The CLI doesn't spawn agents itself — a long-lived **manager** owns their lifecycle, and the
CLI asks it over the mesh. The manager is itself a **node** (presence + a control subject), so
managing Cotal agents happens *through Cotal* — the control plane's first real consumer.

**Supervisor, not orchestrator.** It owns *process lifecycle + config binding* (start / stop /
restart, resolve a role, bind env + policy to a session) — **not** what work agents do. Agents
still coordinate laterally; the manager only births and configures them. (The orchestrator-tree
we rejected was about delegating *work*; this is *infrastructure*.)

**Supervisor-only scope.** The manager is **off the message hot path**: each agent self-connects
to the mesh via its own plugin (own presence, messaging, inbound policy). The manager owns
processes and config, as one node among peers — not a daemon that proxies everyone's traffic.

**Lifecycle = two planes.** *Observing* lifecycle (alive? idle / working / offline) is
**mesh-native via presence** — the agent self-reports through its plugin, so `ps` / `status`
read presence and work **regardless of how the agent was launched** (manager-spawned, a human's
own terminal, or headless). *Forcing* lifecycle (start / stop / restart) is the only part that
needs an OS handle on the process. So the manager owns processes to *control* them, but observes
everything through the mesh — and a BYO-terminal agent the manager never spawned still shows up
and reports status.

**Spawn via a pluggable `Runtime` (no tmux dependency).** Starting / stopping / attaching is
abstracted behind one interface (`spawn → handle`, `stop`, `status`, `attach`, optional
`interrupt`) — think *pm2 / docker for agent TUIs*. `Runtime` is a **core extension contract**
like `Connector`/`Command`: `pty`/`tmux` ship with the manager, and other backends self-register
a `RuntimeProvider` on import (the manager resolves them from the registry — it has no compile-time
dependency on them). Selectable backends:
- **`pty` (default)** — the manager spawns the real `claude`/Codex (plugin + env) in a
  pseudo-terminal it owns via **`@lydell/node-pty`** (prebuilt binaries for mac/Linux/Windows ×
  x64/arm64 — zero compiler, zero `node-gyp`, ABI-stable). A real native TUI; the human watches
  or types in via `cotal attach <name>` (stream the PTY), and the manager keeps full OS-signal
  control (group-kill, restart). No external software to install.
- **`tmux` / `iTerm2` (opt-in)** — for users already living in a multiplexer who want native
  panes / persistence; auto-detect (if already inside tmux, use it). You watch it natively, so
  `cotal attach` points you at `tmux attach -t cotal-<space>:<name>` rather than streaming.
- **`cmux` (integration)** — each agent gets its own [cmux](https://github.com/) tab. This is a
  true plug-in: the `cmux` runtime lives in **`@cotal-ai/cmux`** and self-registers a `RuntimeProvider`
  on import, so the manager spawns into tabs without depending on the package — a composition root
  opts in with one `import "@cotal-ai/cmux"` (the `cotal` binary does). Like tmux you watch it
  natively, so `cotal attach` points you at the `cotal-<name>` tab rather than streaming (it is
  *not* tmux — cmux is its own CLI/app). Teardown is real: the runtime
  keeps the tab's workspace + surface ids, so `stop` types `/exit` for a clean leave then closes the
  tab (graceful) or closes it outright (hard). The manager must run inside a live cmux surface (cmux
  only authorizes its control socket from a real pane). Drives
  [`examples/02`](../examples/02-cmux-handoff/README.md).
- **`byo` (floor)** — the manager doesn't own the process; a human runs `cotal claude --role …`
  in their own terminal and the manager just tracks it via presence.
- **`host` (upgrade)** — headless via the Agent SDK / Codex app-server for structured control +
  true mid-turn interrupt; no native TUI (rendered from the event stream), observed via
  `cotal watch`.

**Running one.** `cotal supervise` starts a manager on the default terminal runtime (pty, or tmux
inside tmux); `cotal cmux` starts one that spawns each teammate into its own cmux tab (run it from a
cmux pane). The `cotal` binary aliases the Claude-Code connector as the default agent, so
`cotal_spawn` / `cotal_persona` / `cotal_despawn` work out of the box. For one-command onboarding,
`cotal cmux go` installs the plugin (`cotal setup`), brings up the mesh, and opens the manager
+ console + a driving session in cmux.

The PTY carries the agent's **terminal I/O only** — its mesh traffic still flows agent↔NATS
directly through the plugin, so owning the PTY doesn't put the manager on the message hot path.
**Restart-with-continuity:** a `pty`/`host` restart can `claude --resume <session_id>` to keep
the same context — and therefore the same instance id (see *Instance continuity*).

**Console (watching agents).** The viewer is a **separate entity** from the manager, but the
terminal *stream* comes from whoever owns the PTY (the manager), **not over the mesh** — PTY
frames are high-bandwidth terminal I/O, and routing them through NATS would put the manager back
on the message hot path. So the console uses **two channels**: the **mesh** (presence / `ps`) to
discover *which* agents exist and their status, and a **direct attach connection** to the PTY
owner for the actual pixels (same stream `cotal attach` consumes, just rendered in a browser).
- **Stack:** **xterm.js** (`@xterm/xterm` + official addons `addon-fit`, `addon-webgl`,
  `addon-attach`, `addon-serialize` — all MIT, zero-dep) for the terminal, in **our own
  lightweight UI** (no framework lock-in, no forked dashboard). The manager exposes a local
  **attach endpoint** (HTTP + WebSocket) that bridges PTY ↔ browser; `addon-attach` wires a pane
  straight to that socket, `addon-serialize` replays scrollback on late attach.
- **Topology:** the manager hosts the attach endpoint (it holds the PTYs); the **console** runs
  **in-process** today — the manager serves the page itself (`GET /` console, `GET /agents` the
  managed roster, `/assets/*` the vendored xterm bundles, `WS /attach/<name>` the PTY stream) on a
  loopback port (`COTAL_CONSOLE_PORT`, default `7878`). It can split later into a standalone
  `cotal console` node that discovers managers over the mesh and aggregates their streams.

**Control schema (first cut):** `start {role, name, agent}` · `stop {name, graceful?}` ·
`definePersona {name, persona, role?, model?}` · `ps` · `status {instance}` · `attach {instance}` ·
`bind {instance, config}` — control-plane request/reply messages any authorized node (CLI,
dashboard, or an agent) can send; spawning is policy-gated. `definePersona` writes
`.cotal/agents/<name>.md` (via `saveAgentFile`), which a later `start` auto-discovers.

**Emergent payoff:** an agent can grow *and* shape the team without a human — ask the manager for
a teammate (`cotal_spawn`), mint a brand-new persona on the fly (`cotal_persona` → saved as config
→ spawnable), or tear one down (`cotal_despawn`, graceful or hard). The new agent is a *peer*, not
a child.

## Hosting & onboarding

**Onboarding — manager-driven, still pure native.** You don't `exec claude` yourself; you ask
the **manager** to start an agent (over the control plane) and it performs the launch in a PTY it
owns (default `pty` runtime — see *Manager*):

```
cotal start --role planner --name alice      # CLI → control msg → manager spawns it
```

Under the hood the manager runs the *real* `claude` with the plugin attached and identity in the
environment — an ordinary Claude Code terminal, no wrapper in front of it:

```
COTAL_SPACE=demo COTAL_NAME=alice COTAL_ROLE=planner \
  claude --dangerously-load-development-channels plugin:cotal@cotal-mesh
```

The plugin's MCP server reads `COTAL_SPACE` / `COTAL_NAME` / `COTAL_ROLE` at spawn and
**auto-joins**, so the agent is in presence by the time the session is interactive. `COTAL_ROLE`
resolves a **role template** (see *Roles & identity* below) — card, optional persona, channel /
policy defaults — so a role's richness lives in a file, not the launch line. The plugin also
ships `/cotal` slash commands (`/cotal who`, `/cotal dm …`) for in-session control.
(`/plugin install cotal@cotal-mesh` once, beforehand.)

**Hosting mode** still sets how much inbound push is possible:

- **Attach mode (demo default)** — the **manager** launches the agent as a native TUI in a PTY
  it owns (`@lydell/node-pty`, default `pty` runtime); you watch / drive it with `cotal attach`.
  Cotal attaches via the plugin (dual MCP server + http hooks). Soft / between-turn push via the
  channel plus deterministic hook injection. Codex is **pull-mostly** (its plain TUI has no clean
  external-injection path).
- **Host mode (upgrade path)** — the manager runs the session headless via the Agent SDK
  (`@anthropic-ai/claude-agent-sdk`, streaming input) / Codex app-server for true mid-turn
  interrupt on both agents; observed via `cotal watch` rather than a native TUI. Documented,
  not built for the demo.

**Constraints (accepted).** Channels are a **research preview** (Claude Code ≥ v2.1.80; permission
relay ≥ v2.1.81): they require Anthropic auth (claude.ai or Console key — *not* Bedrock / Vertex /
Foundry), Team / Enterprise admins must enable them, and a custom (non-allowlisted) channel
launches with `--dangerously-load-development-channels plugin:cotal@…` rather than `--channels`;
the flag / protocol may still change. **Verified** on Claude Code 2.1.160: a `notifications/claude/
channel` event delivered to an otherwise-**idle** session autonomously wakes a turn (no keystroke,
no `send-keys`) — so the channel is the **wake** path: a peer message fires a content-less *nudge*
that pokes an idle session into a turn. Delivery itself is the durable DM/chat stream consumer:
the woken turn's `UserPromptSubmit` hook drains the inbox, injects the messages, and **acks** them
(the single, gating-free delivery path). The nudge never acks or removes anything, so if the channel
can't run the message simply waits on the stream for the next turn — nothing is lost.

**A channel must gate senders** — an ungated channel is a prompt-injection vector. Cotal gates
on the mesh side: the policy layer only emits notifications for allowlisted peers.

> **Adjacent native feature — Agent teams.** Claude Code ships an experimental
> `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` mode: multiple sessions, a shared task list, and
> peer-to-peer messaging (hook events `TeammateIdle` / `TaskCreated` / `TaskCompleted`). It
> validates the premise but is Claude-only, single-machine, and orchestrator-led. Cotal
> differs by being cross-agent (Codex too), a standardized NATS wire contract, lateral (not a
> tree), and local→cluster.

## Roles & identity

**Identity is an A2A `AgentCard`**: the **instance id** = the SLIM **instance** (this endpoint —
the presence key, `to:` target, future `did:key`); `name` is a cosmetic, reusable human handle
(see *Instance continuity*); `role` = the SLIM **service** (the addressable class). The role
label is therefore *load-bearing* — it's the **anycast** address, so `svc.reviewer` reaches
"whoever is a reviewer," not just a roster label.

A **role** is a reusable template that produces a card, in three layers:

- **Advertisement** (A2A) — `role`, `description`, and `skills[]` (each `id` / `name` /
  `tags` / `examples`), broadcast in presence for discovery + anycast. *We use `skills` +
  `tags` for "what it can do"; A2A's `capabilities` field means protocol flags (streaming,
  push) that Cotal doesn't need yet, so we omit it to avoid the name collision.*
- **Persona** (optional — CrewAI-style role / goal / backstory) — free-text instructions that
  condition the session, injected via the MCP server `instructions` + a `SessionStart` hook.
  Omit it for a pure-primitive role; include it for a batteries-included specialist.
- **Runtime defaults** (Cotal) — `channels` to auto-subscribe, inbound `policy`
  (`push-on-dm` / `pull-only` / `coalesce`), optional `model` / `effort`.

**File format** — `<role>.md`, mirroring the `SKILL.md` / agent idiom: structured fields in
YAML frontmatter (the machine-readable card + runtime), the markdown body is the optional
persona (the system prompt).

```markdown
---
role: reviewer                       # → A2A service / anycast address
description: Reviews diffs for correctness, security, and style.
skills:
  - id: diff-review
    name: Diff review
    tags: [review, correctness, security]
channels: [general, reviews]         # auto-subscribe on join
inbound: push-on-dm                  # buffer/policy default
model: sonnet                        # optional
---

You are a reviewer on a shared Cotal mesh. Catch correctness and security issues in
peers' diffs before they land; DM the author, post a one-line summary to #reviews.
```

**Resolution & storage.** The plugin's MCP server resolves the role at spawn from `COTAL_ROLE`
(+ `COTAL_NAME` as the human label), reading `<role>.md` from `.cotal/roles/` (project,
version-controlled) layered over `~/.cotal/roles/` (user). So personas work in the pure-native
launch with **no CLI required**; a bare `COTAL_ROLE=reviewer` with no file falls back to a
label-only card.

**Instance continuity.** The instance id must track *context* continuity, not the human label.
`name` (e.g. `alice`) is a reusable, cosmetic handle; the **instance id** is the unique
addressable endpoint — the presence KV key, the `to:` target, the future `did:key`. Bind it to
the session's context: a **resumed** session (same Claude Code `session_id`, same context
window) keeps the **same** instance id, so presence, `contextId` correlation, and in-flight DMs
stay continuous. A **fresh** context window — even reusing the same `name` — is a **new**
instance with a **new** id; it must *not* inherit the prior one. Reusing an id across a
discontinuous context tells peers "same agent, same memory" when the new session has none —
breaking reply correlation, mis-delivering messages meant for the original, and wrongly
inheriting its leases/obligations. Rule: **same context ⇒ same id; new context ⇒ new id**, with
`name` as the stable handle that may map to different instances over time.

**CLI (optional ergonomics).**

```
cotal role new reviewer            # scaffold .cotal/roles/reviewer.md ($EDITOR or flags)
cotal role list | show reviewer
cotal join claude --role reviewer --name carol   # resolve the role, build the card, exec native claude
```

`cotal join claude …` is sugar over the env launch: it resolves the role file, sets the env,
and `exec`s the real `claude` with the plugin — the session stays pure Claude Code. Inline
`--description` / `--skill` override the file for a one-off that doesn't deserve a saved role.

## Technical mapping (NATS / JetStream)

**Status.** *Built today:* all three delivery modes over **JetStream streams** (durable
per-reader consumers, explicit ack-on-surface, `Nats-Msg-Id` dedup), presence via a KV bucket,
control plane via a hand-rolled queue subscription. *Decided next:* swap the control plane to
the **NATS Services API**, and move the rest of the routing meta into **message headers** (only
`Nats-Msg-Id` lives there today; the envelope is still JSON in the body). The subject names and
envelope shape below are stable across both.

**Why streams, not fire-and-forget.** Core NATS is at-most-once: a message is delivered only
to whoever is subscribed *at that instant*. Agents are constantly `working` / `offline`, so a
DM, a task, or a channel post sent while an agent is mid-turn is silently lost. JetStream
**stores** each message and gives every reader its own bookmark, so an agent catches up *at
its own pace* when it frees up — nothing missed, no interruption required. One mechanism then
covers three things at once: live delivery, the inbound buffer, and late-join history.

- **Subjects (delivery modes):** the **sender is encoded in the subject** — a
  server-policeable fact, not a self-asserted payload field. `parseSubject()` is the single
  authority on the layout (the sender position is asymmetric: `[3]` for chat, `[4]` for the
  rest — read it through `parseSubject`, never index a subject directly).
  - multicast → `cotal.<space>.chat.<sender>.<channel…>`  — broadcast to a channel
  - unicast → `cotal.<space>.inst.<target>.<sender>`  — one specific endpoint
  - anycast → `cotal.<space>.svc.<role>.<sender>`  — any one instance of a service (role)
  - control → `cotal.<space>.ctl.<service>.<sender>`  — request/reply to a service
  - Receivers read the sender **from the subject**; the payload `from` is advisory and is
    rejected on mismatch (fail-closed, on every receive path — see *Identity & authorization*).
  - The message *class* (channel/dm/anycast) is likewise **derived from the delivering subject** and
    surfaced to listeners as `MessageMeta.kind` — authenticated, **not** read from the forgeable
    payload `to`/`toService`. A peer publishing a broadcast with payload `{to:victim}` can no longer
    make it classify as a DM.
  - `*` = one token, `>` = trailing tokens. Subscribers wildcard the sender position
    (`chat.*.<channel>`, `inst.<myId>.*`); an observer taps `cotal.<space>.chat.>`.
- **Streams (one model, three read patterns):**
  - **`CHAT_<space>`** (multicast) — captures `chat.>`, **Limits** retention with
    `MaxMsgsPerSubject` (a capped per-channel backlog). **Every** agent reads **every**
    message via its **own** consumer/bookmark, at its own pace; a late joiner replays the
    window. This *is* both the inbound channel buffer and history.
  - **`DM_<space>`** (unicast) — captures `inst.>`, **Limits** retention. Each agent has a
    **per-instance durable consumer** (durable name = instance id, filter `inst.<id>.*`) — its
    private inbox. Retained for **session length** (an `InactiveThreshold` retires the consumer
    when the context ends, mirroring the *Instance continuity* rule). Under auth this durable is
    **pre-created by the provisioner** and the agent only binds it (see *Identity &
    authorization* — the create-time filter is the DM confidentiality surface). `cotal_inbox` =
    pull the unread batch; push = the consumer delivers on attach.
  - **`TASK_<space>`** (anycast) — captures `svc.>`, **WorkQueuePolicy**. A **shared pull
    consumer per role** (durable `svc_<role>`, filter `svc.<role>.*`): a task with no worker
    online *waits*; the first available instance of the role grabs it; multiple online instances
    load-balance; the task is removed once acked. Under auth this durable is **pre-created
    per-role by the provisioner** and agents bind it (same create-time-filter reason as DM —
    prevents cross-role work-stealing).
  - **Admin cleanup:** `cotal history clear --force` purges retained `CHAT_<space>` history;
    `--dms` also purges `DM_<space>`. `TASK_<space>` is deliberately untouched because it is
    queued work, not replay history.
  - **Acks** are explicit and happen when a message is actually surfaced/injected (not on
    pull), so a crash before injection redelivers (`AckExplicit` + `AckWait`).
- **Presence:** NATS **KV bucket per space** (key = instance id), bucket-level TTL + a
  client-side expiry sweep (correct without relying on server delete-markers — per-key TTL on
  an updated key is unreliable on current servers, and heartbeats re-put the same key). States:
  `idle` / `waiting` / `working` / `offline`. Heartbeat ≈ TTL/3; graceful leave publishes a
  final `offline`; a lapsed heartbeat is swept to `offline`. Offline peers stay in the roster.
  (Instant offline via `$SYS` disconnect events is a documented upgrade — see *Deferred*.)
  **Attention modes** (`open`/`dnd`/`focus`) are a local, per-agent *delivery preference* — not
  broadcast as presence or any wire field (the only core/wire change is `MessageMeta.kind` above).
- **Identity/discovery:** A2A `AgentCard` (`id`=instance, `name`=handle, `role`=service,
  `kind`, `skills`/`tags`) carried in the presence record (our equivalent of `.well-known`).
  We omit A2A's `capabilities` field (protocol flags Cotal doesn't need) to avoid the name
  collision — "what it can do" lives in `skills`/`tags`.
- **Message envelope:** `{ id, ts, space, from:{id,name,role}, channel?, to?, toService?,
  parts[], replyTo?, contextId? }`. Routing meta (`id`, `from.id`, `contextId`, `replyTo`)
  moves to **NATS headers** — `id` as `Nats-Msg-Id` gives free server-side **dedup** under
  JetStream redelivery, and lets the buffer/policy layer peek (who / kind) without decoding the
  body; `parts[]` stay in the body. Exactly one delivery target: `channel` = multicast, `to` =
  unicast (instance), `toService` = anycast (service).
- **Artifacts:** large `data` parts / A2A `Artifact`s exceed the ~1 MB message cap, so they go
  to a **JetStream Object Store** bucket per space (chunked); the message carries a reference
  part `{ kind:"artifact", ref:{ bucket, name, size, mime } }` and the recipient fetches on
  demand. (Part shape reserved now; delivery later.)
- **Control plane:** the **NATS Services API** (`micro`) — the manager registers a service
  (endpoints `start`/`stop`/`ps`/`status`/`bind` under `ctl.<service>`, auto queue-grouped),
  which brings built-in **discovery** (`$SRV.PING`/`INFO`) and **stats** for free. The
  `ControlRequest`/`ControlReply` envelope is unchanged; only the transport underneath swaps.
- **Isolation:** one NATS **account** per space (later: split `space` into `org/namespace`).
  Auth mode (the default) makes the account a real boundary; `--open` is one shared account.
  See [spaces.md](spaces.md) for the space-vs-channel model and how spaces connect
  (export/import within an operator, a narrow bridge across operators).
- **Transport choice:** JetStream streams for all three delivery modes (durability + per-reader
  bookmarks + history), KV for presence, Object Store for artifacts, and the Services API for
  the control plane.
- **Auth & onboarding:** open mode uses connection auth (token or user/password, optional TLS)
  via explicit `connect()` options — nats.js ignores credentials embedded in a URL — bundled
  into a one-string join link (`cotal(s)://token@host/space`,
  [`link.ts`](../packages/core/src/link.ts)) — this is the `--open` dev path. The **default**
  is decentralized JWT auth — see *Identity & authorization* below.

## Identity & authorization (auth mode)

**On by default** (`cotal up`); `cotal up --open` runs an unauthenticated dev mesh instead.
Makes the mesh a real boundary against untrusted peers *within* a shared space: an agent can only emit messages **as itself**,
only to its **declared channels**, and can only read **its own DMs** — enforced by the NATS
server, not by agent goodwill. It is containment + authenticity for a single trusted broker
(not non-repudiation; doesn't survive an untrusted relay — that needs signed envelopes, later).

- **Account = space, user = agent.** Decentralized **JWT**: an operator signs the account
  (= the space), an account **signing key** signs per-agent users. Generated programmatically
  with `@nats-io/jwt` (no `nsc` dependency). The server runs operator mode + a MEMORY resolver
  (operator JWT + `system_account` + the demo & SYS account JWTs); `cotal up` renders
  this config and is **load-or-create** on `.cotal/auth` (so the signing key that minted creds
  is always the one the server trusts).
- **The provisioner** ([`provision.ts`](../packages/core/src/provision.ts)) is the *signer
  capability*: it holds the account signing key and mints profile-scoped creds. The manager
  hosts it in Demo 1, but it's not manager-special — privilege attaches to the signer, and a
  space can run with no manager. `cotal mint <name> --profile <agent|observer|admin>` is the
  out-of-band path; the manager calls the same lib at spawn.
- **Identity = the agent's nkey public key**, used identically everywhere: `card.id`, the
  subject sender token, the JWT subject, the DM/inbox durable names. Generated locally
  ([`identity.ts`](../packages/core/src/identity.ts)); the provisioner signs over only the
  public key (`fromPublic`). The endpoint accepts a creds file and adopts its identity as
  `card.id` (asserting any explicitly-set id matches, else publishes would silently deny).
- **Profiles** (a default-deny allow-list each, built from the shared subject/stream/durable
  builders so the ACLs can't drift from the wire layout):
  - **agent** — publish only `chat.<ownId>.<declared-channel>` (the `publish:` list in the
    agent file, falling back to `channels:`; wildcard subtrees like `team.>` flow through),
    plus `inst.*.<ownId>` / `svc.*.<ownId>` / `ctl.<mgr>.<ownId>`. Presence PUT scoped to its
    own key. `$JS.API` scoped to its own chat/task/DM durables (chat & task self-created
    name-scoped; **DM and TASK bind-only** — create denied). `sub.allow = [_INBOX_<ownId>.>]`.
  - **observer** — read-only: `sub.allow = [chat.>, _INBOX_<ownId>.>]`, pub = CHAT + presence
    read verbs only. No chat/inst/svc publish (can't post); DM streams never named (DMs
    invisible). `cotal watch/console/web` run `consume:false` and narrow their tap to `chat.>`.
  - **admin** — elevated read-only ("god-view" auditor): observer's pub allow + DM-stream read
    verbs (still **write-nothing** — it can't post), and `sub.allow` widened to the whole space
    (`cotal.<space>.>`), so its tap sees DMs (`inst.>`) and anycast (`svc.>`) *live* and it can
    backfill DM history (ephemeral consumer on `DM_<space>`). DMs are plaintext + ACL-gated, so
    this is a deliberate opt-in — `cotal web --admin` with an admin cred. `CONSUMER.CREATE` on
    `DM_<space>` is the DM-confidentiality surface, granted here only for this profile.
  - **manager** — privileged (broad), the provisioner host; pre-creates others' DM/TASK
    durables. (Eventually should be scoped too — see limitations.)
- **DM & TASK confidentiality close two leak paths.** *Delivery path:* all NATS delivery rides
  the connection inbox, and NATS delivers a subject to every subscriber, so a wildcard
  `_INBOX.>` subscribe would sniff peers' deliveries. Fix: a **per-identity inbox prefix**
  (`connect({inboxPrefix: _INBOX_<ownId>})`) + `sub.allow = [_INBOX_<ownId>.>]`. *Stream path:*
  the consumer **create-time `filter_subject`** isn't ACL-constrainable (it's in the request
  payload for the durable API), so an allowed create could filter to a victim's inbox / another
  role's queue. Fix: the privileged provisioner **pre-creates** the DM (`dm_<id>`, filter
  `inst.<id>.*`) and TASK (`svc_<role>`, filter `svc.<role>.*`) durables; agents **bind only**,
  and **all** create forms on `DM_<space>`/`TASK_<space>` are denied.
- **Streams are infrastructure**, pre-created at `cotal up` (agents are denied
  `STREAM.CREATE`); the presence KV bucket is a stream too, so it's pre-created and agents open
  (not create) it. Open mode keeps the lazy first-endpoint create.
- **Denials are loud, never silent** — NATS publish permission violations surface only on the
  connection status stream, so the endpoint routes them to its `error` event with a "denied,
  not absent" message. This is why an over-tight ACL shows up as a logged denial, not a peer
  that mysteriously looks absent.

**Known limitations (Demo 1):**
- **Standalone/late-join DM receipt** needs a *connected* provisioner (the manager) to
  pre-create `dm_<id>`; chat/task/presence late-join works with no manager. Full fix is the
  callout stage. (Fails loud via the denial log, not silent.)
- **Signing key + operator seed are hot** in `.cotal/auth` (the mint/manager box) — not yet
  key-confined; the "real boundary" holds only given operator-controlled cred distribution.
  Operator seed should be cold-stored (it's the root; only needed for account setup/rotation).
- **No revocation / TTL** on minted creds yet.
- `isReachable` conflates auth-failure with server-down (misleading "run cotal up").
- The **manager profile is allow-all** — fine for Demo 1, but the most-privileged identity
  should eventually be scoped for the full untrusted-peer claim.
- **Callout stage (later, additive):** auth-callout (NATS 2.10+) mints creds *at connect* from
  a per-space/per-profile bootstrap token (the `token@` the join link already parses), moving
  the signing key into the callout service (true key-confinement) and removing the out-of-band
  mint.

## Deferred (designed-for, not built)

- **Sessions + moderator** — managed group membership (admit/remove), per SLIM's Group session.
- **Verifiable identity** — NKey/JWT decentralized auth + the account-per-space boundary are
  **built** (on by default, *Identity & authorization* above); what remains deferred is
  *non-repudiation* — signed message envelopes (and `instance` as a `did:key`) so authenticity
  survives an untrusted relay/federation hop, not just a single trusted broker.
- **Instant offline (`$SYS`)** — subscribe the manager to `$SYS.ACCOUNT.<id>.DISCONNECT` for
  immediate offline detection instead of waiting out the heartbeat window. Needs `system_account`
  config + a privileged connection, connection names that carry the instance id (not just the
  handle), and the manager as presence reconciler (a dead agent can't mark itself offline). The
  heartbeat sweep remains the floor when no reconciler is running.
- **Artifact delivery** — the Object Store path above (shape reserved, transfer not built).
