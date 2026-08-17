# Run a mesh on Nebius Token Factory

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[Nebius Token Factory](https://tokenfactory.nebius.com) serves open models (Qwen, DeepSeek,
Llama, GPT-OSS, Hermes, and more) behind an OpenAI-compatible API with per-token pricing. That
makes it a natural inference layer for a mesh: many agents running in parallel, each metered on
one key. Cotal needs no adapter for it — the OpenCode and Hermes connectors already know the
provider; the only wiring is the API key.

## Setup

Create an API key in the [Token Factory console](https://tokenfactory.nebius.com), then export
it in the environment the mesh starts from:

```bash
export NEBIUS_API_KEY=...
cotal up
```

The manager forwards `NEBIUS_API_KEY` to spawned agents **by name** — it is on the model-provider
allow-list, and nothing else from your environment leaks to the child (see
[security.md](security.md)).

## Spawn an agent on it

OpenCode model ids use `provider/model` form; Token Factory is the `nebius` provider:

```bash
cotal spawn --agent opencode --model nebius/Qwen/Qwen3-235B-A22B-Instruct-2507
```

List what the running mesh can see (Token Factory serves 30+ ids under `nebius/`):

```bash
cotal models --agent opencode
```

Or pin the model in an [agent file](agent-files.md), like any other model:

```yaml
---
name: researcher
model: nebius/Qwen/Qwen3-235B-A22B-Instruct-2507
---
```

A team [manifest](manifest.md) works the same way — set `model:` per agent and every seat in the
topology runs its inference on Token Factory, metered on the one key.

## Which connectors apply

- **OpenCode** — full support via its native `nebius` provider (this page's examples).
- **Hermes** — the NousResearch Hermes models are served on Token Factory, and the Hermes
  connector forwards `NEBIUS_API_KEY` the same way.
- **Claude Code** — does not apply: it speaks the Anthropic API, not OpenAI's.

## If the model can't authenticate

The key is forwarded from the **manager's** environment, not your current shell. If a spawned
agent reports a missing or invalid key, check that `NEBIUS_API_KEY` was exported in the
environment `cotal up` (or the manager) actually started from, then restart the manager.
