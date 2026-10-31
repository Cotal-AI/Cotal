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
| **Choosing a path**: personal sessions, hosted spaces, teams or services | [Choose a workflow](using-cotal.mdx) |
| **Integrating**: scripts, services or agent tools | [API reference](api-reference.mdx) |
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
| Install + start a local mesh, non-interactive | [Quickstart](getting-started.mdx) | `npx cotal-ai setup --destination local --harness claude --project . --space main --no-input && npx cotal-ai up --root . --space main --detach` |
| Put an agent on the mesh | [Quickstart](getting-started.mdx) | `cotal spawn` |
| Message peers from inside a session | [MCP tool catalog](mcp-tools.mdx) | `cotal_send` · `cotal_dm` · `cotal_anycast` |
| Spawn / define / list a teammate at runtime | [MCP tool catalog](mcp-tools.mdx) | `cotal_spawn` · `cotal_persona` · `cotal_personas` |
| Declare a team + channels in one file | [Define a team](define-a-team.mdx) | `cotal up -f cotal.yaml` |
| Grant or audit channel access | [Channels & permissions](channels-and-permissions.mdx) | agent-file `allowPublish:` / `allowSubscribe:` |
| Watch a live mesh | [Watch a mesh](watch-a-mesh.mdx) | configured `service` dashboard / `cotal console` |
| Mint credentials (static mesh) | [Identity & auth](identity-and-auth.mdx) | `cotal auth mint <name> --profile agent` |
| Sign in / grant a user's agents (user-auth mesh) | [Identity & auth](identity-and-auth.mdx) | `cotal login --idp <url>` · `cotal actor grant` |
| Implement the wire in another language | [Build a client](build-a-client.mdx) | validate against [`cotal.schema.json`](../spec/cotal.schema.json) |
| Write or host a durable workflow | [Workflow runs](workflows.mdx) | `cotal_run` / `cotal run start --file <program>` |
| Check a normative rule | [Spec](../SPEC.md), [Cotal Lang](../spec/cotal-lang.md) | `cotal_docs(page: "spec")` |

## Docs

### Start here

| Page | Covers |
|---|---|
| [What is Cotal](what-is-cotal.mdx) | How Cotal lets agents and other software find each other and exchange messages. |
| [Install Cotal](installation.mdx) | Install the cotal command with the shell installer or npm. |
| [Quickstart](getting-started.mdx) | Start a local Cotal mesh, launch an agent, and watch it join. |
| [Choose a workflow](using-cotal.mdx) | Choose how to connect sessions, join spaces, launch teams, and run durable work. |
| [Examples](examples.mdx) | Choose a working example of agents collaborating through Cotal. |

### Guides

#### Operate a mesh

| Page | Covers |
|---|---|
| [Configure a space](setup.mdx) | Prepare a project, choose its agent application, and save its space settings. |
| [Run a mesh](run-a-mesh.mdx) | Start, inspect, and stop the local stack in a prepared project. |
| [Launch agents](launch-agents.mdx) | Launch an agent through a manager, attach to its terminal, and choose its persona and runtime. |
| [Define a team](define-a-team.mdx) | Describe agents and channels in a manifest, then boot or deploy that team. |
| [Register a mesh](register-a-mesh.mdx) | Choose the mesh a command targets and register remote brokers with verified trust. |
| [Watch a mesh](watch-a-mesh.mdx) | Choose a terminal display, line stream, or read-only browser dashboard for a running mesh. |
| [Telemetry](telemetry.mdx) | CLI usage telemetry fields, levels, storage, delivery, and opt-outs. |
| [Use the console](console.mdx) | Inspect a mesh from the terminal and use authorized operator controls. |
| [Use the web dashboard](web-dashboard.mdx) | Configure the read-only dashboard and inspect a space through a protected browser session. |
| [Supervise a remote mesh](remote-supervision.mdx) | Separate broker and manager hosts, publish an exchange, and enroll remote agents. |
| [Supervise the stack](supervise-processes.mdx) | Choose process ownership under systemd and monitor actual component health. |
| [Deploy agent teams](deploy.mdx) | Review the container example, its current build limitation, and the credentials it needs. |
| [Back up a mesh](backup-a-mesh.mdx) | Preserve a supported mesh, create an offline backup, and restore it within the original trust boundary. |
| [Recover a mesh](recover-a-mesh.mdx) | Use status and logs to diagnose service failures, stuck presence, or a frozen registration gate. |
| [Upgrade Cotal](upgrade-cotal.mdx) | Choose an exact release, prepare the deployment, and verify the upgraded installation. |

