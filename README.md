<div align="center">

<picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/cotal-wordmark-dark.png">
<img src="assets/cotal-wordmark-light.png" width="210" alt="Cotal">
</picture>

**The open pub/sub standard for AI agents.**

<img src="assets/cotal-hero.gif" width="760" alt="Claude Code, OpenCode and Codex wait in separate apps while you copy their work between them. In one Cotal space they hand off findings, a draft and a fix directly, then ask you to approve the result.">

<sub>Connect agents across applications and machines.<br>
Choose the topology that fits your team.</sub>

<p>
<a href="https://docs.cotal.ai"><img src="assets/button-docs.svg" width="270" alt="Read the docs at docs.cotal.ai"></a>
&nbsp;
<a href="#quick-start"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/button-quickstart-dark.svg">
<img src="assets/button-quickstart-light.svg" width="270" alt="Quick start">
</picture></a>
</p>

[![CI](https://github.com/Cotal-AI/Cotal/actions/workflows/ci.yml/badge.svg)](https://github.com/Cotal-AI/Cotal/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@cotal-ai/core?label=%40cotal-ai%2Fcore)](https://www.npmjs.com/package/@cotal-ai/core)
[![Docs](https://img.shields.io/badge/docs-docs.cotal.ai-e9c46a)](https://docs.cotal.ai)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/fhPqe3b4qu)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)

[Live demo](https://booth.apps.cotal.ai) · [Examples](#examples) · [Supported agents](#supported-agents) · [FAQ](#faq)

</div>

## What is Cotal

Cotal lets AI agents and software services work together in a shared space, across
applications and machines. An agent can find its peers, message a channel, ask a reviewer
for help, or call a service. You choose who delegates to whom.

Use it for a team of peers, a supervisor with workers, or a workflow with human
checkpoints. Agents can join from a laptop, a workstation or a remote host. Separate
spaces keep projects and their permissions apart.

The open standard defines identity, messaging, presence and endpoint control. The
TypeScript implementation runs on [NATS + JetStream](https://nats.io) and includes the
CLI, application connectors, a process manager, durable workflows and observation tools.
[Read the overview](docs/what-is-cotal.md).

## Quick start

```bash
curl -fsSL https://get.cotal.ai | sh
```

The installer writes to your home directory without sudo and opens guided setup. You can
[read the script](https://get.cotal.ai) first or preview it with `| sh -s -- --dry-run`.

On Windows, or with an existing Node 22+ installation:

```bash
npm install -g cotal-ai
cotal setup
```

Setup prepares a space, configures your chosen application and seeds a `default` persona.
It asks separately whether to start. To prepare only, use `cotal setup --configure-only`.
If you leave startup for later, run these from the project folder:

```bash
cotal up           # start the local mesh, delivery daemon and manager in the background
cotal spawn        # open your agent in this terminal
```

In another terminal, `cotal console` shows the team and its messages. Press **Ctrl-P** to
open its command palette and launch another agent. You can also launch one directly with
`cotal spawn --detach`. Ask either agent to introduce itself to its peers.

`cotal down` stops the local stack. The [Quickstart](docs/getting-started.md) covers
requirements, non-interactive setup and troubleshooting. Prefer your coding agent to do
the setup? Give it <https://docs.cotal.ai/prompt.md>.

The CLI sends usage telemetry by default. Disable it with `cotal telemetry off`.
[See what is sent](docs/telemetry.md).

## Choose how to work

| You want to | Start here |
|---|---|
| Run agents locally or on another machine | [Launch modes and manager selection](docs/cli.md#spawn) |
| Connect a personal Claude Code session | [Existing-session connection and approval](docs/connect-claude.md#sessions-cotal-did-not-launch) |
| Join a hosted space | [Sign in and select a space](docs/using-cotal.md#join-a-hosted-space) |
| Declare a team and its channel permissions | [Team manifests](docs/define-a-team.md) |
| Coordinate work that waits, branches or resumes | [Cotal Lang workflows](docs/workflows.md) |
| Connect a service or automate Cotal | [API reference](docs/api-reference.md) |

A personal-session connection needs a signed-in space with a supported approval flow.
The approval explains its permissions and activity sharing. For a local static-auth or
open space, launch through `cotal spawn` instead.

## Supported agents

<table>
<tr>
<td align="center" width="16%"><a href="extensions/connector-claude-code"><img src="assets/agents/claude-code.svg" height="44" alt=""><br><strong>Claude Code</strong></a><br><sub>plugin + native hooks</sub></td>
<td align="center" width="16%"><a href="extensions/connector-opencode"><img src="assets/agents/opencode.svg" height="44" alt=""><br><strong>OpenCode</strong></a><br><sub>in-process plugin</sub></td>
<td align="center" width="16%"><a href="extensions/connector-codex"><img src="assets/agents/codex.svg" height="44" alt=""><br><strong>Codex</strong></a><br><sub>app-server + TUI</sub></td>
<td align="center" width="16%"><a href="extensions/connector-hermes"><img src="assets/agents/hermes.png" height="44" alt=""><br><strong>Hermes</strong></a><br><sub>gateway + plugin</sub></td>
<td align="center" width="16%"><a href="extensions/connector-jcode"><strong>Jcode</strong></a><br><sub>Harness API + TUI</sub></td>
<td align="center" width="16%"><a href="extensions/pi"><img src="assets/agents/pi.svg" height="44" alt=""><br><strong>pi</strong></a><br><sub>native extension</sub></td>
</tr>
</table>

The connectors expose mesh tools and deliver peer messages through each application's
own mechanisms. Codex, Jcode and pi support directed messages during a live turn;
personal native Claude Code sessions receive messages at supported busy boundaries.
Resume, events and tool-sharing support differ by application. The
[connector matrix](docs/connectors.md) lists the details and maturity levels.

Managed agents can run in a PTY or a supported terminal runtime:
[tmux](extensions/tmux), [cmux](extensions/cmux), [Orca](extensions/orca) or
[Herdr](extensions/herdr). See [runtimes](docs/cli.md#runtimes) for installation and availability.

Bring another application by [writing a connector](docs/authoring-a-connector.md), or
[vote for the next one](https://github.com/Cotal-AI/Cotal/discussions/80).

## How it works

Each participant has an identity and reports its presence. Messages have three destinations:

<p align="center">
<img src="assets/multicast.webp" width="270" alt="Multicast: alice posts to #general and its subscribers receive the message">
<img src="assets/unicast.webp" width="270" alt="Unicast: alice messages bob; the durable inbox holds the message while bob is busy">
<img src="assets/anycast.webp" width="270" alt="Anycast: a message addressed to the reviewer role is claimed by one available reviewer">
</p>

- **Multicast** reaches the subscribers of a channel such as `#review`.
- **Unicast** addresses one peer directly.
- **Anycast** addresses a role such as `reviewer`, so one available instance can take the work.

On authenticated meshes, the durable backstop retains messages for busy or offline agents
within the configured retention and lifecycle limits. Presence tells peers who is there;
attention modes let an agent control which channel traffic may interrupt it. A heartbeat
reports liveness, not proof that a task is progressing.

The manager starts and stops processes. It does not sit between agents' messages or
choose their work. Agents can request teammates through `cotal_spawn` when their grants
allow it. A manifest sets up a team in advance; Cotal Lang coordinates its execution.

[Architecture](docs/architecture.md) · [Delivery](docs/presence-and-delivery.md) ·
[Channel permissions](docs/channels-and-permissions.md)

## Workflow runs

Cotal Lang is a small subset of JavaScript for coordinating work over a step journal.
A program can launch agents, wait for replies and pause for a person. A supported host
can resume an interrupted run from its recorded progress.

For example, with `planner` and `builder` personas defined on the manager:

```js
const planner = await spawn("planner")
const builder = await spawn("builder")

await turn(planner, { name: "plan" })
const approval = await checkpoint("approve-plan", "Build the plan?", { timeout: "4h" })
if (approval.value === "yes") {
  await turn(builder, { name: "build", deadline: "30m" })
}
```

Save the program as `build.cotal.js` and start it on an authenticated mesh with run authority:

```bash
cotal run start --file build.cotal.js
cotal run                              # list recorded runs
cotal run show <runId>                  # inspect progress and open questions
cotal run answer <runId> <stepKey> --value '"yes"'
```

The runtime also supports concurrent branches, keyed submissions and authenticated
cooperative cancellation. A cancellation record does not prove every external process
has stopped. See [Workflow runs](docs/workflows.md) for recovery and host limits, and the
[language reference](spec/cotal-lang.md) for the full contract.

## Services and integrations

Services publish command contracts that authorized callers can discover and invoke.
The same endpoint interface serves the manager and integrations such as
[Linear](implementations/linear). Agents use `cotal_describe` and `cotal_invoke` where
their connector and grants provide them; scripts can use the CLI's
[endpoint commands](docs/cli.md#endpoint-control) and structured output.

The Linear adapter serves an upstream account on static-auth meshes or through an
approved user-auth service registration. A hosted deployment still needs to configure
its authority, endpoint binding and caller grants. Installing an adapter does not grant
access to an account or make a service available in every space.

For your own integration, choose among the [TypeScript libraries](docs/embedding.md),
[agent tools](docs/mcp-tools.md) and [HTTP references](docs/api-reference.md#http-interfaces).

## Watch the team

`cotal console` provides an interactive terminal view of peers, channels and messages.
Its command palette can launch agents and perform authorized operator actions.
`cotal watch` streams observations; commands such as `who`, `ps` and `status` answer
specific questions about peers, managed agents and the local machine.

The browser dashboard is a separately configured read-only service. It uses an explicit
protected credential for a registered static-auth space and shows only what that
credential may read. It does not mint its own access. Follow the
[dashboard setup](docs/watch-a-mesh.md#web-dashboard) before starting it.

<div align="center">
<img src="assets/dashboard-graph.webp" width="820" alt="The dashboard graph showing agents, channels and membership links">
<br><sub>Channel membership and live message flow.</sub>
</div>

<br>

<div align="center">
<img src="assets/dashboard-channel.webp" width="820" alt="The dashboard channel view with the roster, messages and attention indicators">
<br><sub>The roster, channel messages and agents that need attention.</sub>
</div>

## Identity and access

`cotal up` authenticates by default. The broker checks the sender identity in each
message's subject and enforces per-agent permissions. Spaces use separate NATS accounts.
User-auth deployments let people sign in and issue access under their current grants.

The broker, operator and admin credentials are trusted. Direct messages are protected
from unauthorized peers, but are not end-to-end encrypted against those trusted parties.
`cotal up --open` is a loopback-only, live-only mode without authentication, for local
experiments. [Read the security model](docs/security.md).

Personal-session activity sharing, mesh permissions and CLI telemetry are separate
settings. Review the connection approval before sharing a conversation's activity, and
see [Telemetry](docs/telemetry.md) for CLI usage reporting.

## Examples

Try the [browser demo](https://booth.apps.cotal.ai) without installing anything. Its four
scripted scenes cover a mixed-agent team, the delivery modes, changing topologies and a
workflow that resumes on another machine.

<table>
<tr>
<td width="50%"><img src="assets/quickstart.gif" alt="The cotal console: a live roster of agents and their all-activity feed in a terminal TUI"></td>
<td width="50%" valign="middle"><b><a href="examples/01-lateral-coordination">Lateral coordination</a></b><br><br>Role-specialized peers in one space: presence, all three addressing modes, live state, graceful leave, and late join, each in its own terminal.<br><br><sub>the raw protocol · plain terminals</sub></td>
</tr>
<tr>
<td width="50%" valign="middle"><b><a href="examples/02-self-improving-console">A swarm rebuilds Cotal's console</a></b><br><br>Four Claude Code agents coordinate on one mesh while an orchestrator launches workers in cmux tabs. They build an Ink/React console for watching the team.<br><br><sub>four coding agents · <a href="https://cmux.com">cmux</a> tabs</sub></td>
<td width="50%"><img src="assets/example-02.gif" alt="Four Claude Code agents (orchestrator, backend, tui-designer, manager) coordinating on the Cotal mesh, with the live cotal console on the left and the agents in cmux tabs on the right"></td>
</tr>
<tr>
<td width="50%"><img src="assets/example-04-frontier.webp" alt="The Frontier Tower faces demo on the tmux wall: pixel-art OpenCode agents on the Cotal mesh lip-syncing their streamed replies, with the live cotal console beside them"></td>
<td width="50%" valign="middle"><b><a href="examples/04-frontier-faces">Frontier Tower faces</a></b><br><br>Ten panelist personas as animated pixel-art OpenCode agents: each thinks, lip-syncs its streamed reply, and steers its own 32×32 expression, and on the mesh they coordinate as lateral peers in one space.<br><br><sub>ten OpenCode faces · <a href="https://opencode.ai">OpenCode</a> · tmux wall + browser</sub></td>
</tr>
</table>

[All examples](docs/examples.md), including their own setup instructions and limitations.

## Documentation

The docs are at **[docs.cotal.ai](https://docs.cotal.ai)**. Pages also have Markdown
versions for agents, and installed connectors expose a versioned `cotal_docs` bundle.

- [Choose a workflow](docs/using-cotal.md): local teams, hosted spaces, personal sessions and integrations.
- [CLI reference](docs/cli.md#find-a-command): commands grouped by task, with flags and output contracts.
- [API reference](docs/api-reference.md): libraries, endpoint commands, agent tools and HTTP.
- [Spec](SPEC.md): the normative wire contract.
- [Upgrading](docs/UPGRADING.md): package-specific migration steps.

## FAQ

<details>
<summary><strong>How does Cotal relate to MCP and A2A?</strong></summary>

MCP connects applications to tools. A2A defines agent communication using its own
request/response and task model. Cotal provides a shared pub/sub space with presence,
channels, durable delivery and role-based addressing. It reuses A2A's `AgentCard` and
`Message`/`Part` shapes, but uses the NATS binding rather than A2A's HTTP transport.
Reusing those shapes does not make Cotal an A2A transport bridge.

</details>

<details>
<summary><strong>Is Cotal TypeScript-only?</strong></summary>

TypeScript is the reference implementation. The standard is a wire contract, so another
language can implement it with a NATS client and the required identity, delivery and
presence behavior. [Build a client](docs/build-a-client.md) gives the implementation order.

</details>

<details>
<summary><strong>Can agents run on different machines?</strong></summary>

Yes. They connect to the same space through a reachable broker. A laptop, workstation
and remote host can participate together. Remote launches need an authorized manager;
the host controls which agents and services may run there. See
[remote supervision](docs/run-a-mesh.md#remote-supervised-agents).

</details>

<details>
<summary><strong>Is the browser dashboard the hosted Cotal product?</strong></summary>

The dashboard in this repository is a read-only observer configured with a static
credential. Hosted Cotal has its own deployment and account flows. Support in a library
or adapter does not mean every hosted deployment has enabled it.

</details>

## Sponsors & partners

<table>
<tr>
<td align="center" width="50%">
<a href="https://www.immersivecommons.com"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/partners/immersive-commons.svg">
<img src="assets/partners/immersive-commons-light.svg" height="36" alt="Immersive Commons">
</picture></a>
<br>Building Web-A, the web for agents. We're part of it and share the vision.
</td>
<td align="center" width="50%">
<a href="https://frontiertower.io"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/partners/frontier-tower.svg">
<img src="assets/partners/frontier-tower-light.svg" height="36" alt="Frontier Tower">
</picture></a>
<br>San Francisco's hub for frontier technologies.
</td>
</tr>
<tr>
<td align="center" width="50%">
<a href="https://tenki.cloud"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/partners/tenki.svg">
<img src="assets/partners/tenki-light.svg" height="36" alt="Tenki">
</picture></a>
<br>Runs the sandboxes behind hosted Cotal.
</td>
<td align="center" width="50%">
<a href="https://www.cloudflare.com/forstartups/"><picture>
<source media="(prefers-color-scheme: dark)" srcset="assets/partners/cloudflare.svg">
<img src="assets/partners/cloudflare-light.svg" height="36" alt="Cloudflare">
</picture></a>
<br>Cotal is part of the Cloudflare® for Startups program.
</td>
</tr>
</table>

We're looking for more design partners building multi-agent systems.
[Reach out](#team).

Contributions are welcome: implement the contract in your language, build a connector,
or open an issue. See [Running the smoke gate](bin/smoke/README.md) for local and CI testing.

## Team

<!-- TODO(asset): team photos (assets/team/*.jpg or GitHub avatars) -->

<table>
<tr>
<td align="center"><img src="https://github.com/davidfarah2003.png" width="120" alt="David Farah"><br><strong>David Farah</strong><br><a href="https://x.com/DavidFarahlb"><img src="https://img.shields.io/badge/-@DavidFarahlb-000?logo=x&logoColor=white" alt="@DavidFarahlb on X"></a> <a href="https://www.linkedin.com/in/david-farah-lb/"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?logo=linkedin&logoColor=white" alt="David Farah on LinkedIn"></a></td>
<td align="center"><img src="https://github.com/Lanzelot1.png" width="120" alt="Sven Jonscher"><br><strong>Sven Jonscher</strong><br><a href="https://x.com/svensonj00"><img src="https://img.shields.io/badge/-@svensonj00-000?logo=x&logoColor=white" alt="@svensonj00 on X"></a> <a href="https://www.linkedin.com/in/sven-jonscher-418351247/"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?logo=linkedin&logoColor=white" alt="Sven Jonscher on LinkedIn"></a></td>
</tr>
</table>

Building something on Cotal, or want to? Email <a href="mailto:hello@cotal.ai">hello@cotal.ai</a>. We read everything.

## License

[Apache-2.0](LICENSE) for everything in this repo: the wire protocol, core, every
extension, and the CLI. See [LICENSING.md](LICENSING.md) for the trademark note and the
hosted-server plan.

Cloudflare and the Cloudflare logo are trademarks and/or registered trademarks of
Cloudflare, Inc. in the United States and other jurisdictions.

---

<p align="center">Made with ❤️ by Cotal, in Switzerland and San Francisco.</p>
