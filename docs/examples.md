# Examples

Examples live in [`examples/`](../examples), one self-contained folder each. They consume
the protocol (`packages/*`) through one or more implementations and add nothing to it. An
example only *configures and orchestrates* (roles, config, space name, runbook, optional
driver) and picks which extensions to register. It never adds new message kinds, subjects,
or endpoint methods; those belong in `@cotal-ai/core`, generalized. Dependency direction is
one-way: `examples → implementations → workspace → core`, never back.

| Example | What it shows |
|---|---|
| [01: Lateral Coordination](../examples/01-lateral-coordination/README.md) | Role-specialized endpoints join one shared space and coordinate laterally: presence, all three addressing modes, live state, observability, graceful leave, late join. |
| [02: Self-improving Console](../examples/02-self-improving-console/README.md) | A swarm of four real Claude Code agents in cmux tabs rebuilds Cotal's own console as a lazygit-style Ink/React TUI, coordinating as lateral peers over the mesh. |
| [04: Frontier Faces](../examples/04-frontier-faces/README.md) | Ten panelist personas as animated pixel-art OpenCode agents: each lip-syncs its streamed reply and steers its own expression, and on the mesh they coordinate as lateral peers in one space. |