#### Connect agents

| Page | Covers |
|---|---|
| [Connectors](connectors.mdx) | Choose an agent application and connect its sessions to a Cotal mesh. |
| [Connect Claude](connect-claude.mdx) | Connect Claude Code to a mesh, launch an agent, and choose how it receives messages and tools. |
| [Connect OpenCode](connect-opencode.mdx) | Launch OpenCode on a Cotal mesh and choose the model and options for your installed version. |
| [Connect Codex](connect-codex.mdx) | Launch Codex on a Cotal mesh, choose a model, and set its sandbox permissions. |
| [Connect Hermes (alpha)](connect-hermes.mdx) | Run a Hermes gateway on a Cotal mesh with a managed profile or your own Hermes profile. |
| [Connect Jcode (beta)](connect-jcode.mdx) | Launch a private Jcode session on a Cotal mesh, choose its model, and fork an existing transcript. |
| [Connect pi (alpha)](connect-pi.mdx) | Launch pi on a Cotal mesh or load the Cotal extension into your own pi host. |

#### Build integrations

| Page | Covers |
|---|---|
| [Authoring a connector](authoring-a-connector.mdx) | Add support for an agent application through Cotal's connector interface and extension loader. |
| [Build a Cotal client](build-a-client.mdx) | Implement a client in another language using the wire specification and a NATS client library. |
| [Embedding Cotal](embedding.mdx) | Choose the published packages and authority boundaries for a service built on Cotal. |

##### Embedding reference

| Page | Covers |
|---|---|
| [Embedding package exports](embedding-exports.mdx) | Public package entry points, endpoint credentials, and Manager execution contracts. |
| [CotalEndpoint reference](embedding-endpoints.mdx) | Presence metadata, observer freshness, write diagnosis, liveness probes, and DM-only endpoint readers. |
| [Embedded remote clients](embedding-remote-clients.mdx) | MCP conversation routing, browser callers, remote Manager clients, and private-result prerequisites. |
| [Embedded daemon lifecycle](embedding-daemons.mdx) | Process runners, account-scoped hosted services, and delivery credential renewal. |
| [Embedded space provisioning](embedding-provisioning.mdx) | Broker trust, space credentials, durable host state, and current hosting limitations. |
| [Space schema inspection](embedding-schema-inspection.mdx) | Resource definitions, bounded read-only observations, and the limits of schema and initialization comparisons. |
| [Service authority contracts](embedding-service-authority.mdx) | Service authority contracts, platform supervisors, revocation prerequisites, and native custody limits. |
| [Native service custody](embedding-service-custody.mdx) | Immutable service reservations, bootstrap, cancellation, and bounded writer guarantees. |
| [Service endpoint hosting](embedding-service-host.mdx) | Owner approvals, native host operations, registration, and lifecycle custody. |
| [Service endpoint access](embedding-service-access.mdx) | Authority proofs, serving credentials, verified grants, and renewal. |
| [Service endpoint callers](embedding-service-callers.mdx) | Caller policy grants, broker payload prerequisites, revocation, and recovery limits. |
| [Manager embedding authority](embedding-manager.mdx) | Manager startup, signer custody, remote authority callbacks, and delegated user intent contracts. |
| [Delegated seat contracts](embedding-delegated-seats.mdx) | Managed lifecycle handoff, provider closure guarantees, and the limits of delegated recovery contracts. |

