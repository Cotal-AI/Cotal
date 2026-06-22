<div align="center">

<!-- TODO(asset): light-mode banner variant via <picture> once one exists -->
![Cotal: connect them all](assets/header.gif)

**The open standard for agent coordination.**

One protocol, any topology: peer-to-peer, supervised, hierarchical, hybrid.

<!-- TODO(asset): CI badge: point at the public typecheck+smoke workflow once it's live -->
[![CI](https://img.shields.io/badge/CI-pending-lightgrey)](https://github.com/Cotal-AI/Cotal/actions)
[![npm](https://img.shields.io/npm/v/@cotal-ai/core?label=%40cotal-ai%2Fcore)](https://www.npmjs.com/package/@cotal-ai/core)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)

</div>

<!-- TODO(asset): hero animation slot. Current favorite: an orchestration tree (controller, sub-agents reporting up) morphing into a shared space where the same agents talk laterally. ~5-15s seamless loop, one focal point. assets/hero.gif -->

## What is Cotal

**Cotal is an open standard for AI agents to work together in one shared space, where
the structure (their topology) is yours to define.** Every agent sees who else is there
and messages anyone directly.

Most agent tools lock that structure in for you: usually a tree, where one controller
hands out work and the workers never talk to each other, or bare one-to-one messaging
with no shared space at all. With Cotal it is configuration: who delegates to whom, or
whether anyone is in charge, is something you set, so the same standard runs a **flat team
of peers**, a **manager with workers**, a **chain of command**, or **any mix**.

Because the standard is open, you extend it the same way: bring your own agents, or
connect anything that speaks the contract. It runs on [NATS and JetStream](https://nats.io),
messaging infrastructure proven in production for years; the reference implementation is
TypeScript.

## How it works

Agents in a space address each other three ways.

<table>
<tr align="center">
<td width="33%"><img src="assets/multicast.webp" width="100%" alt="Multicast: alice posts to the #general channel and every subscriber receives it"></td>
<td width="33%"><img src="assets/unicast.webp" width="100%" alt="Unicast: alice messages bob directly; the message waits in his durable inbox while he is busy and is delivered when he frees up"></td>
<td width="33%"><img src="assets/anycast.webp" width="100%" alt="Anycast: a message addressed to the reviewer role; exactly one free reviewer instance claims it"></td>
</tr>
<tr valign="top">
<td><strong>Multicast: broadcast to a channel.</strong><br>A message on a named channel (<code>#general</code>, <code>#review</code>) reaches everyone subscribed to it. This is how a group stays in sync.</td>
<td><strong>Unicast: message one peer.</strong><br>Addressed to a specific instance and delivered durably: a message to a busy or offline agent waits on the stream until it is read, so nothing is lost.</td>
<td><strong>Anycast: reach any one of a role.</strong><br>Address a <em>service</em> ("whoever is a reviewer") and exactly one available instance picks the work up. Delegation and load-balancing without naming a worker.</td>
</tr>
</table>

Underneath all three: **presence**. Every agent publishes a live state (`idle` /
`waiting` / `working` / `offline`) and its [A2A](https://a2a-protocol.org)
`AgentCard`. Anyone in the space can read the roster and see who is doing what, which
is what makes lateral coordination possible without a central scheduler.

## Why a protocol?

Cotal complements the two protocols already in the agent stack; it doesn't replace
them.

- **[MCP](https://modelcontextprotocol.io)** connects an agent to its tools.
- **[A2A](https://a2a-protocol.org)** connects two agents in a pairwise
  request/response.
- **Cotal** connects *many* agents coordinating live in a shared space: presence,
  channels, durable delivery, and the three addressing modes as one model.

Cotal reuses A2A's data shapes to stay interoperable: identity is an A2A `AgentCard`
(its `role` is the addressable service that anycast resolves to), and wire messages
reuse A2A `Message`/`Part`. It does not adopt A2A's HTTP/JSON-RPC transport, `Task`
RPCs, or request/response server model. Only the shapes carry over. Underneath, NATS +
JetStream has run in production for years. We didn't invent the hard parts.

## Quick start

```bash
# install globally, then run setup
npm install -g cotal-ai cotal

# ...or set up in one command, no install
npx cotal-ai setup --full
```

One command, guided setup. The **first run** checks prerequisites, starts a local mesh
you own (bundled `nats-server`, or your own on PATH), lets you pick connectors (Claude
installs a plugin; Codex/OpenCode auto-wire at spawn), and adds two experts plus your
session: **david** the engineer, **sven** the guide, and **me**, the one you drive. It
then offers a Claude-driven demo with david and sven helping. If a step fails, it hands
you to an interactive Claude with the failure context, then retries.

The mesh is **JWT-authed** by default (sender authenticity + per-agent ACLs, with the
server-side delivery daemon for the durable backstop); pass `cotal setup --open` for a
frictionless open, loopback-only, live-only mesh (no auth, no daemon).

Or start it manually.

Two peers in one shared space, in three steps.

```bash
# 1. start a local mesh (NATS + JetStream, open dev mode)
npx cotal up --open

# 2. join as alice (second terminal)
npx cotal join --space demo --name alice --role coder

# 3. join as bob (third terminal) and watch presence light up in both
npx cotal join --space demo --name bob --role reviewer
```

Bob's terminal greets him with who's already there:

<!-- TODO(asset): VHS terminal GIF. assets/quickstart.tape committed, rendered to assets/quickstart.gif; replace this block with the rendered recording so it can't drift from the real CLI. -->

```
Joined demo as bob/reviewer on #general.
Present: alice ○ idle
```

Alice's terminal prints `→ bob/reviewer joined ○ idle` as he arrives. Type a line in
either terminal and it lands in the other's `#general`. That is the whole primitive.

`npx cotal web --space demo` opens the space in a browser, with the roster, channels,
and live feed:

<p align="center"><img src="assets/dashboard.png" width="860" alt="The Cotal web dashboard: live roster on the left, the all-activity feed in the middle, attention queue on the right"></p>
<p align="center"><sub>Live roster, the all-activity feed, and the attention queue, in the browser.</sub></p>

For the full walkthrough (manager-spawned peers, a real Claude Code agent joining the
mesh), see [`examples/01-lateral-coordination`](examples/01-lateral-coordination).

## What Cotal adds on top of NATS

NATS is the transport; Cotal is the contract on top. Each capability below maps to a
concrete mechanism you can check against the code.

### Identity and access

- **Sender authenticity.** The sender rides the subject
  (`cotal.<space>.inst.<target>.<sender>`), policed by the server against the agent's
  JWT, not self-asserted. Identity claims in the payload are rejected, fail-closed.
- **Per-agent ACLs.** Decentralized JWT auth, account = space and user = agent. The
  `agent`, `observer`, and `admin` profiles are default-deny allow-lists (`manager` is
  privileged and not user-mintable); `cotal mint` writes a creds file.
- **DM confidentiality by construction.** Two leak paths are closed: delivery is
  ACL-gated by subject, and replay is gated because each agent's inbox is a pre-created,
  bind-only consumer it cannot re-create. (DMs are plaintext and ACL-gated, not
  encrypted.)

### Delivery and history

- **Durable, per-reader delivery.** Three JetStream streams per space, with a bookmark
  per reader: busy or offline agents resume where they left off, and a late joiner
  replays history before going live.
- **Three delivery modes, one model.** Multicast, unicast, and anycast are one
  addressing scheme over the same space (subjects `chat.>`, `inst.>`, `svc.>`), not
  three transports.
- **Roles as addressable services.** A role is the anycast address: "send to any
  reviewer" routes through a shared work queue, so specialization lives in the
  addressing.
- **Logging and tracing built in.** Every message rides a durable stream, so the space
  is one replayable log of who said what to whom, in order. `cotal console --plain` tails it live.

### Presence and attention

- **Presence and a live channel registry.** Presence is a per-space NATS KV bucket
  (TTL + heartbeat); channels carry a registry (replay policy, description, instructions)
  watched live over KV.
- **Push, not poll.** On push-capable hosts a peer message wakes an idle agent the
  instant it arrives, so a mesh runs hands-free; pull-only hosts read on their next turn.
- **Attention modes.** Each agent sets what may interrupt it: `open` lets channel
  chatter wake it, `dnd` holds chatter for the next turn, `focus` admits only direct
  messages and assigned work.

### Ecosystem: what runs today

| Package | What it is |
|---|---|
| [`@cotal-ai/core`](packages/core) | Endpoint, subjects, message types, the NATS client layer, and the `Connector`/`Command` contracts. |
| [`@cotal-ai/cli`](implementations/cli) | Mesh CLI: `up`, `join`, `watch`, `console`, `web`, `spawn`, `mint`, `channels`, `history`. |
| [`@cotal-ai/manager`](implementations/manager) | Agent supervisor: spawns and manages nodes via a pluggable runtime (pty / tmux / cmux), with `start`/`stop`/`ps`/`attach`. |
| [`@cotal-ai/connector-core`](extensions/connector-core) | Shared MCP-bridge runtime: the mesh agent and the `cotal_*` tools the adapters are thin clients over. |
| [`@cotal-ai/connector-claude-code`](extensions/connector-claude-code) | [Claude Code](https://claude.com/product/claude-code) adapter: installed plugin + lifecycle hooks. |
| [`@cotal-ai/connector-opencode`](extensions/connector-opencode) | [OpenCode](https://opencode.ai) adapter: native in-process plugin injected via config. |
| [`@cotal-ai/connector-hermes`](extensions/connector-hermes) | Hermes (Nous Research) adapter: connects the Hermes agent to the mesh. |
| [`@cotal-ai/cmux`](extensions/cmux) | cmux integration: a `cmux` runtime and terminal-layout provider for spawning agents into cmux tabs. |

The connectors attach differently but expose the same `cotal_*` tools. Claude Code and
OpenCode both push: a peer message wakes an idle agent the instant it arrives.

## Example: one change across three repos

In [`examples/02-cmux-handoff`](examples/02-cmux-handoff), real Claude Code agents ship
a single feature spanning three repositories. An orchestrator spawns the workers and
fans the tasks out by direct message. When the web agent needs the exact `/tasks`
contract, it asks the API agent directly over the mesh; the orchestrator isn't in that
exchange. Supervision and lateral handoff in the same space: the topology lives in
the example's config, never in Cotal itself.

More scenarios in [`examples/`](examples/).

## Documentation

- [docs/OVERVIEW.md](docs/OVERVIEW.md): what Cotal does and the core primitives.
- [docs/architecture.md](docs/architecture.md): how it's built (subjects, streams,
  auth, and the wire contract).
- [deploy/README.md](deploy/README.md): run containerized agent teams against an
  external broker.

## FAQ

<details>
<summary><strong>Why not just A2A or MCP?</strong></summary>

They solve different layers. MCP connects an agent to its tools; A2A connects two
agents in a pairwise request/response. Neither gives you a live shared space with
presence, channels, durable delivery, and topology-free coordination. That's the gap
Cotal fills. Reusing A2A's `AgentCard` and `Message`/`Part` shapes keeps the two
interoperable.

</details>

<details>
<summary><strong>Is Cotal TypeScript-only?</strong></summary>

The protocol isn't. Cotal is a contract over NATS (subjects, schemas, *and* required
client behaviors like presence, ack-on-surface, and sender authenticity), and the layer
is deliberately thin. TypeScript is the only implementation today; any language with a
NATS client can implement the contract documented in [`docs/`](docs/), and official
clients in other languages are planned.

</details>

<details>
<summary><strong>Why NATS underneath, and does it run distributed?</strong></summary>

JetStream streams give durable delivery to busy or offline agents, per-reader
bookmarks, and late-join history without Cotal reimplementing any of it. And yes: NATS
clustering takes the same subjects, streams, and accounts from one machine to a
distributed cluster unchanged.

</details>

<details>
<summary><strong>Can an agent impersonate another?</strong></summary>

No. The sender rides the NATS subject, which the server polices against the agent's
JWT; a payload claiming a different sender is rejected. DMs are confidential by
construction: a per-identity inbox served by a bind-only durable that agents can't
re-create or re-target.

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
</table>

We're looking for more design partners building multi-agent systems.
[Reach out](#team).

Contributions are welcome: implement the contract in your language, build a connector,
or open an issue.

## Team

<!-- TODO(asset): team photos (assets/team/*.jpg or GitHub avatars) -->

<table>
<tr>
<td align="center"><img src="https://github.com/davidfarah2003.png" width="120" alt="David Farah"><br><strong>David Farah</strong><br><!-- TODO: one-line role --><br><a href="https://x.com/DavidFarahlb"><img src="https://img.shields.io/badge/-@DavidFarahlb-000?logo=x&logoColor=white" alt="@DavidFarahlb on X"></a> <a href="https://www.linkedin.com/in/david-farah-lb/"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?logo=linkedin&logoColor=white" alt="David Farah on LinkedIn"></a></td>
<td align="center"><img src="https://github.com/Lanzelot1.png" width="120" alt="Sven Jonscher"><br><strong>Sven Jonscher</strong><br><!-- TODO: one-line role --><br><a href="https://x.com/svensonj00"><img src="https://img.shields.io/badge/-@svensonj00-000?logo=x&logoColor=white" alt="@svensonj00 on X"></a> <a href="https://www.linkedin.com/in/sven-jonscher-418351247/"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?logo=linkedin&logoColor=white" alt="Sven Jonscher on LinkedIn"></a></td>
</tr>
</table>

Building something on Cotal, or want to? Email <a href="mailto:hello@cotal.ai">hello@cotal.ai</a>. We read everything.

## License

[Apache-2.0](LICENSE) for everything in this repo: the wire protocol, core, every
extension, and the CLI. See [LICENSING.md](LICENSING.md) for the trademark note and the
hosted-server plan.

---

<p align="center">Made with ❤️ by Cotal, in Switzerland and San Francisco.</p>
