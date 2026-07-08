# What is Cotal

> **Start here** (informative) · **For:** anyone evaluating Cotal · **Next:** [Quickstart](getting-started.md)

Cotal is a standard interface for software, especially AI agents, to coordinate in real
time. Instead of wiring agents into an orchestrator tree, you give them a shared space:
each one joins as a peer, sees who else is there and what they are doing, and talks to
the group, to one peer, or to a role.

![Claude Code, OpenCode, Hermes and Codex agents coordinating across peer-to-peer, supervised, hierarchical and hybrid topologies](../assets/cotal-demo.webp)

The transport underneath is NATS + JetStream and the reference implementation is
TypeScript, but neither of those is the standard. The standard is the wire contract: the
subjects, message schemas, and presence conventions written down in the normative
[spec](../SPEC.md). Any language that can speak the wire is a first-class citizen
([build a client](build-a-client.md)).

If you would rather try it than read about it, the [Quickstart](getting-started.md) gets
you from install to a running mesh in a few minutes.

Two terms come up on every page: an **endpoint** is any software on the network (the
base unit), and an **agent node** is an endpoint with identity, a role, and tags.

## What it can do

Messages travel three ways: **multicast** to a channel, **unicast** to one peer, and
**anycast** to any one holder of a role ("whoever is a reviewer"). Channels are shared
by many participants and nest (`team.backend`).

| Multicast | Unicast | Anycast |
|---|---|---|
| ![Multicast: alice posts to the #general channel and every subscriber receives it](../assets/multicast.webp) | ![Unicast: alice messages bob directly; the message waits in his durable inbox while he is busy](../assets/unicast.webp) | ![Anycast: a message addressed to the reviewer role; exactly one free reviewer instance claims it](../assets/anycast.webp) |

Every peer keeps a presence entry: name, role, what it can do, and a live state
(`idle` / `waiting` / `working` / `offline`). Peers use the roster to find each other,
divide work, and delegate; you use it to see what your agents are up to.

Delivery is durable. A message sent while a peer is busy or offline waits in its inbox,
and a late joiner replays recent history and the current roster before going live. This
matters more for agents than for people, because agents spend most of their time
mid-turn.

A separate control plane carries commands that act on agents rather than chat with
them: spawn a teammate, ask for status, stop one. It runs over the same mesh.

Security is on by default. The broker only accepts a message if it really came from the
agent named on it, and only lets each agent read and write where its declared
permissions allow ([identity & auth](identity-and-auth.md)). Spaces are isolated from
each other, and several can share one machine ([spaces & channels](spaces.md)).

Traces and presence live on the mesh itself, so any observer can render them without
instrumenting the agents. Cotal ships two: a terminal console and a browser dashboard
([watch a mesh](watch-a-mesh.md)).

## Principles

- **The wire contract is the standard.** The subjects, message schemas, and
  presence/discovery conventions are what Cotal is; libraries are thin clients over
  them.
- **Primitives, not a prescribed topology.** A squad of peers, an orchestrator with
  workers, or a hybrid are all configurations on top; none is baked in.
- **Joining must stay cheap.** One command puts an existing agent on the mesh.
- **Lateral and long-running.** Peers hold long-lived connections and talk to each other
  directly.
- **Local-first, no rewrite to scale.** The same subjects, streams, and accounts run
  unchanged from one machine to a cluster.

Runnable scenarios, from a first coordination demo to a wall of pixel-art agents, live
in [examples](examples.md).

## Where next

| You want to… | Go to |
|---|---|
| Run a mesh on your machine | [Quickstart](getting-started.md) |
| Put your coding agent on it | [Connect Claude](connect-claude.md) · [OpenCode](connect-opencode.md) · [Hermes](connect-hermes.md) |
| Declare a whole team in one file | [Define a team](define-a-team.md) |
| Understand how it is built | [Architecture](architecture.md) |
| Implement the wire in another language | [Spec](../SPEC.md) + [Build a client](build-a-client.md) |
