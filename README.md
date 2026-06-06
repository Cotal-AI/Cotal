<p align="center">
  <img src="assets/header.gif" alt="Swarl — lateral peers in a shared pub/sub space" width="100%" />
</p>

# Swarl

A wire protocol for software — especially AI agents — to coordinate in real time as
**lateral peers in a shared pub/sub space**, instead of as nodes in an orchestrator tree.

[Overview](docs/OVERVIEW.md) · [Architecture](docs/architecture.md) · [Claude Code](docs/claude-code-integration.md) · [Examples](docs/examples.md) · [Contributing](AGENTS.md)

## What it is

Participants join a shared **space**, keep **presence**, and talk to each other directly —
broadcast to a channel, message one peer, or reach any one of a role. There's no central
orchestrator on the message path; peers coordinate as equals. The **wire contract is the
standard** (the subjects, the message envelope, the presence conventions); the libraries here
are thin clients over it. Transport is **NATS + JetStream**; the reference impl is **TypeScript**.

## Quick start

Prerequisites: Node ≥ 20, pnpm, and `nats-server` (v2.11+; macOS: `brew install nats-server`).

```bash
git clone <repo> swarl && cd swarl && pnpm install

pnpm swarl up                                                # start the local mesh (keep running)
pnpm swarl join --space demo --name alice --role planner    # a peer, in its own terminal
pnpm swarl join --space demo --name bob   --role builder    # another peer
pnpm swarl console --space demo                             # live dashboard of agents + messages
```

In a `join` session, type a line to broadcast it; `/who`, `/dm`, `/anycast`, `/working`,
`/idle`, `/quit` drive the rest (`pnpm swarl help` lists every command). Full walkthrough:
[examples/01-lateral-coordination](examples/01-lateral-coordination/README.md).

## How it works

A **space** is one isolated collaboration. Every participant keeps **presence** — a live
roster with each peer's role and state (`idle` / `waiting` / `working` / `offline`). Messages
reach peers three ways:

| Mode | Reaches | Use |
|---|---|---|
| **multicast** | everyone on a channel | broadcast to the group |
| **unicast** | one specific peer | a direct message |
| **anycast** | *any one* instance of a role | "whoever is a reviewer" |

## Learn more

- **Full walkthrough** — [examples/01-lateral-coordination](examples/01-lateral-coordination/README.md)
- **Real Claude Code agents in cmux** — [examples/02-cmux-handoff](examples/02-cmux-handoff/README.md)
- **The wire contract** (subjects + `SwarlMessage` envelope) — [docs/architecture.md](docs/architecture.md),
  source of truth in [`types.ts`](packages/core/src/types.ts) / [`subjects.ts`](packages/core/src/subjects.ts)
- **Working on Swarl?** — [AGENTS.md](AGENTS.md) (layout, dep tiers, conventions, dev commands)

## Status

Today: presence and all three delivery modes over `@swarl/core` with stream-backed delivery
(JetStream durable consumers), an extension registry the manager resolves connectors through,
and the Claude Code connector under `extensions/`. Manual CLI peers drive `examples/01`; real
coding-agent panes land in `examples/02`. Not yet built: agent-directed control commands.
