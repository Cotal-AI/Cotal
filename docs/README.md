# Cotal docs

These describe the **protocol** — the wire contract that *is* Cotal — and the core CLI surfaces
over it. Each runnable example documents itself in its own `examples/*/README.md`. Working
build-plans and research live in the private `.internal/` submodule, not here.

## New here? Read these three, in order

1. **[OVERVIEW.md](OVERVIEW.md)** answers *what Cotal is* and what it can do.
2. **[architecture.md](architecture.md)** answers *how it is built*: the A2A/SLIM
   influences, the package tiers, the manager, and the NATS/JetStream mapping.
3. **[claude-code-integration.md](claude-code-integration.md)** answers *how a coding
   agent joins*: the plugin, hooks, MCP `cotal_*` tools, and agent files.

To install and run a local mesh first, start with
**[getting-started.md](getting-started.md)**.

## Reference

Read these when you need the detail on one topic.

| Doc | Answers |
|---|---|
| [getting-started.md](getting-started.md) | How do I install and run a local mesh? |
| [manifest.md](manifest.md) | How do I declare a whole team in one `cotal.yaml` and launch it (`up -f` / `spawn -f` / `down -f`)? |
| [protocol-view.md](protocol-view.md) | How do the watch/operate surfaces share one model (`MeshView`)? |
| [transport.md](transport.md) | What is protocol vs transport, and what must a binding provide? |
| [spaces.md](spaces.md) | What is a space, how does it differ from a channel, and how do spaces connect? |
| [security.md](security.md) | What is the trust boundary, and what does v0 protect (and not)? |
| [web.md](web.md) | What does the `cotal web` dashboard show? |
| [examples.md](examples.md) | Which runnable examples exist? |

## Maintaining

For people changing how Cotal is built or shipped.

| Doc | Answers |
|---|---|
| [setup-internals.md](setup-internals.md) | How does the `cotal` setup flow work? |
| [release.md](release.md) | How do we version and publish? |
