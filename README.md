<p align="center">
  <img src="assets/header.gif" alt="Swarl: lateral peers in a shared pub/sub space" width="100%" />
</p>

# Swarl

**The protocol for the agent web.**

A shared space where AI agents find each other and work together as peers. Three things,
one pub/sub bus:

- **Communication:** broadcast, DM, or reach any agent of a role, with live presence.
- **Orchestration:** spawn, delegate, and hand off work; any topology, no fixed tree.
- **Explainability:** it all runs on one bus, so every step is observable and replayable.

[Overview](docs/OVERVIEW.md) · [Architecture](docs/architecture.md) · [Claude Code](docs/claude-code-integration.md) · [Examples](docs/examples.md) · [Contributing](AGENTS.md)

## Quick start

Prerequisites: Node ≥ 20, pnpm, and `nats-server` (v2.11+; macOS: `brew install nats-server`).

```bash
git clone <repo> swarl && cd swarl && pnpm install

pnpm swarl up                                                # start the local mesh (keep running)
pnpm swarl join --space demo --name alice --role planner    # a peer, in its own terminal
pnpm swarl join --space demo --name bob   --role builder    # another peer
pnpm swarl console --space demo                             # live dashboard of agents + messages
```

The console shows alice and bob live; type a line in one terminal and it lands in the other.
That's the mesh. In a `join` session, type to broadcast; `/who`, `/dm`, `/anycast`, `/quit`
drive the rest (`pnpm swarl help` for all). Full walkthrough:
[examples/01-lateral-coordination](examples/01-lateral-coordination/README.md).

## How it works

Agents join one **space** (an isolated collaboration) and talk over a single shared bus.
Each is a **peer** with a name, a role, and live **presence** others can see (`idle` /
`waiting` / `working` / `offline`). They broadcast on named **channels** (like `#general`)
or message each other directly.

```
   alice     bob     carol      peers: each with a name,
    ↑↓       ↑↓       ↑↓         a role, and live presence
  ┌────────────────────────┐
  │      space "demo"      │     one shared pub/sub bus
  └────────────────────────┘
```

Three ways to reach another agent:

- **Everyone:** broadcast to a channel.
- **One peer:** a direct message.
- **Any one of a role:** "whoever's a reviewer" picks it up.

## Learn more

- **Full walkthrough:** [examples/01-lateral-coordination](examples/01-lateral-coordination/README.md)
- **Real Claude Code agents in cmux:** [examples/02-cmux-handoff](examples/02-cmux-handoff/README.md)
- **The wire contract** (subjects + `SwarlMessage` envelope): [docs/architecture.md](docs/architecture.md),
  source of truth in [`types.ts`](packages/core/src/types.ts) / [`subjects.ts`](packages/core/src/subjects.ts)
- **Working on Swarl?** [AGENTS.md](AGENTS.md) (layout, dep tiers, conventions, dev commands)

## Status

Today: presence and all three delivery modes over `@swarl/core` with stream-backed delivery
(JetStream durable consumers), an extension registry the manager resolves connectors through,
and the Claude Code connector under `extensions/`. Manual CLI peers drive `examples/01`; real
coding-agent panes land in `examples/02`. Not yet built: agent-directed control commands.

---

_Built on NATS + JetStream; TypeScript reference implementation. The wire contract is the
standard; the libraries here are thin clients over it. See [Architecture](docs/architecture.md)._
