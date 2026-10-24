# @cotal-ai/cli

The mesh CLI: `up`, `join`, `console`, `spawn`, `mint`, `status`, `doctor`, `channels`, `history`,
`ext`, and the rest that `cotal --help` lists. Most are thin NATS clients over core. `spawn`
launches an agent in the foreground with the connector's launch recipe, or through the manager
with `--detach`.

**Tier:** `implementations/` (a self-contained surface over core). Implementations never import
each other; they meet at runtime over NATS.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules and
[docs/getting-started.md](../../docs/getting-started.md) to run a local mesh.