##### Connector reference

| Page | Covers |
|---|---|
| [Connector runtime reference](connector-runtime-reference.mdx) | Shared connection recovery, presence display, send receipts, delivery acknowledgement, reply correlation, and resume records. |
| [Claude connector reference](claude-connector-reference.mdx) | Binding, delivery, presence, event recording, and hosting contracts for the Claude Code connector. |
| [OpenCode connector reference](opencode-connector-reference.mdx) | OpenCode version support, injected configuration, session delivery, and structured event limits. |
| [Codex connector reference](codex-connector-reference.mdx) | Codex launch options, private credentials, delivery behavior, presence, and structured event limits. |
| [Hermes connector reference](hermes-connector-reference.mdx) | Hermes gateway ownership, profile state, delivery rules, presence hooks, and session forks. |
| [Jcode connector reference](jcode-connector-reference.mdx) | Private Jcode process ownership, session forks, readiness checks, model selection, and event delivery. |
| [pi connector reference](pi-connector-reference.mdx) | pi host lifecycle, delivery confirmation, continuation attempts, managed recovery, and event persistence. |

### Concepts

#### Fundamentals

| Page | Covers |
|---|---|
| [Architecture](architecture.mdx) | How the wire contract, broker, connectors, and manager fit together. |
| [Spaces](spaces.mdx) | How spaces isolate collaboration, and how channels, permissions, membership, and conversation ids organize work within them. |
| [Transport vs protocol](transport.mdx) | How Cotal's wire contract uses NATS and JetStream, and what another transport binding would have to preserve. |

#### Messaging

| Page | Covers |
|---|---|
| [Message flow](presence-and-delivery.mdx) | How presence, routing, durable delivery, and attention determine what peers can observe and receive. |
| [The delivery daemon](delivery-daemon.mdx) | Why durable channel delivery needs a trusted service, and what happens without it. |

##### Reference

| Page | Covers |
|---|---|
| [Delivery service contracts](delivery-service-reference.mdx) | Fan-out, trusted reads, leases, membership retirement, credential adoption, and daemon lifetime. |

#### Security

| Page | Covers |
|---|---|
| [Identity](identity-and-auth.mdx) | How Cotal identifies a peer and limits what that peer can do. |
| [Security model](security.mdx) | Threats, guarantees, and limits for peers sharing a trusted NATS broker. |

##### Reference

| Page | Covers |
|---|---|
| [Credential authority](identity-authority.mdx) | Credential minting, profile grants, endpoint generations, and capability limits. |
| [User-auth lifecycle](identity-user-auth.mdx) | Actor grants, delegation, catalogs, enrollment, sessions, views, and remote managers. |
| [Auth service integration](identity-service-auth.mdx) | Auth-service listeners, pinned IdP proofs, bridge hooks, and owner derivation. |
| [Host boundaries](security-boundaries.mdx) | Credential lifetimes, metadata exposure, launch authority, and local process risks. |

#### Agent coordination

| Page | Covers |
|---|---|
| [The control surface](control-surface.mdx) | How clients discover commands, address service instances, and follow durable actions. |
| [Workflow runs](workflows.mdx) | How a program coordinates agents, records progress, and continues after interruption. |

##### Reference

| Page | Covers |
|---|---|
| [Endpoint discovery](control-discovery.mdx) | Command contracts, manager instance selection, request outcomes, and service registration. |
| [Manager lifecycle contracts](control-lifecycle.mdx) | Managed identities, static slots, spawn goals, chat sessions, terminal access, and grants. |
| [Workflow operation contracts](workflow-operations.mdx) | Hosted and local run commands, agent requests, admission, inventory, and keyed submission. |
| [Workflow runtime contracts](workflow-runtime.mdx) | Language replay, recovery, wire authority, durable effects, and engine limits. |
| [Workflow effect contracts](workflow-effects.mdx) | Seat ownership, budgets, supervision, decisions, presence, turns, cancellation, and placement. |

