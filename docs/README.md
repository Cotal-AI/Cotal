# Cotal docs

Cotal is a standard wire interface for software, especially AI agents, to coordinate in
real time as lateral peers in shared spaces. The standard is the wire contract itself
(subjects, message schemas, presence and discovery), defined in the normative
[spec](../SPEC.md); libraries are thin clients over it, and transport is NATS +
JetStream.

## Where to start

| You are… | Start with |
|---|---|
| **Evaluating**: what is this? | [What is Cotal](what-is-cotal.md) |
| **Running it**: agents on a mesh, on my machine | [Quickstart](getting-started.md) |
| **Building a client**: speaking the wire from another language | [Build a client](build-a-client.md) |
| **Implementing the contract**: conformance, shapes, versioning | [Spec](../SPEC.md), with [conformance](../SPEC.md#12-conformance), the [schema](../spec/cotal.schema.json), and the [change log](../SPEC.md#appendix-d-change-log) |

## For agents

These docs are agent-native: `https://docs.cotal.ai/llms.txt` routes by task, every docs
page has a Markdown twin (append `.md` to its URL, or send `Accept: text/markdown`; the
site landing is the one exception), and the message schema is machine-readable at
[`spec/cotal.schema.json`](../spec/cotal.schema.json).
Task dispatch:

| Task | Page | First command / tool |
|---|---|---|
| Install + start a local mesh, non-interactive | [Quickstart](getting-started.md) | `npx cotal-ai setup --yes && npx cotal-ai up --detach` |
| Put an agent on the mesh | [Quickstart](getting-started.md) | `cotal spawn` |
| Message peers from inside a session | [MCP tool catalog](mcp-tools.md) | `cotal_send` · `cotal_dm` · `cotal_anycast` |
| Spawn / define a teammate at runtime | [MCP tool catalog](mcp-tools.md) | `cotal_spawn` · `cotal_persona` |
| Declare a team + channels in one file | [Define a team](define-a-team.md) | `cotal up -f cotal.yaml` |
| Grant or audit channel access | [Channels & permissions](channels-and-permissions.md) | agent-file `allowPublish:` / `allowSubscribe:` |
| Watch a live mesh | [Watch a mesh](watch-a-mesh.md) | `cotal console` / `cotal web` |
| Mint credentials (static mesh) | [Identity & auth](identity-and-auth.md) | `cotal mint <name> --profile agent` |
| Sign in / grant a user's agents (user-auth mesh) | [Identity & auth](identity-and-auth.md) | `cotal login --idp <url>` · `cotal actor grant` |
| Implement the wire in another language | [Build a client](build-a-client.md) | validate against [`cotal.schema.json`](../spec/cotal.schema.json) |
| Check a normative rule | [Spec](../SPEC.md) | — |

## Start here

| Doc | Answers |
|---|---|
| [What is Cotal](what-is-cotal.md) | What is it, and what can it do? |
| [Quickstart](getting-started.md) | How do I install it and get a running mesh? |

## Guides

For operators running and watching a mesh:

| Doc | Answers |
|---|---|
| [Run a mesh](run-a-mesh.md) | How do I operate the local stack (modes, status, multiple meshes, history)? |
| [Define a team](define-a-team.md) | How do I declare a whole team in one `cotal.yaml` and launch it? |
| [Watch a mesh](watch-a-mesh.md) | How do I see who is doing what (terminal console, web dashboard)? |
| [Deploy](deploy.md) | How do I run agent teams against an external broker? |
| [Examples](examples.md) | Which runnable examples exist? |

For connector users putting an agent on the mesh:

| Doc | Answers |
|---|---|
| [Connect Claude](connect-claude.md) | How does a Claude Code session join the mesh? |
| [Connect OpenCode (beta)](connect-opencode.md) | How does an OpenCode session join? |
| [Connect Hermes (alpha)](connect-hermes.md) | How does a Hermes agent join? |

For protocol implementers:

| Doc | Answers |
|---|---|
| [Build a client](build-a-client.md) | How do I implement a conformant client in another language? |

## Concepts

| Doc | Answers |
|---|---|
| [Architecture](architecture.md) | How is it built (the thin waist, the pieces), and why? |
| [Spaces & channels](spaces.md) | What is a space, how does it differ from a channel? |
| [Transport vs protocol](transport.md) | What is protocol vs transport, and what must a binding provide? |
| [Presence & delivery](presence-and-delivery.md) | How do presence, the three delivery modes, and durable delivery work? |
| [Identity & auth](identity-and-auth.md) | Who can do what, and how is it enforced? |
| [Delivery daemon (Plane-3)](delivery-daemon.md) | What is the durable backstop, and why does it exist? |
| [Security model](security.md) | What is the trust boundary (what v0 protects and does not)? |

## Reference

| Doc | Answers |
|---|---|
| [CLI](cli.md) | Every `cotal` command and its flags. |
| [MCP tool catalog](mcp-tools.md) | Every `cotal_*` tool an agent gets, with inputs and side-effects. |
| [Agent files](agent-files.md) | Every field of `.cotal/agents/<name>.md`. |
| [Mesh manifest](manifest.md) | Every field of `cotal.yaml`. |
| [Channels & permissions](channels-and-permissions.md) | The three access verbs and how to grant them. |
| [Config & env](config.md) | The config file, every `COTAL_*` variable, the on-disk layout. |
| [MeshView](mesh-view.md) | The observer model behind console and web (reference implementation). |
| [Glossary](glossary.md) | Definitions of every term. |

## Specification

| Doc | Answers |
|---|---|
| [SPEC.md](../SPEC.md) | The **normative** wire contract (RFC-2119). Where a client disagrees with the spec, the spec wins. |
| [cotal.schema.json](../spec/cotal.schema.json) | The machine-readable message schema, authoritative for message shapes. |

## Project

For people changing how Cotal is built or shipped (not needed to use it).

| Doc | Answers |
|---|---|
| [Roadmap](roadmap.md) | What is deferred, and where each area is headed. |
| [Release](release.md) | How we version and publish. |
| [Setup internals](setup-internals.md) | How the `cotal setup` flow works. |

Each runnable example documents itself in its own `examples/*/README.md`. Working
build-plans and research live in the private `.internal/` submodule, not here.
