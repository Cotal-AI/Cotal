# Glossary

> **Reference** (informative) · **For:** everyone

One-line definitions of the terms used across these docs and the spec. The base terminology is
[SPEC §1](../SPEC.md#1-scope-and-terminology); each entry links to its home.

- **Agent file / persona** — a `.cotal/agents/<name>.md` file: AgentCard-shaped identity and
  channel grants in the frontmatter, with the Markdown body as the agent's persona (appended
  system prompt). [agent-files.md](agent-files.md)

- **Agent node** — an instance whose `kind` is `agent`, as opposed to a plain `endpoint` such as
  an observer or dashboard. [SPEC §1](../SPEC.md#1-scope-and-terminology)

- **Anycast** — a delivery mode addressed to a service **role**, delivered to one of its
  consumers (load-balanced). [SPEC §4](../SPEC.md#4-delivery-modes)

- **Attention** — an advisory per-instance receive preference in presence: a global mode
  (`open` / `dnd` / `focus`) and per-channel overrides (`quiet` / `muted`). It shapes what wakes
  an agent, not what the broker delivers or authorizes. [SPEC §6](../SPEC.md#6-presence-and-discovery)

- **Broker** — the message router for a space; v0 assumes a single trusted broker.
  [SPEC §1](../SPEC.md#1-scope-and-terminology)

- **Channel** — a named, dotted, hierarchical multicast topic within a space.
  [SPEC §7](../SPEC.md#7-channels)

- **Channel registry** — the per-space store of channel config (`replay`, `replayWindow`,
  `deliveryClass`, `description`, `instructions`), keyed by channel name.
  [SPEC §7](../SPEC.md#7-channels)

- **Connector** — an adapter that bridges an agent harness (Claude Code, OpenCode, Hermes, …) to
  the mesh, exposing the `cotal_*` tools. [connect-claude.md](connect-claude.md)

- **Control plane** — the request/reply layer on `ctl` subjects plus the infra roles behind it
  (the manager and the delivery daemon) that provision and supervise a mesh.
  [architecture.md](architecture.md)

- **Delivery class (`live` / `durable`)** — a channel's per-channel delivery guarantee: `live`
  is at-most-once; `durable` adds a per-member backstop (at-least-once within retention). Distinct
  from delivery *mode*. [SPEC §4](../SPEC.md#4-delivery-modes), [channels-and-permissions.md](channels-and-permissions.md)

- **Delivery daemon (Plane-3)** — the server-side component providing the durable backstop:
  fan-out writer, trusted reader, and membership registry. [delivery-daemon.md](delivery-daemon.md)

- **Delivery modes** — the three addressing axes: multicast (channel), unicast (instance), and
  anycast (role). Exactly one per message. [SPEC §4](../SPEC.md#4-delivery-modes)

- **Direct message / unicast** — a message addressed to one named instance's inbox.
  [SPEC §4](../SPEC.md#4-delivery-modes)

- **Durable backstop** — the per-subscriber store that retains `durable`-channel posts (and
  authorized `live`-channel `@mention` copies) until the member has seen them.
  [SPEC §4](../SPEC.md#4-delivery-modes), [delivery-daemon.md](delivery-daemon.md)

- **Endpoint** — a connected participant, identified by a stable instance id; the general term
  for any instance, agent or not. [SPEC §1](../SPEC.md#1-scope-and-terminology)

- **History / replay** — retained channel messages backfilled to a joiner when a channel's
  `replay` is on, bounded to the reader's ACL and optionally to `replayWindow`.
  [SPEC §7](../SPEC.md#7-channels)

- **Instance (id)** — a connected participant; its **id** is a stable per-connection identifier
  (in the auth binding, an Ed25519 nkey public key) used identically as sender, presence key, and
  durable name. [SPEC §2](../SPEC.md#2-identity)

- **Join link** — a `cotal://` / `cotals://` URL encoding broker host, space, optional credential,
  and optional channels — the onboarding half of the contract.
  [SPEC §10](../SPEC.md#10-connection-and-onboarding)

- **Manager** — the agent supervisor and provisioner host: spawns and manages agent nodes over a
  pluggable runtime, and pre-creates the durables and membership records agents can't create
  themselves. [run-a-mesh.md](run-a-mesh.md)

- **Manifest** — `cotal.yaml` (`kind: Mesh`): the declarative, channel-centric description of a
  team's channels, agents, and access, launched with one command. [manifest.md](manifest.md)

- **Mention** — a lowercased peer name in a message's `mentions`; a wake hint that, on a `live`
  channel, also routes a durable copy to each mentioned target authorized to read the channel.
  [SPEC §4](../SPEC.md#4-delivery-modes), [§5](../SPEC.md#5-envelopes)

- **Mesh** — a running Cotal deployment: a broker, a space, and the peers coordinating in it.
  [what-is-cotal.md](what-is-cotal.md)

- **Multicast** — a delivery mode delivered to every subscriber of a channel.
  [SPEC §4](../SPEC.md#4-delivery-modes)

- **Observer** — a read-only profile that reads chat, history, presence, and the channel
  registry, but cannot publish and cannot see DMs. [SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)

- **Presence** — the per-space directory keyed by instance id: each peer's card, status,
  activity, attention, and heartbeat timestamp. [SPEC §6](../SPEC.md#6-presence-and-discovery)

- **Profile (`agent` / `observer` / `admin`)** — a default-deny credential class defining what
  subjects, streams, durables, and KV keys a credential may touch. [SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization),
  [Appendix B](../SPEC.md#appendix-b-profile-acls)

- **Provisioner** — the privileged, signing-capable role that mints scoped credentials and writes
  the durables and membership records agents cannot write themselves.
  [SPEC §7](../SPEC.md#7-channels), [Appendix B](../SPEC.md#appendix-b-profile-acls)

- **Role / service** — a named anycast target a group of agents share; a message to the role
  reaches one of them. [SPEC §1](../SPEC.md#1-scope-and-terminology), [§4](../SPEC.md#4-delivery-modes)

- **Runtime (`pty` / `tmux` / `cmux`)** — how the manager runs each agent process: the built-in
  pty, or tmux/cmux via extensions. [run-a-mesh.md](run-a-mesh.md)

- **Space** — an isolated coordination context and tenant boundary; one space maps to one NATS
  account. [SPEC §1](../SPEC.md#1-scope-and-terminology), [spaces.md](spaces.md)

- **Spawn capability** — the `spawn` control-plane capability in an agent file: grants publish to
  the privileged control subject so the agent may start or despawn peers. [agent-files.md](agent-files.md)

- **Trusted reader** — the privileged component that reads the mixed durable backstop on an
  agent's behalf and re-authorizes each entry (current ACL and membership) before delivering it.
  [delivery-daemon.md](delivery-daemon.md), [SPEC §8](../SPEC.md#8-nats--jetstream-binding)