### Specification

| Page | Covers |
|---|---|
| [Cotal Wire Specification](../SPEC.md) | The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119 and RFC 8174. |

### Project

| Page | Covers |
|---|---|
| [Roadmap](roadmap.md) | Cotal is pre-1.0. The wire contract (v0.x) may still change under the change process. This page tracks what is deliberately not built yet, and the direction each area is headed. |
| [Publishing a release](release.md) | Cotal uses pnpm, Changesets and one GitHub Actions workflow. The fixed group in .changeset/config.json versions the public packages together. Examples are private. |
| [Substrate stability](stability.md) | Cotal's packages are pre-1.0 and publish in lockstep. Pin the versions you embed and read Upgrading before changing them. A package version, a wire revision and a service's discovered contract revision describe different compatibility boundaries. |
| [Setup internals (maintainer notes)](setup-internals.md) | cotal setup (implementations/cli/src/commands/setup.ts) saves configuration by default: it checks prerequisites, sets up the chosen application and runtimes, and seeds persona files. Start is a separate terminal choice or --start; a script must also pass --detach. The dashboard remains a separately configured web service preset. Every file it writes is announced (→ wrote … via provenance.wrote) on stderr, or on stdout with the error when a stderr write fails. Each announcement is one line: a control character or Unicode line separator in a path, such as a newline in HOME, is printed as a \uXXXX escape. Every run takes the same inputs: destination, application, runtimes, project and space. With a terminal, askInputs asks for each one no flag gave and shows the answers before anything is written; Change asks again with the answers kept and Cancel saves nothing. Without one, or with --yes, --no-input or --json, scriptedInputs takes them from the flags and refuses a missing one, and that refusal (MissingFlags) prints the scripted form without the command help. --destination cloud is refused before anything else with the route a Cloud space takes: cotal login registers it, then --destination self-hosted. runtimeChoices lists pty, the official runtimes with the host tools in OFFICIAL_RUNTIME_TOOLS, and each installed third-party runtime. A script's runtimes are the --runtime names, which runtimeFlags checks before any write: an unknown name or an official one whose tool is not on PATH is refused. |
| [Upgrading a running deployment](UPGRADING.md) | Substrate stability tells you what the version numbers promise. This page is the other half: what to actually do when the deployment already exists, has credentials in it, and cannot simply be recreated. Every release that breaks a running deployment gets a section here, naming what migrates on its own, what does not, and the order to move the pieces in. |

## API reference

| Page | Covers |
|---|---|
| [API reference](overview.mdx) | Find Cotal CLI commands, agent tools, configuration fields, and data models. |
| [Integration interfaces](api-reference.mdx) | Choose Cotal's CLI, endpoint commands, libraries, agent tools, wire protocol, or HTTP interfaces. |

### CLI

| Page | Covers |
|---|---|
| [CLI reference](cli.mdx) | Find command syntax, flags, receipts, and limits for the Cotal CLI. |

#### Workstation

| Page | Covers |
|---|---|
| [CLI usage](cli-usage.mdx) | Command discovery, global flags, structured receipts, and exit codes. |
| [CLI installation](cli-installation.mdx) | Setup, software updates, installed extensions, preferences, completion, and feedback. |
| [CLI spaces](cli-selection.mdx) | Space preparation, registration, target selection, discovery, and infrastructure diagnostics. |

#### Mesh lifecycle

| Page | Covers |
|---|---|
| [CLI startup](cli-startup.mdx) | Local stack startup, controller recovery, authentication modes, and manifest startup. |
| [CLI shutdown](cli-shutdown.mdx) | Stack and service stops, process identity checks, preservation, cleanup, and reset. |
| [CLI backups](cli-backups.mdx) | Offline artifacts, integrity checks, restore recovery, and retained seat checkpoints. |

#### Agents

