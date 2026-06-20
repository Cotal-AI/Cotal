# Cotal: overview

> What Cotal is and what it can do. For *how* it is built, see
> [architecture.md](architecture.md). To install and run it, see
> [getting-started.md](getting-started.md). Open questions are at the end.

## What Cotal is

A standard interface for software, especially AI agents, to coordinate in real time as
**lateral peers in a shared space**, instead of as nodes in an orchestrator tree.

Participants join a shared pub/sub space. There they keep presence, broadcast to the
group or message one peer directly, see what others are doing, and coordinate as equals.

Two terms anchor everything else:

- **Endpoint** is any software on the network. It is the base unit.
- **Agent node** is an endpoint with identity, role, and tags.

Transport is **NATS + JetStream** (a local demo first; the same design scales to a
cluster later). The reference implementation is **TypeScript**.

## Core primitives

| Primitive | What it is |
|---|---|
| **Endpoint** | Any software on the mesh: a long-lived connection with its own presence, subscribed to channels, buffering inbound traffic. |
| **Agent node** | An endpoint with identity, role, and tags (an A2A-style AgentCard). |
| **Space** | A collaboration, isolated from other spaces. |
| **Channel** | A named topic participants broadcast on and subscribe to. |
| **Direct message** | A message addressed to one peer. |
| **Presence & discovery** | A live roster of who is present, with state (`idle` / `waiting` / `working` / `offline`) and each peer's AgentCard. |
| **History** | Recent messages a late joiner can replay. |

## What Cotal can do

Four core capabilities, plus observability, history, and isolation.

**Addressability.** Three delivery modes, inspired by SLIM:

- **multicast** broadcasts to a channel.
- **unicast** messages one peer.
- **anycast** reaches *any one* holder of a role, for example "whoever is a reviewer".

Many participants can share one channel.

**Control plane.** A separate command path that *acts on* endpoints rather than chatting
with them: ask status, send a directive, set role, pause or resume. Each carries a reply.

**Data sharing.** Two directions.

- *Outbound:* **ambient** (lifecycle activity streams to the mesh automatically) and
  **deliberate** (an agent publishes a message on purpose).
- *Inbound:* **pull** (the agent reads its buffer when it chooses) and **push** (a message
  is delivered into the live session, soft between turns or urgent and interrupting). A
  buffer and policy sit in front, so traffic is queued or coalesced rather than piped in
  raw. Ambient traces reach the mesh but not every agent's attention.

**Coordination.** Agents announce intent and watch peers' presence and activity, then
divide work and delegate over channels and DMs. They share one workspace with **no
isolation** (no worktrees), and stay out of each other's way by coordinating.

The rest:

- **Observability.** Traces and presence live on the mesh, so any observer can render
  them: `cotal console` (terminal) or `cotal web` (browser dashboard with presence,
  channels, and a live feed; see [web.md](web.md)).
- **History & late join.** A late participant replays recent messages and the current
  roster, then goes live.
- **Isolation.** Spaces do not see each other; many can run on one machine.

## Principles

- **The wire contract is the standard.** The subjects, message schemas, and
  presence/discovery conventions *are* Cotal. Libraries are thin clients over them.
- **Primitives, not a prescribed topology.** Squad-of-peers, orchestrator-and-workers, or
  any hybrid are configurations on top, never baked in.
- **One command to join.** Integration ease is the moat.
- **Lateral and long-running.** Peers hold long-lived connections and talk directly.
- **Local-first, no-rewrite scaling.** The same subjects, streams, and accounts run
  unchanged from one machine to a cluster.

## The first demo

Role-specialized agents join one shared space, each in its own terminal, and coordinate
laterally through presence, addressing, messaging, and a control plane. The topology is
how you set it up, not something hardwired.

Full scenario and run steps:
**[examples/01-lateral-coordination](../examples/01-lateral-coordination/README.md)**.

## Status: built so far

- **Stack.** TypeScript, pnpm monorepo (`@cotal-ai/core`, `@cotal-ai/cli`), NATS +
  JetStream.
- **Wire shapes.** A2A-inspired `AgentCard` + `Message`/`Part`; SLIM-inspired addressing
  (`space / service / instance`) and the three delivery modes. See
  [architecture.md](architecture.md).
- **Presence states.** `idle` / `waiting` / `working` / `offline`.
- **Core + CLI.** The `@cotal-ai/core` endpoint (presence plus all three delivery modes:
  multicast, unicast, anycast) and `@cotal-ai/cli` (`up` / `join` / `watch` / `web` /
  `history clear`), smoke-tested.
- **Manager (supervisor).** A long-lived **node** that owns agent *lifecycle and config*,
  not their work. The CLI and dashboard drive it over the **control plane**
  (`start`/`stop`/`ps`/`status`/`bind`). It is supervisor-only: agents self-connect, so the
  manager stays off the message hot path. The demo spawns native agent TUIs in terminal
  panes.
- **Claude Code integration (demo).** **Attach mode.** One Cotal **plugin** is a
  dual-purpose MCP server (channel push, `cotal_send`/`cotal_dm`/`cotal_anycast`,
  `cotal_inbox`, and beta `cotal_feedback`) plus `http` lifecycle hooks for presence and
  ambient activity. Deterministic **hook** injection is the spine; the **channel** adds
  async "wake when idle or away." Onboarding is **pure native**: `/plugin install`, then
  launch the real `claude` with the plugin (space identity via env, auto-join), with no
  wrapper binary. Host mode (Agent SDK, true mid-turn interrupt) is the documented upgrade
  path. Accepted limits: no mid-turn interrupt in attach mode, and channel push is
  research-preview-gated. Detail in [architecture.md](architecture.md).
- **Agent files (identity + persona).** An agent is defined by `.cotal/agents/<name>.md`:
  YAML frontmatter (name, role, description, tags, channels, publish, model, capabilities)
  that produces an A2A `AgentCard`, plus an optional Markdown body that is the **persona**
  (an appended system prompt). `role` is the addressable **service** (anycast). The
  connector resolves it from `COTAL_AGENT_FILE`; a peer can mint one on the fly with
  `cotal_persona` (the manager writes the file). Personas are **optional**, since Cotal
  ships primitives, not prescribed personas.
- **Identity & authorization (on by default; `cotal up --open` to disable).** The mesh is
  a real boundary against untrusted peers in a shared space. The **sender is encoded in
  the subject** (server-policed, not self-asserted), so an agent can only emit **as
  itself**. Per-agent JWT ACLs scope **posting** to its declared channels (default-deny) and
  **reading** to its read ACL (`allowSubscribe`) — both broker-enforced. DMs are confidential
  on both leak paths (a scoped per-identity inbox plus provisioner-pre-created bind-only
  durables). Account = space, user = agent, minted by a **provisioner** (the
  signer capability, not something manager-special). Open mode stays the default for local
  dev. Full model and limitations in [architecture.md](architecture.md).

## Open questions

- **Inbound buffer/policy.** Defaults for queue vs coalesce vs immediate injection.
- **Control-plane commands.** Manager ops (`start`/`stop`/`ps`/`status`/`bind`) are the
  first cut. The agent-directed set (directive, set-role, pause/resume) is still open.
- **Coordination primitives.** Advisory intent records and leases: in or out, and what
  shape.
- **Collaboration patterns.** Agents themselves are defined now
  (`.cotal/agents/<name>.md`). Still open is how a user declares the patterns *between*
  them (who delegates to whom, leases).
