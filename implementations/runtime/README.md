# @cotal-ai/runtime

The host that runs a cotal-lang program on the mesh: the effect handler, the durable step-journal
store, and the run driver. Importing it registers the `cotal run` command and the `run-host` the
manager drives runs through.

**Tier:** `implementations/` (a self-contained surface over core). Depends on core, lang, and
workspace. Implementations never import each other; they meet at runtime over NATS.

See [docs/workflows.md](../../docs/workflows.md) and the [root AGENTS.md](../../AGENTS.md) for the
tier rules.
