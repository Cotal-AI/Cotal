Keep your answers short and to the point.

# Cotal
> Write the name as **Cotal**, not "COTAL" (the directory is all-caps, the name isn't).

A standard wire interface for software, especially AI agents, to coordinate in real
time as **lateral peers in a shared pub/sub space**, not as nodes in an orchestrator
tree. The wire contract (subjects, message schemas, presence/discovery conventions)
*is* the standard; libraries are thin clients over it. Transport is **NATS + JetStream**;
reference implementation is **TypeScript**.

New here? [docs/getting-started.md](docs/getting-started.md) is the fastest path to a
running mesh; [docs/setup-internals.md](docs/setup-internals.md) documents the `cotal setup`
flow + the invariants a repo change must keep in sync.
See [docs/OVERVIEW.md](docs/OVERVIEW.md) for *what* it does,
[docs/architecture.md](docs/architecture.md) for *how*, and
[docs/claude-code-integration.md](docs/claude-code-integration.md) for the Claude Code
hook / MCP / channel integration.

## Layout

pnpm + TypeScript ESM monorepo — four dependency tiers, one-way deps, Node ≥20:

- **`packages/*` — the protocol** (generic, the standard).
  - **@cotal-ai/core** — endpoint, subjects, message types; the NATS client layer + extension contracts (`Connector`, `Command`) and the `Registry` they self-register into.
- **`extensions/*` — pluggable adapters** (peer-depend core; self-register on import).
  - **@cotal-ai/connector-core** — shared MCP-bridge runtime (mesh agent, `cotal_*` tool specs incl. `cotal_spawn` / `cotal_persona` / `cotal_despawn` / `cotal_purge`, hook relay); the adapters are thin clients over it.
  - **@cotal-ai/connector-claude-code** — Claude Code adapter (installed plugin + `claude/channel` push).
  - **@cotal-ai/connector-codex** — Codex adapter (pull-only MCP server injected via `codex -c`; no plugin, no hooks).
  - **@cotal-ai/connector-opencode** — OpenCode adapter (native in-process plugin injected via `OPENCODE_CONFIG_CONTENT`; renders the shared `cotal_*` tool specs as plugin tools).
  - **@cotal-ai/cmux** — the cmux integration: a thin driver over the [cmux](https://github.com/) CLI (open/close a tab, send keys) **plus a self-registering `cmux` Runtime**. Importing it registers the runtime with the core `Registry`, so the manager spawns into cmux tabs without depending on this package (opt-in via one import; the `cotal` binary does it).
- **`implementations/*` — opinionated surfaces** over core (self-contained; never import each other).
  - **@cotal-ai/cli** — mesh CLI: `up`/`down`, `join`, `watch`, `console` (thin NATS clients), `spawn` — a foreground agent launch reusing the connector's launch recipe, with `--resume <id>` to late-join an existing Claude Code session onto the mesh (fork by default, `--in-place` to continue the same id) — and `setup`, the two-tier guided flow (bundled NATS binary, Claude plugin install, interactive Claude handoff on failures). First run (no `~/.cotal/onboarded.json`) is the full narrated/clack flow; later runs are a compact ensure+status; `setup --full` forces the full flow.
  - **@cotal-ai/manager** — agent supervisor: a mesh endpoint that spawns/manages nodes via a pluggable `Runtime` (`pty` default / `tmux` / `cmux`), plus its own control-plane commands (`start`/`stop`/`ps`/`attach`) and a WS attach endpoint.
- **`bin/` — the published `cotal-ai` package**: `cotal.ts` is the composition root for the `cotal` binary — imports the implementations it wants (which self-register their commands) and runs them. `npx cotal-ai` with no args runs the guided `setup`.
- **`examples/*` — use-cases** (composition roots; private, never published).

Tiers depend one-way: `examples → implementations → packages ← (peer) extensions`. An
example only *configures + orchestrates* (roles, config, space name, runbook, optional
driver) and picks which extensions to register; it never adds message kinds, subjects, or
endpoint methods — those go into `core`, generalized. Implementations never import each
other (they meet at runtime over NATS, and compose only at a root). Extensions, connectors
and commands **self-register into the core `Registry` on import**; a composition root just
imports the surfaces it wants. See [docs/examples.md](docs/examples.md) for the index.

## Commands

```bash
pnpm cotal <cmd>   # run the CLI (tsx bin/cotal.ts — base + manager commands)
pnpm smoke         # core smoke test
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

## Status

Demo 1 (the lateral-coordination showcase, [examples/01](examples/01-lateral-coordination/README.md))
is **done** — mesh, control plane, and the coding-agent connectors run end-to-end.
Current work is public-facing: the README ([design doc](docs/plans/readme.md)), docs,
and the hosted onboarding funnel.

## Research & web tools

- **For searching the web** (open-ended queries, finding docs, looking up current info), prefer the **Tavily MCP** (`tavily_search` / `tavily_research`) — it returns higher-signal results than built-in search.
- **For fetching a specific known URL**, use the built-in `WebFetch` — don't route those through Tavily.

When implementing a feature, **always research online first** (NATS/JetStream APIs,
MCP SDK, A2A/SLIM conventions, etc.) before replying or writing code — verify current behavior against real docs rather than relying on memory.

## Conventions

- **Keep the code clean and minimal** — no bloat, no overcomplication.
- Keep documentation short and not verbose; As if a human wrote it.
- Do only what I ask, not more, not less. Don't add features or abstractions that aren't explicitly requested or clearly needed.
- **Keep the docs updated** — when behavior changes, update the affected docs
  ([OVERVIEW](docs/OVERVIEW.md), [architecture](docs/architecture.md),
  [claude-code-integration](docs/claude-code-integration.md)) in the same change so they
  never drift from the code. `docs/` describes the **protocol** only; each example documents
  itself in its own `examples/*/README.md`.
- ESM only (`"type": "module"`); run TS directly with `tsx`, no build step needed for dev.
- Core primitives: endpoint, agent node, space, channel, direct message, presence, history.
- Delivery modes (SLIM-inspired): multicast / unicast / anycast.
- Never use fallbacks in the code, rather throw if something isn't supported in the current environment or configuration.
- Always try to use native features of NATS/JetStream first, rather than re-implementing them.
- Don't switch branches without being prompted to, if you need to work independently, do so in a git worktree.