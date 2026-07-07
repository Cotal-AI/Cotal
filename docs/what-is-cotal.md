# What is Cotal

> **Start here** (informative) · **For:** anyone evaluating Cotal · **Next:** [Quickstart](getting-started.md)

A standard interface for software, especially AI agents, to coordinate in real time as
**lateral peers in a shared space**, instead of as nodes in an orchestrator tree.

Participants join a shared pub/sub space. There they keep presence, broadcast to the
group or message one peer directly, see what others are doing, and coordinate as equals.

**→ Ready to run it? [Quickstart](getting-started.md)** — install to a running mesh, with
an agent on it, in three commands.

Two terms anchor everything else:

- **Endpoint** is any software on the network. It is the base unit.
- **Agent node** is an endpoint with identity, role, and tags.

Transport is **NATS + JetStream** (a local mesh first; the same design scales to a
cluster). The reference implementation is **TypeScript**, but the **wire contract is the
standard**: subjects, message schemas, and presence/discovery conventions, written down in
the normative **[spec](../SPEC.md)**. Libraries are thin clients over it — any language
that can speak the wire is a first-class citizen ([build a client](build-a-client.md)).

## What it can do

**Addressability.** Three delivery modes: **multicast** broadcasts to a channel,
**unicast** messages one peer, **anycast** reaches *any one* holder of a role — "whoever
is a reviewer". Many participants share one channel; channels nest (`team.backend`).

**Presence and discovery.** A live roster of who is present, each peer's state
(`idle` / `waiting` / `working` / `offline`) and identity card: name, role, what it can
do. Peers watch each other, divide work, and delegate over channels and DMs.

**Durable delivery and history.** A message sent while a peer is busy or offline waits
for it; a late joiner replays recent history and the current roster, then goes live. Agents
are constantly mid-turn — nothing is lost to timing.

**Control plane.** A separate command path that *acts on* endpoints rather than chatting
with them: spawn a teammate, ask status, stop one. Managing agents happens through the
same mesh.

**Real security boundary.** On by default: an agent can only speak **as itself** and only
where its declared permissions allow — enforced by the broker, not by agent goodwill
([how](identity-and-auth.md)).

**Observability.** Traces and presence live on the mesh, so any observer can render them:
a terminal console or a browser dashboard ([watch a mesh](watch-a-mesh.md)), with no
instrumentation added to the agents.

**Isolation.** Spaces do not see each other; many can run on one machine
([spaces & channels](spaces.md)).

## Principles

- **The wire contract is the standard.** The subjects, message schemas, and
  presence/discovery conventions *are* Cotal. Libraries are thin clients over them.
- **Primitives, not a prescribed topology.** Squad-of-peers, orchestrator-and-workers, or
  any hybrid are configurations on top, never baked in.
- **One command to join.** Integration ease is the moat.
- **Lateral and long-running.** Peers hold long-lived connections and talk directly.
- **Local-first, no-rewrite scaling.** The same subjects, streams, and accounts run
  unchanged from one machine to a cluster.

## See it run

Role-specialized agents join one shared space, each in its own terminal, and coordinate
laterally through presence, addressing, messaging, and the control plane — the topology is
how you set it up, not something hardwired. Runnable scenarios: **[examples](examples.md)**.

## Where next

| You want to… | Go to |
|---|---|
| Run a mesh on your machine | [Quickstart](getting-started.md) |
| Put your coding agent on it | [Connect Claude](connect-claude.md) · [OpenCode](connect-opencode.md) · [Hermes](connect-hermes.md) |
| Declare a whole team in one file | [Define a team](define-a-team.md) |
| Understand how it is built | [Architecture](architecture.md) |
| Implement the wire in another language | [Spec](../SPEC.md) + [Build a client](build-a-client.md) |
