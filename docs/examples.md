# Examples

Examples live in [`examples/`](../examples), one self-contained folder each. They consume the
protocol (`packages/*`) through one or more implementations and add nothing to it: an example
only *configures + orchestrates* (roles, config, space name, runbook, optional driver) and
picks which extensions to register — never new message kinds, subjects, or endpoint methods.
Those belong in `@cotal-ai/core`, generalized. Dependency direction is one-way:
`examples → implementations → packages`, never back.

| Example | What it shows |
|---|---|
| [01 — Lateral Coordination](../examples/01-lateral-coordination/README.md) | Role-specialized endpoints join one shared space and coordinate laterally — presence, all three addressing modes, live state, observability, graceful leave, late join. |
| [02 — Orchestrated Handoff (cmux)](../examples/02-cmux-handoff/README.md) | Four real Claude Code agents in cmux tabs ship one change across three repos: one human prompt, then agent-to-agent fan-out and an automatic API→web handoff over the mesh. |
| [04 — Self-improving Console](../examples/04-self-improving-console/README.md) | A swarm of Claude Code agents joins one space and coordinates as lateral peers to rebuild Cotal's own `console` as a lazygit-style Ink/React TUI. |
| [05 — Personas](../examples/05-personas/README.md) | Ten personalities share one space and talk in real time — the same primitives as the other examples (presence, channels, DMs), but the peers are characters, not worker roles. |
