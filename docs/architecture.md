# Architecture

> **Concept** (informative) · **For:** anyone who wants to know how Cotal is built, and why · **Normative:** [SPEC](../SPEC.md)

Cotal is built as a thin waist: the normative wire contract (subjects, message schemas,
presence/discovery, delivery semantics, the auth grammar) is the standard
([SPEC](../SPEC.md)), and everything else is a pluggable edge over existing building
blocks. Identity, transport, storage, and discovery compose from proven pieces (NATS,
JetStream, JWT/nkeys) rather than being reinvented. Adapters stay thin and swappable, and
nothing adapter-specific leaks into the core.

## Influences: A2A

Cotal reuses A2A's vocabulary and shapes so it stays interoperable rather than siloed, and
implements them over NATS/JetStream.

**From A2A** come the *data shapes*: `AgentCard` (identity / role / tags / skills),
`Message` / `Part` (text and data), and correlation ids (`contextId`). We do not adopt
A2A's HTTP/JSON-RPC transport, `Task` RPCs, or its request/response server model, none of
which fit lateral pub/sub.

The *addressing model* is Cotal's own: the hierarchical address `space / service / instance`
and three delivery modes, multicast, unicast, anycast
([presence & delivery](presence-and-delivery.md)). **Mentions** are a priority hint on a
multicast, not a routing target. NATS/JetStream is the data plane, adding the durability and
presence a bare pub/sub layer leaves to the app.

Identity is an A2A `AgentCard` whose instance id is shaped to later become a **DID**
(`did:key`) so authenticity can survive an untrusted relay ([roadmap](roadmap.md)).

## One wire, mapped onto NATS

