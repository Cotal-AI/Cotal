# Roadmap

Cotal is pre-1.0, and the v0.x wire contract can still change under the
[change process](../SPEC.md#11-versioning-and-extensibility). This page lists what is not built
yet and where each area is headed. Nothing here is shipped behavior unless a linked page
says so. The [spec](../SPEC.md) is the shipped contract.

## What ships today

The core runs today. It includes:

- All three delivery modes over JetStream.
- Presence and discovery.
- Channel replay and durable delivery classes.
- JWT identity, with per-agent ACLs on by default.
- A supervising manager with pluggable runtimes.
- Connectors for Claude Code, OpenCode, Codex, Hermes, Jcode, and pi.
- The mesh manifest (`cotal.yaml`).
- The console and web observers.
- Durable Cotal Lang runs.
- Discoverable service contracts.
- Structured CLI output.
- An interactive launch form in the console.
- Approval-based connections for personal Claude Code sessions, on supported user-auth
  deployments.

[Choose a workflow](using-cotal.mdx) links each supported path and its limits.

The stock Linear adapter serves under static auth, and under user auth once a deployment approves
it. A hosted installation still configures its own authority, registration, and caller grants.
Support in the source does not mean that an integration is deployed in a given space.

## Deferred work

A shape that the spec reserves, or that a design proposal describes, is not runtime support.
Each item below says which parts exist and what remains.

### Partly built

- **Auth-callout onboarding.** Shipped for per-user-auth spaces. The auth service mints scoped
  credentials when a client connects, using the data-account signing key, which a running manager
  also holds ([identity & auth](identity-and-auth.mdx)). Remaining: the join-link variant with a
  bootstrap token, for static meshes.
- **Credential revocation and TTL.** User-auth spaces have short bearer tokens, ledger revocation,
  and eviction of live connections. Command and daemon credentials are bounded and renewed in
  every mode. Manager-spawned static agent credentials have a 24-hour TTL that the manager renews.
  Despawn revokes their ledger rows, and the control surface refuses the retired incarnation.
  Credentials minted out of band with `cotal auth mint` also expire after 24 hours by default, and
  `--no-expiry` opts out. Remaining: revoking a static credential at reconnect inside its TTL
  window. Static meshes have no auth callout to do it ([security model](security.mdx)).
- **Artifact delivery.** Large payloads move to a per-space JetStream Object Store, and the message
  carries a reference part. The spec defines the `artifact` part, and setup creates the store.
  Nothing stores or fetches artifact bytes yet ([SPEC §5](../SPEC.md#5-envelopes)).
- **Multi-space brokers.** The trust layer already hosts many spaces on one broker. One operator
  signs one account per space ([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)).
  The broker-wide lifecycle verbs refuse to run on a multi-space root instead of acting on one
  tenant. Remaining: per-space lifecycle, such as creating a new space through `up` and per-space
  teardown and backup, and agents that are present in many spaces at once.

### Not built

Each item describes the planned design. None of it runs yet.

- **Signed envelopes with DID identity.** Today a message is authentic because one trusted broker
  carries it. A signed envelope stays authentic across an untrusted relay or a federation hop, so
  the sender cannot deny it. Instance ids are already shaped to become `did:key` ids
  ([SPEC §11](../SPEC.md#11-versioning-and-extensibility)).
- **Sessions with a moderator.** Managed group membership, where a moderator admits and removes
  members. Today a channel has no presence roster of its own. A `durable` channel's membership
  list decides only backstop delivery, and any agent that the channel's read ACL admits can join
  it ([channels & permissions](channels-and-permissions.mdx#membership-changes)).
- **Instant offline from `$SYS`.** The manager watches disconnect events and marks an agent
  `offline` at once, instead of after the presence heartbeat window. The heartbeat sweep keeps
  running as the fallback.
- **Host mode on the Agent SDK.** Headless sessions with true mid-turn interrupt, which you watch
  through the plain stream instead of a native TUI. The plan includes a documented upgrade path
  from attach mode.
- **Strict metadata containment.** ACLs already limit which chat content an agent reads. Stream
  metadata, such as channel names and per-subject counts, is still visible to agents inside the
  space. Hiding it needs the channel-major stream model
  ([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)).

## Connecting spaces

Federation never merges trust roots. [Spaces & channels](spaces.mdx) describes the path in four
stages:

- **v0: origin-qualified identity.** An additive `name@space` qualifier on the envelope and the
  card makes a remote peer unambiguous. It is cheap, breaks nothing, and every bridge needs it.
- **v1: application-level relay.** A bridge endpoint holds a separate credential from each side and
  forwards one channel both ways. It marks loops, rewrites identities, and needs explicit config
  on both ends. Alternatively, each party's delegates meet in a neutral **rendezvous space**. Both
  forms work in open and auth mode, with no NATS reconfiguration.
- **v2: NATS-native.** Account export and import connect spaces under the same operator. Leaf nodes
  connect spaces across operators. Mirror and source streams copy durable history between spaces
  instead of sharing it.
- **Long-term: an encrypted group as the boundary.** A federated channel becomes an end-to-end
  encrypted group whose membership is a set of keys, in the style of MLS. Relays carry ciphertext
  and need no trust, and identity is self-issued DID. Nothing here is built, and nothing blocks
  it.

## Open questions

- **Inbound buffer defaults.** Should the default inbound policy queue messages, coalesce them, or
  inject them at once?
- **Agent-directed control operations.** The manager lifecycle operations exist. The set an agent
  directs, such as directive, set-role, pause, and resume, is still open.
- **Coordination primitives.** Settled for the endpoint control surface. v0.4 defines goals and a
  decision journal, competitive work pools, and leases and obligations
  ([SPEC §13](../SPEC.md#13-endpoint-control-surface-v04)). Still open: whether a lighter,
  advisory intent record also belongs on the chat plane.
- **Collaboration patterns.** [Manifests](manifest.mdx) declare agents and channel access.
  [Cotal Lang](workflows.mdx) expresses delegation, concurrency, and human checkpoints. Still open:
  a separate declarative notation for arbitrary social relationships between agents.

To follow what lands, watch the [changelog](../SPEC.md#11-versioning-and-extensibility) and the
releases. Propose a change against the spec first, under the
[change process](../SPEC.md#11-versioning-and-extensibility).

## Earlier section links

These links lead to the current guidance for sections renamed in earlier versions.

### Where we are [#where-we-are]

See [What ships today](#what-ships-today).

### Connecting spaces (federation) [#connecting-spaces-federation]

See [Connecting spaces](#connecting-spaces).
