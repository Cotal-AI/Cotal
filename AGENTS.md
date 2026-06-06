Keep your answers short and to the point.

# Swarl
> Write the name as **Swarl**, not "SWARL" (the directory is all-caps, the name isn't).

A standard wire interface for software — especially AI agents — to coordinate in real
time as **lateral peers in a shared pub/sub space**, not as nodes in an orchestrator
tree. The wire contract (subjects, message schemas, presence/discovery conventions)
*is* the standard; libraries are thin clients over it. Transport is **NATS + JetStream**;
reference implementation is **TypeScript**.

See [docs/OVERVIEW.md](docs/OVERVIEW.md) for *what* it does,
[docs/architecture.md](docs/architecture.md) for *how*, and
[docs/claude-code-integration.md](docs/claude-code-integration.md) for the Claude Code
hook / MCP / channel integration.

## Layout

pnpm + TypeScript ESM monorepo — four dependency tiers, one-way deps, Node ≥20:

- **`packages/*` — the protocol** (generic, the standard).
  - **@swarl/core** — endpoint, subjects, message types; the NATS client layer + extension registry.
  - **@swarl/manager** — agent supervisor + control plane (spawns/manages nodes).
- **`extensions/*` — pluggable adapters** (peer-depend core, self-register through its registry).
  - **@swarl/connector** — MCP bridge (`@modelcontextprotocol/sdk`, zod) for Claude Code / Codex.
  - **@swarl/cmux** — a spawn `Runtime` that places spawned agents into cmux panes.
- **`implementations/*` — opinionated surfaces** over core.
  - **@swarl/cli** — `swarl` commands: `up`, `join`, `manager`, `control`, `watch`.
- **`examples/*` — use-cases** (composition roots; private, never published).

Tiers depend one-way: `examples → implementations → packages ← (peer) extensions`. An
example only *configures + orchestrates* (roles, config, space name, runbook, optional
driver) and picks which extensions to register; it never adds message kinds, subjects, or
endpoint methods — those go into `core`, generalized. Implementations never import each
other (they meet at runtime over NATS). See [docs/examples.md](docs/examples.md) for the index.

## Core primitives

- **Endpoint** — any software on the mesh: a long-lived connection with its own presence.
- **Agent node** — an endpoint with identity, role, and capabilities (an A2A-style `AgentCard`).
- **Space** — one collaboration, isolated from other spaces.
- **Channel** — a named topic participants broadcast on and subscribe to.
- **Direct message / presence / history** — peer-to-peer messages, a live roster
  (`idle` / `waiting` / `working` / `offline`), and replayable past traffic.
- **Delivery modes** (SLIM-inspired): **multicast** (a channel), **unicast** (one peer),
  **anycast** (any one instance of a role).

## Commands

```bash
pnpm swarl <cmd>   # run the CLI (tsx implementations/cli/src/index.ts)
pnpm smoke         # core smoke test
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Working on features

When implementing a feature, **always research online first** (NATS/JetStream APIs,
MCP SDK, A2A/SLIM conventions, etc.) before replying or writing code — verify current behavior
against real docs rather than relying on memory.

## Conventions

- **Keep the code clean and minimal** — no bloat, no overcomplication.
- Keep documentation short and not verbose; as if a human wrote it.
- Do only what I ask, not more, not less. Don't add features or abstractions that aren't
  explicitly requested or clearly needed.
- **Keep the docs updated** — when behavior changes, update the affected docs
  ([OVERVIEW](docs/OVERVIEW.md), [architecture](docs/architecture.md),
  [claude-code-integration](docs/claude-code-integration.md)) in the same change so they
  never drift from the code. `docs/` describes the **protocol** only; each example documents
  itself in its own `examples/*/README.md`.
- ESM only (`"type": "module"`); run TS directly with `tsx`, no build step needed for dev.
- Never use fallbacks in the code, rather throw if something isn't supported in the current
  environment or configuration.