The whole protocol rides four subject kinds, with the sender encoded in the subject
itself, where the server can police it, rather than in a self-asserted payload field
([SPEC §3](../SPEC.md#3-subject-layout)):

| Delivery | Subject |
|---|---|
| multicast | `cotal.<space>.chat.<owner>.<actor>.<channel…>` |
| unicast | `cotal.<space>.inst.<toOwner>.<toActor>.<owner>.<actor>` |
| anycast | `cotal.<space>.svc.<role>.<owner>.<actor>` |
| control | `cotal.<space>.ctl.<service>.<owner>.<actor>` |

The sender is a **principal**, an `owner.actor` pair: the account the agent acts on behalf
of, then the agent's own handle under it ([identity & auth](identity-and-auth.md)). Two
tokens instead of one means the broker can deny cross-owner *and* same-owner cross-actor
forgery in the subject grammar itself.

Behind the subjects, each space gets three **JetStream streams** (chat / DM / task, for
storage, per-reader bookmarks, and history), **KV buckets** for presence and the channel
registry, and the control plane as request/reply. Rather than re-implementing delivery
guarantees, Cotal uses the native NATS mechanisms: streams for at-least-once and late
join, queue groups for anycast load-balancing, KV TTL for liveness ([SPEC §8](../SPEC.md#8-nats--jetstream-binding);
the reasoning: [presence & delivery](presence-and-delivery.md)). Isolation is one NATS
**account per space** ([spaces & channels](spaces.md)); authorization is per-agent JWT
ACLs ([identity & auth](identity-and-auth.md)). Large artifacts are reserved for a
per-space Object Store ([roadmap](roadmap.md)).

Whether any of this *requires* NATS is answered in
[transport vs protocol](transport.md): the contract is transport-agnostic; NATS/JetStream
is the reference binding.

## Package layout: one-way tiers

```
examples ──→ implementations ──→ workspace ──→ core ←(peer)── extensions
                (interoperate at runtime over NATS, not via imports)
```

- **`@cotal-ai/core`**, the protocol: subjects, schemas, the NATS client layer, and the
  extension contracts (`Connector`, `Command`, `Runtime`) with the `Registry` they
  self-register into. Depends on nothing else in the repo.
- **`@cotal-ai/workspace`**, the machine-local operator layer over `~/.cotal`: mesh
  registry, target resolution, auth-path helpers. Not part of the wire standard, so a
  third party can embed core without inheriting workstation plumbing.
- **`extensions/*`**: pluggable adapters (connectors, runtimes). Each **peer-depends** on
  core (binding to the host's single core instance) and self-registers on import; an
  unknown agent type **throws**, no silent fallback.
- **`implementations/*`**, opinionated surfaces over core: the CLI, the manager, the
  delivery daemon, the web dashboard. Implementations never import each other; they meet
  at runtime, in a shared space over NATS. A composition root (the `cotal` binary, or an
  example) wires the pieces it wants.
- **`examples/*`**: use-cases and composition roots, never published
  ([examples](examples.md)). An example only configures and orchestrates; new message
  kinds or subjects go into core, generalized, never into an example.

The published binary also loads **operator-installed extensions**: `cotal ext add
<npm-package>` installs into a cotal-owned prefix, imports once so the package
self-registers, then caches every contributed `kind:name`. Command metadata is cached for
`--help`/completion; running a command or requesting a provider imports its owner lazily and
uses the live object. Version skew or a stranded link fails loudly with instructions to re-add.
The repo's `@cotal-ai/web` dashboard and optional tmux/cmux/Orca runtimes use this mechanism; the
published binary does not hardcode those packages.

Machine-local processes use the same registry. The base CLI contributes broker/control-plane
`local-process` descriptors, while an installed package contributes its own (for example `web`).
That keeps `cotal down <component>` and `cotal status` extensible without teaching the base CLI
package-specific pidfiles. A provider process claims its declared pidfile with exclusive create;
extension removal reserves that same path so startup cannot cross uninstall.

## Connectors: four surfaces, one runtime

Every coding-agent integration exposes the same four surfaces:

| Surface | Carries |
|---|---|
| Outbound, ambient | lifecycle → presence and activity, automatically |
| Outbound, deliberate | the messaging tools (`cotal_send` / `cotal_dm` / `cotal_anycast`) |
| Inbound, pull | `cotal_inbox` |
| Inbound, push | wake-and-inject into the live session |

The shared runtime lives in [`@cotal-ai/connector-core`](../extensions/connector-core):
the mesh agent, the [`cotal_*` tool surface](mcp-tools.md) (defined once in its tool
specs, so it cannot drift across hosts), and the delivery buffer with its attention
policy. Each adapter is a thin client
over it that binds to its host's native mechanism: an installed plugin + MCP server for
[Claude Code](connect-claude.md), an in-process plugin for
[OpenCode](connect-opencode.md) (beta), a Python sidecar for
[Hermes](connect-hermes.md) (alpha).

The endpoint underneath self-heals: when the transport connection dies terminally, a
supervisor rebuilds it (rebuilds are serialized and coalesced), and unacked in-flight
messages redeliver on the rebound durables, so nothing is lost across the gap. A manual
`/reconnect` is the human-invoked counterpart.

## Manager: a supervisor, not an orchestrator

The CLI does not spawn agents itself; a long-lived **manager** owns their lifecycle,
asked over the mesh (it is the control plane's first real consumer). It owns process
lifecycle and config binding (start / stop / restart, binding env and policy) and has
no say in what work the agents do. Agents coordinate laterally; the manager only births
and configures them.

- **Off the message hot path.** Each agent self-connects to the mesh through its own
  connector. The manager owns processes in order to control them, but observes everything
  through presence, so a bring-your-own-terminal agent it never spawned still shows up in
  `ps`.
- **Pluggable runtimes.** Spawning is abstracted behind a `Runtime` contract (like pm2 or
  docker for agent TUIs): **`pty`** ships built-in (the manager owns a pseudo-terminal;
  watch or type via `cotal attach`); **`tmux`**, **`cmux`**, and **`orca`** are extensions
  that put each teammate in its own native terminal surface (explicit opt-ins that throw when the extension
  isn't loaded, never a silent fallback); **byo** is the floor (a human's own terminal,
  tracked via presence); **host** (Agent SDK, true mid-turn interrupt) is the documented
  upgrade path ([roadmap](roadmap.md)).
- **Control schema:** `start {role, name, agent, model?, variant?}` · `models {agent?,
  refresh?}` · `stop {name, graceful?}` · `definePersona {name, persona, model?}` · `ps` ·
  `status` · `attach` · `bind`, request/reply messages any authorized node can send,
  policy-gated ([identity & auth](identity-and-auth.md)).
- **Bounded spawn.** A synchronous gate caps concurrent + in-flight agents and a
  minimum-lifetime floor bounds spawn↔despawn churn, so a capability-holding but
  compromised peer cannot fork-bomb the host.
- **Declared env, not inherited.** Runtimes pass spawned children an explicit allow-list
  (PATH / HOME / locale / TERM + the model key + opted-in shared-server vars, forwarded by
  name), never `process.env`, so the operator's unrelated secrets stop bleeding into every
  agent. This closes env-var bleed; it does not prevent filesystem reads or exfiltration
  of the model key itself.
- **Watching is two channels.** The console/dashboard discovers agents over the **mesh**
  (presence, `ps`) but streams terminal pixels over a **direct attach connection** to the
  PTY owner; high-bandwidth terminal I/O never rides NATS. On attach, the manager replays
  a serialized snapshot of a headless terminal mirror, so a late attach repaints the full
  screen (including alternate-screen TUIs).

The result is that an agent can grow and shape its own team: ask for a teammate
(`cotal_spawn`), mint a persona on the fly (`cotal_persona`), or tear one down
(`cotal_despawn`). Every newcomer joins as a peer, not as a child of whoever requested
it. Destructive space-wide operations (history purge) stay operator-only.

## Observers

A watch surface is a read-only observer: an endpoint that consumes without registering
presence (invisible to peers) while watching everyone else's. All three surfaces
(terminal console, plain stream, web dashboard) derive from that one observer through a
shared render-agnostic model, so no surface re-implements wire semantics. The guide is
[watch a mesh](watch-a-mesh.md); the model is [MeshView](mesh-view.md).

## Names, roles, instances

Three identity layers, in increasing permanence
([SPEC §2](../SPEC.md#2-identity), [§6](../SPEC.md#6-presence-and-discovery)):

- **`name`** is a cosmetic, reusable human handle. Addressing by name is best-effort
  convenience, with deterministic and fail-loud resolution: a unique live name resolves,
  and a collision among live peers throws with the candidate ids rather than silently
  picking one. The manager auto-numbers its own spawns (`reviewer` → `reviewer-2`).
- **`role`** is the addressable service, which makes it the anycast address:
  `svc.reviewer` reaches "whoever is a reviewer", so the label carries routing meaning.
- **The instance id** is the authoritative address: the presence key, the unicast target,
  the credential subject.

**Instance continuity:** the id tracks *context* continuity, not the label. A resumed
session (same context window) keeps its id; presence, thread correlation, and in-flight
DMs stay continuous. A fresh context, even reusing the name, is a **new** instance with a
new id: reusing an id across a discontinuous context would tell peers "same agent, same
memory" when the new session has none. One deliberate exception: OpenCode's `/new` inside
the same managed process keeps the mesh identity and advances only the thread correlation
id: process continuity, not credential reuse.

## Deferred

Sessions/moderator, signed envelopes + DID identity, instant offline, artifact delivery,
auth-callout, and federation are designed for but not built yet; each is tracked, with
its direction, in the [roadmap](roadmap.md).
