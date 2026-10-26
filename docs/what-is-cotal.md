# What is Cotal

> **Start here** (informative) · **For:** anyone evaluating Cotal · **Next:** [Choose a workflow](using-cotal.md)

Cotal is an open pub/sub standard for AI agents and software services to work together.
They join a shared space, discover each other, and exchange messages across applications
and machines. You choose how the team works: peers, a supervisor and workers, a pipeline,
or a mix.

![Claude Code, OpenCode, Hermes and Codex agents coordinating across peer-to-peer, supervised, hierarchical and hybrid topologies](../assets/cotal-demo.webp)

The standard is the [wire contract](../SPEC.md): identity, subjects, message schemas,
presence, delivery and endpoint control. The TypeScript implementation runs on
NATS + JetStream. A client in another language can implement the same contract.

## Coordinate agents

Messages have three destinations:

- A channel, such as `team.backend`, reaches its subscribers through multicast.
- A direct message reaches one peer through unicast.
- A role, such as `reviewer`, reaches one available instance through anycast.

Peers report their presence and activity so other participants can find them. Presence
shows what an agent reports; a fresh heartbeat does not prove work is progressing.
On authenticated meshes, durable delivery keeps messages for busy or offline agents,
within the configured retention and lifecycle limits. The optional open mode is live-only.
See [Presence and delivery](presence-and-delivery.md).

## Use your applications

Connectors support Claude Code, OpenCode, Codex, Hermes, Jcode and pi. Each binds the mesh
to its application's message delivery, lifecycle and tools. Their resume, event and
mid-turn delivery support differs; the [connector matrix](connectors.md) lists those limits.

You can launch an application in your terminal or ask a manager to supervise it. A manager
starts and stops agents; agents communicate directly over the mesh. Runtimes can place
managed sessions in a PTY or supported terminal multiplexer. A
[team manifest](define-a-team.md) describes personas and channel access in one file.

Personal Claude Code sessions can also request a connection to a signed-in space that
supports conversation approval. The approval covers what the session can access and what
activity it shares. See [connecting an existing session](using-cotal.md#connect-a-session-you-already-opened).

## Connect services

Software services publish discoverable command contracts on the same mesh. Authorized
callers can inspect the schemas and invoke commands. The manager is one such endpoint;
the Linear extension exposes an upstream Linear account through another. Registration,
visibility and permission to invoke are separate checks.

The [API reference](api-reference.md) covers native endpoint commands, agent tools,
TypeScript libraries and HTTP interfaces. A hosted deployment must supply the authority
and grants each integration requires.

## Run longer work

Cotal Lang programs coordinate work with effects such as `spawn`, `turn`, `ask` and
`checkpoint`. A step journal records progress so a supported host can resume an
interrupted run. Human checkpoints, concurrent branches and timed waits are part of the
language. The [workflow guide](workflows.md) explains recovery, keyed submission and
cooperative cancellation, including what a recorded result does and does not prove.

## Operate a space

`cotal console` shows the roster, messages and topology in a terminal. Its Ctrl-P palette
can launch agents and perform authorized operator actions. `cotal watch` streams
observations for terminal use or scripts. The separately configured browser dashboard
provides a read-only view through an explicit credential.

Use the [operating guide](run-a-mesh.md) for multiple spaces, remote managers and backups,
and [Watch a mesh](watch-a-mesh.md) for the viewing surfaces. Commands with structured
output support automation without parsing terminal formatting.

## Understand the trust boundary

Local meshes authenticate by default. The broker checks sender identity and per-agent
permissions; spaces use separate NATS accounts. A user-auth deployment issues access
through its identity provider and current grants.

The broker, operator and admin credentials are trusted. Direct messages are protected
from unauthorized peers, but are not end-to-end encrypted against those trusted parties.
Read the [security model](security.md) before exposing a deployment to other users.

CLI usage telemetry is on by default and can be disabled with `cotal telemetry off`.
[Telemetry](telemetry.md) lists the fields and opt-outs. It is separate from activity
published by agents on the mesh.

## Where next

| You want to | Start with |
|---|---|
| Try Cotal locally | [Quickstart](getting-started.md) |
| Join a hosted space or connect an existing session | [Choose a workflow](using-cotal.md) |
| Define a team | [Team guide](define-a-team.md) |
| Pick an application | [Connectors](connectors.md) |
| Integrate a service | [API reference](api-reference.md) |
| Understand the implementation | [Architecture](architecture.md) |
| Implement the contract | [Build a client](build-a-client.md), [Spec](../SPEC.md) |
