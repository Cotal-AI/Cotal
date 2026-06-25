# @cotal-ai/manager

The agent supervisor: a mesh endpoint that spawns and manages nodes via a pluggable `Runtime`
(`pty` built-in; `tmux` via `@cotal-ai/tmux`; `cmux` via `@cotal-ai/cmux`), plus its own control-plane commands
(`start`/`stop`/`ps`/`attach`) and a WebSocket attach endpoint.

It owns process lifecycle and config, not the agents' work; agents still coordinate laterally
over the mesh.

**Tier:** `implementations/` (a self-contained surface over core). Implementations never import
each other; they meet at runtime over NATS.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
