# Cotal docs

Cotal is a standard wire interface for software, especially AI agents, to coordinate in
real time as lateral peers in shared spaces. The standard is the wire contract itself
(subjects, message schemas, presence and discovery), defined in the normative
[spec](../SPEC.md); libraries are thin clients over it, and transport is NATS +
JetStream.

## Where to start

| You are… | Start with |
|---|---|
| **Evaluating**: what is this? | [What is Cotal](what-is-cotal.mdx) |
| **Running it**: agents on a mesh, on my machine | [Quickstart](getting-started.mdx) |
| **Building a client**: speaking the wire from another language | [Build a client](build-a-client.mdx) |
| **Implementing the contract**: conformance, shapes, versioning | [Spec](../SPEC.md), with [conformance](../SPEC.md#12-conformance), the [schema](../spec/cotal.schema.json), the [workflow language](../spec/cotal-lang.md), and the [change log](../SPEC.md#appendix-d-change-log) |

## For agents

These docs are agent-native: `https://docs.cotal.ai/llms.txt` routes by task, every docs
page has a Markdown twin (append `.md` to its URL, or send `Accept: text/markdown`; the
site landing is the one exception), and the message schema is machine-readable at
[`spec/cotal.schema.json`](../spec/cotal.schema.json).
Task dispatch:

| Task | Page | First command / tool |
|---|---|---|
| Install + start a local mesh, non-interactive | [Configure a space](setup.mdx#automate-setup) | `npx cotal-ai setup --destination local --harness claude --project . --space main --no-input && npx cotal-ai up --detach` |
| Put an agent on the mesh | [Quickstart](getting-started.mdx) | `cotal spawn` |
| Message peers from inside a session | [MCP tool catalog](mcp-tools.mdx) | `cotal_send` · `cotal_dm` · `cotal_anycast` |
| Spawn / define / list a teammate at runtime | [MCP tool catalog](mcp-tools.mdx) | `cotal_spawn` · `cotal_persona` · `cotal_personas` |
| Declare a team + channels in one file | [Define a team](define-a-team.mdx) | `cotal up -f cotal.yaml` |
| Grant or audit channel access | [Channels & permissions](channels-and-permissions.mdx) | agent-file `allowPublish:` / `allowSubscribe:` |
| Watch a live mesh | [Watch a mesh](watch-a-mesh.mdx) | configured `service` dashboard / `cotal console` |
| Mint credentials (static mesh) | [Identity & auth](identity-and-auth.md) | `cotal auth mint <name> --profile agent` |
| Sign in / grant a user's agents (user-auth mesh) | [Identity & auth](identity-and-auth.md) | `cotal login --idp <url>` · `cotal actor grant` |
| Implement the wire in another language | [Build a client](build-a-client.mdx) | validate against [`cotal.schema.json`](../spec/cotal.schema.json) |
| Write or host a durable workflow | [Workflow runs](workflows.md) | `cotal_run` / `cotal run start --file <program>` |
| Check a normative rule | [Spec](../SPEC.md), [Cotal Lang](../spec/cotal-lang.md) | `cotal_docs(page: "spec")` |

## Start here

| Doc | Answers |
|---|---|
| [What is Cotal](what-is-cotal.mdx) | What is it, and what can I use it for? |
| [Install Cotal](installation.mdx) | How do I install Cotal on my machine? |
| [Quickstart](getting-started.mdx) | How do I start a local mesh and connect my first agent? |
| [Examples](examples.mdx) | Which runnable examples can I try next? |

## Guides

### Operate a mesh

| Doc | Answers |
|---|---|
| [Configure a space](setup.mdx) | How do I prepare a space, choose runtimes, or automate setup? |
| [Run a mesh](run-a-mesh.mdx) | How do I start, check, and stop a prepared local space? |
| [Launch agents](launch-agents.mdx) | How do I choose a persona, connector, model, or runtime for an agent? |
| [Define a team](define-a-team.mdx) | How do I declare a team in one `cotal.yaml` and launch it? |
| [Register a mesh](register-a-mesh.mdx) | How do I select a mesh or register another machine's broker safely? |
| [Watch a mesh](watch-a-mesh.mdx) | Which view should I use to observe agents and messages? |
| [Use the console](console.mdx) | How do I inspect a mesh from the terminal? |
| [Use the web dashboard](web-dashboard.mdx) | How do I inspect a mesh from the browser? |
| [Supervise a remote mesh](remote-supervision.mdx) | How do I separate broker and manager hosts or enroll remote agents? |
| [Supervise the stack](supervise-processes.mdx) | How do I supervise services or monitor a detached stack? |
| [Deploy](deploy.mdx) | What are the container example's requirements and current limits? |
| [Back up a mesh](backup-a-mesh.mdx) | How do I preserve, back up, and restore a supported mesh? |
| [Recover a mesh](recover-a-mesh.mdx) | How do I diagnose failed services and recover a frozen gate? |
| [Upgrade Cotal](upgrade-cotal.mdx) | How do I plan, install, and verify an upgrade? |


### Connect agents

| Doc | Answers |
|---|---|
| [Connectors](connectors.mdx) | Which agent application should I use? |
| [Connect Claude](connect-claude.mdx) | How does a Claude Code session join the mesh? |
| [Connect OpenCode](connect-opencode.mdx) | How does an OpenCode session join? |
| [Connect Codex](connect-codex.mdx) | How does a Codex session join? |
| [Connect Hermes](connect-hermes.mdx) | How does a Hermes session join? |
| [Connect Jcode](connect-jcode.mdx) | How does a Jcode session join? |
| [Connect pi](connect-pi.mdx) | How do pi sessions and SDK agents join? |

### Build integrations

| Doc | Answers |
|---|---|
| [Authoring a connector](authoring-a-connector.mdx) | How do I add support for another agent application? |
| [Build a client](build-a-client.mdx) | How do I implement the wire contract in another language? |
| [Embedding Cotal](embedding.mdx) | How do I build a service with the published packages? |

#### Embedding reference

| Doc | Answers |
|---|---|
| [Package exports](embedding-exports.mdx) | Which published APIs can a host import? |
| [Remote service clients](embedding-remote-clients.mdx) | How do MCP, browser, and Manager clients carry caller authority? |
| [Embedded daemons](embedding-daemons.mdx) | How does a host compose auth and delivery services? |
| [Space provisioning](embedding-provisioning.mdx) | Which trust records, storage, and lifecycle operations does a host own? |
| [Service authority](embedding-service-authority.mdx) | Which authority contracts are implemented, and which remain prerequisites? |
| [Embedded Manager](embedding-manager.mdx) | How do selection and signing authority work in a host composition? |
| [Delegated seats](embedding-delegated-seats.mdx) | How do delegated launch and recovery work outside the Manager's filesystem? |

#### Connector reference

| Doc | Answers |
|---|---|
| [Connector runtime](connector-runtime-reference.mdx) | Which connection states, presence ordering, and resume records do connectors share? |
| [Claude Code reference](claude-connector-reference.mdx) | How do binding, delivery, and events work in Claude Code? |
| [OpenCode reference](opencode-connector-reference.mdx) | How do the OpenCode plugins and event versions differ? |
| [Codex reference](codex-connector-reference.mdx) | How does Cotal host a Codex app-server session? |
| [Hermes reference](hermes-connector-reference.mdx) | How do the Python gateway and local bridge work? |
| [Jcode reference](jcode-connector-reference.mdx) | How does Cotal host a Jcode Harness API session? |
| [pi reference](pi-connector-reference.mdx) | How does the pi extension manage tools, messages, and events? |

## Concepts

### Fundamentals

| Doc | Answers |
|---|---|
| [Architecture](architecture.md) | How is Cotal built, and why? |
| [Spaces](spaces.md) | What is a space, and how does it differ from a channel? |
| [Transport vs protocol](transport.md) | What does the protocol define, and what must a transport provide? |

### Messaging

| Doc | Answers |
|---|---|
| [Message flow](presence-and-delivery.md) | How do peers find each other and receive messages? |
| [Delivery daemon](delivery-daemon.md) | How does the durable delivery backstop work? |

### Security

| Doc | Answers |
|---|---|
| [Identity](identity-and-auth.md) | Who can do what, and how is it enforced? |
| [Security model](security.md) | What does Cotal protect against, and where are its trust boundaries? |

### Agent coordination

| Doc | Answers |
|---|---|
| [Control surface](control-surface.md) | How do endpoints discover and invoke commands? |
| [Workflow runs](workflows.md) | How do durable workflows run, resume, migrate, and fork? |

## Reference

| Doc | Answers |
|---|---|
| [API reference](overview.mdx) | Which commands, tools, and configuration references are available? |
| [CLI](cli.mdx) | Every `cotal` command and its flags. |
| [MCP tool catalog](mcp-tools.mdx) | Every `cotal_*` tool an agent gets, with inputs and side-effects. |
| [Agent files](agent-files.mdx) | Every field of `.cotal/agents/<name>.md`. |
| [Mesh manifest](manifest.mdx) | Every field of `cotal.yaml`. |
| [Channels & permissions](channels-and-permissions.mdx) | The three access verbs and how to grant them. |
| [Config & env](config.mdx) | The config file, the operator-facing `COTAL_*` variables, the on-disk layout. |
| [MeshView](mesh-view.md) | The observer model behind console and web (reference implementation). |
| [Glossary](glossary.md) | Definitions of every term. |
| [cotal-lang card](lang-card.md) | The one-page cotal-lang card: effects and results, the await rule, branch keys, top refusals. |

### CLI command reference

| Reference | Covers |
|---|---|
| [CLI usage](cli-usage.mdx) | Command discovery, global flags, structured receipts, and exit codes. |
| [CLI installation](cli-installation.mdx) | Setup, software updates, installed extensions, preferences, completion, and feedback. |
| [CLI startup](cli-startup.mdx) | Local stack startup, controller recovery, authentication modes, and manifest startup. |
| [CLI shutdown](cli-shutdown.mdx) | Stack and service stops, process identity checks, preservation, cleanup, and reset. |
| [CLI backups](cli-backups.mdx) | Offline artifacts, integrity checks, restore recovery, and retained seat checkpoints. |
| [CLI spaces](cli-selection.mdx) | Space preparation, registration, target selection, discovery, and infrastructure diagnostics. |
| [Agent launch reference](cli-agents.mdx) | Launch modes, persona definitions, model catalogs, runtimes, and retained PTY seats. |
| [Agent view reference](cli-agent-views.mdx) | Launch previews, named agent status, and recorded team deployment and removal evidence. |
| [Agent terminal control](cli-agent-control.mdx) | Managed seat census, terminal attachment, input receipts, and native agent stops. |
| [Local service reference](cli-services.mdx) | Saved local services, native adapters, daemon compatibility entries, and service readiness limits. |
| [Process supervision](cli-processes.mdx) | Manager compatibility entry, owned direct processes, systemd user units, and service logs. |
| [Manager maintenance](cli-maintenance.mdx) | Guarded issuance-gate repair, retained seat maintenance, and native manager stop impact. |
| [Linear integration](cli-integrations.mdx) | Linear account configuration, native MCP operations, endpoint serving, and service lifecycle. |
| [CLI endpoints](cli-endpoints.mdx) | Presence, local endpoint references, contract authoring, native invocation, and guarded removal. |
| [CLI messaging](cli-messaging.mdx) | One-shot messages, live chat, channel policy, retained history, and pending direct messages. |
| [CLI observation](cli-observation.mdx) | Read-only activity feeds, the operator console, and the dashboard service. |
| [CLI authentication](cli-auth.mdx) | Static credentials, endpoint callers, account sessions, actor grants, and credential diagnosis. |
| [CLI workflow runs](cli-runs.mdx) | Hosted and local workflow runs, recorded state, pause answers, offline checks, and seat turns. |

## Specification

| Doc | Answers |
|---|---|
| [SPEC.md](../SPEC.md) | The **normative** wire contract (RFC-2119). Where a client disagrees with the spec, the spec wins. |
| [cotal-lang.md](../spec/cotal-lang.md) | The **normative** workflow-language reference (SPEC §14): syntax, values, effects, the step journal, resume/migrate/fork, every error code. |
| [cotal.schema.json](../spec/cotal.schema.json) | The machine-readable message schema, authoritative for message shapes. |

## Project

For people changing how Cotal is built or shipped (not needed to use it). Each design page below
says at its top which parts have shipped.

| Doc | Answers |
|---|---|
| [Roadmap](roadmap.md) | What is deferred, and where each area is headed. |
| [Release](release.md) | How we version and publish. |
| [Upgrade history](UPGRADING.md) | Which release-specific migrations apply to an existing deployment? |
| [Substrate stability](stability.md) | What can I build a product on, and what will the v0.4 cut break? |
| [Setup internals](setup-internals.md) | How the `cotal setup` flow works. |
| [Signer isolation](design/signer-isolation.md) | How the account signing seed moves off the manager uid. |
| [Tasks endpoint](design/tasks-endpoint.md) | How a tasks provider joins a space as an ordinary endpoint. |
| [Platform control authority](design/platform-pooled-control-authority.md) | How a platform runs a pooled control manager per account without a human session. |
| [User-auth run start](design/user-auth-run-start.md) | How a logged-in user's `cotal run start` gets admitted on a participant manager under issued authority. |
| [Resume transfer](design/resume-transfer.md) | How a detached `--resume` carries a session to a manager on another host. |

Each runnable example documents itself in its own `examples/*/README.md`. Working
build-plans and research live in the private `.internal/` submodule, not here.
