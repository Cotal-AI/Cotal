# @cotal-ai/cli

The mesh CLI: `setup`, `up`, `down`, `join`, `spawn`, `send`, `chat`, `status`, `doctor`,
`channel`, `history`, `ext` and the rest that `cotal help` lists. Most are thin NATS clients over
core. `spawn` runs an agent in this terminal with the connector's launch recipe, or through a
manager with `--detach` or `--on <instance>`. Every command is described in the
[CLI reference](../../docs/cli.md).

This package lives in the `implementations/` tier, a self-contained surface over core.
Implementations never import each other; they meet at runtime over NATS.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules and
[docs/getting-started.md](../../docs/getting-started.md) to run a local mesh.