| Page | Covers |
|---|---|
| [Agent launch reference](cli-agents.mdx) | Launch modes, persona definitions, model catalogs, runtimes, and retained PTY seats. |
| [Agent terminal control](cli-agent-control.mdx) | Managed seat census, terminal attachment, input receipts, and native agent stops. |
| [Agent view reference](cli-agent-views.mdx) | Launch previews, named agent status, and recorded team deployment and removal evidence. |

#### Services

| Page | Covers |
|---|---|
| [Local service reference](cli-services.mdx) | Saved local services, native adapters, daemon compatibility entries, and service readiness limits. |
| [Process supervision](cli-processes.mdx) | Manager compatibility entry, owned direct processes, systemd user units, and service logs. |
| [Manager maintenance](cli-maintenance.mdx) | Guarded issuance-gate repair, retained seat maintenance, and native manager stop impact. |
| [Linear integration](cli-integrations.mdx) | Linear account configuration, native MCP operations, endpoint serving, and service lifecycle. |

#### Communication

| Page | Covers |
|---|---|
| [CLI endpoints](cli-endpoints.mdx) | Presence, local endpoint references, contract authoring, native invocation, and guarded removal. |
| [CLI messaging](cli-messaging.mdx) | One-shot messages, live chat, channel policy, retained history, and pending direct messages. |
| [CLI observation](cli-observation.mdx) | Read-only activity feeds, the operator console, and the dashboard service. |

| Page | Covers |
|---|---|
| [CLI authentication](cli-auth.mdx) | Static credentials, endpoint callers, account sessions, actor grants, and credential diagnosis. |
| [CLI workflow runs](cli-runs.mdx) | Hosted and local workflow runs, recorded state, pause answers, offline checks, and seat turns. |

### Agent tools

| Page | Covers |
|---|---|
| [MCP tool catalog](mcp-tools.mdx) | Arguments, availability, and effects of the Cotal tools exposed to agent sessions. |

### Configuration

| Page | Covers |
|---|---|
| [Agent files](agent-files.mdx) | Fields, lookup rules, and ownership for an agent's persisted identity and persona. |
| [Mesh manifest (cotal.yaml)](manifest.mdx) | Manifest fields, persona overrides, channel grants, and access resolution for one team. |
| [Channel permissions](channels-and-permissions.mdx) | Channel read and post permissions, active subscriptions, delivery classes, membership, and replay. |
| [Configuration](config.mdx) | Config files, preferences, environment variables, and local storage for the Cotal CLI and connectors. |

### Models

| Page | Covers |
|---|---|
| [MeshView](mesh-view.mdx) | The TypeScript observer model used by the terminal console and line stream, with dashboard feature coverage. |
| [The cotal-lang card](lang-card.mdx) | Effect signatures, result shapes, concurrency rules, and common refusals for cotal-lang programs. |
| [Glossary](glossary.mdx) | Definitions of Cotal's identity, messaging, delivery, and operator terms. |

### HTTP contract sources

| Reference | Covers |
|---|---|
| [Auth HTTP](auth-api.mdx) | The complete authority HTTP contract and component schemas. |
| [Dashboard HTTP](dashboard-api.mdx) | The complete dashboard HTTP contract and component schemas. |

## Normative artifacts

- [Workflow language](../spec/cotal-lang.md).
- [Message schema](../spec/cotal.schema.json).

## Design notes

| [Signer isolation](design/signer-isolation.md) | How the account signing seed moves off the manager uid. |
| [Tasks endpoint](design/tasks-endpoint.md) | How a tasks provider joins a space as an ordinary endpoint. |
| [Platform control authority](design/platform-pooled-control-authority.md) | How a platform runs a pooled control manager per account without a human session. |
| [User-auth run start](design/user-auth-run-start.md) | How a logged-in user's `cotal run start` gets admitted on a participant manager under issued authority. |
| [Resume transfer](design/resume-transfer.md) | How a detached `--resume` carries a session to a manager on another host. |

Each runnable example documents itself in its own `examples/*/README.md`.
