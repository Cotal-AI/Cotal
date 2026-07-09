# Examples

Examples live in [`examples/`](../examples), one self-contained folder each. They consume
the protocol (`packages/*`) through one or more implementations and add nothing to it. An
example only *configures and orchestrates* (roles, config, space name, runbook, optional
driver) and picks which extensions to register. It never adds new message kinds, subjects,
or endpoint methods; those belong in `@cotal-ai/core`, generalized. Dependency direction is
one-way: `examples → implementations → packages`, never back.

| Example | What it shows |
|---|---|
| [01: Lateral Coordination](../examples/01-lateral-coordination/README.md) | Role-specialized endpoints join one shared space and coordinate laterally: presence, all three addressing modes, live state, observability, graceful leave, late join. |
| [02: Self-improving Console](../examples/02-self-improving-console/README.md) | A swarm of four real Claude Code agents in cmux tabs rebuilds Cotal's own console as a lazygit-style Ink/React TUI, coordinating as lateral peers over the mesh. |
| [04: Gateway Council Review](../examples/04-gateway-council-review/README.md) | A Glock-style review council implemented as real Cotal personas: nine focused reviewers, one OpenCode/GPT security reviewer, deterministic gate JSON, vetoes, triggered debate, and final verdict channels. |
| [05: Local Code Review Bench](../examples/05-code-review-bench-local/README.md) | A local Martian Code Review Bench harness that runs isolated GPT+GLM reviewer passes and emits Martian-compatible artifacts for precision/recall/F1 judging. |
