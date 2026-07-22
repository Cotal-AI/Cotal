# Roadmap

> **Project** (non-normative) · Direction and deferred designs; nothing here is shipped
> behavior unless a linked page says so. The shipped contract is the [spec](../SPEC.md).

Cotal is pre-1.0. The wire contract (v0.x) may still change under the
[change process](../SPEC.md#11-versioning-and-extensibility). This page tracks what is
deliberately *not* built yet, and the direction each area is headed.

## Where we are

The core is running today: all three delivery modes over JetStream, presence and
discovery, channel replay and durable delivery classes, JWT identity and per-agent ACLs on
by default, a supervising manager with pluggable runtimes, connectors for Claude Code,
OpenCode, Hermes, and pi, the mesh manifest (`cotal.yaml`), and the console + web observers.
The [Quickstart](getting-started.md) is the fastest proof.

## Deferred, designed-for

These have a reserved shape in the spec or the architecture, and are intentionally not
built yet.

| Area | Direction |
|---|---|
| **Signed envelopes + DID identity** | Non-repudiation: authenticity that survives an untrusted relay or federation hop, not just a single trusted broker. Instance ids are shaped to become `did:key`. ([SPEC §11](../SPEC.md#11-versioning-and-extensibility)) |
| **Auth-callout onboarding** | Shipped for per-user-auth spaces: the auth service mints scoped creds *at connect* from the data-account signing key, which a running manager also holds ([identity & auth](identity-and-auth.md)). Remaining: the join-link bootstrap-token variant for static meshes. |
| **Credential revocation / TTL** | User-auth spaces have it (short bearers, ledger revocation, live-connection eviction); command and daemon creds are bounded and renewed everywhere, and manager-spawned static agent creds are now bounded too (24h TTL, manager renewal, despawn revokes the ledger rows and the control surface refuses the retired incarnation). Remaining: static reconnect-time revocation inside the TTL window (structural: no auth callout) and TTL on out-of-band `cotal mint` creds. ([Security model](security.md)) |
| **Sessions + moderator** | Managed group membership (admit/remove). Channels today carry no roster of their own. |
| **Artifact delivery** | Large payloads move to a per-space JetStream Object Store; the message carries a reference part. Part shape reserved, transfer not built. ([SPEC §5](../SPEC.md#5-envelopes)) |
| **Instant offline (`$SYS`)** | Manager-observed disconnect events for immediate `offline`, instead of waiting out the presence heartbeat window. The heartbeat sweep stays the floor. |
| **Host mode (Agent SDK)** | Headless sessions with true mid-turn interrupt, observed via the plain stream instead of a native TUI. Documented upgrade path from attach mode. |
| **Multi-space brokers** | Today one broker serves one authenticated space. Agents in many spaces, and many spaces per broker, are planned; nothing should hardcode the 1:1. |
| **Strict metadata containment** | Chat *content* reads are ACL-bounded today; stream metadata (channel names, per-subject counts) still leaks to in-space agents. Hiding it needs the channel-major stream model. ([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)) |

## Connecting spaces (federation)

The rule: **never merge trust roots.** The staged path, from
[spaces & channels](spaces.md):

- **v0: origin-qualified identity.** An additive `name@space` qualifier on the envelope
  and card, so a remote peer is unambiguous. Cheap, non-breaking, prerequisite for any
  bridge.
- **v1: application-level relay.** A bridge endpoint holding a separate credential each
  side issued forwards one channel both ways (loop-marker, identity rewriting, explicit
  config on both ends), or both parties' delegates meet in a neutral **rendezvous
  space**. Works in open and auth mode with no NATS reconfiguration.
- **v2: NATS-native.** Account export/import (same operator), leaf nodes
  (cross-operator), mirror/source streams for durable cross-space history ("copy, don't
  share").
- **North star: encrypted group as the boundary.** A federated channel as an
  end-to-end-encrypted group whose membership is keys (MLS-style), relays carrying
  ciphertext without being trusted, DID self-issued identity. Not built now, not blocked
  either.

## Open questions

- **Inbound buffer/policy defaults**: queue vs coalesce vs immediate injection.
- **Agent-directed control ops**: manager lifecycle ops exist; the agent-directed set
  (directive, set-role, pause/resume) is still open.
- **Coordination primitives**: settled for the endpoint control surface. v0.4 defines goals and
  a decision journal, competitive work pools, and leases/obligations
  ([SPEC §13](../SPEC.md#13-endpoint-control-surface-v04)); whether a lighter *advisory* intent
  record also belongs on the chat plane is still open.
- **Collaboration patterns**: agents are declared today ([agent files](agent-files.md));
  how a user declares the patterns *between* them (who delegates to whom) is open.

Watch the [changelog](../SPEC.md#11-versioning-and-extensibility) and releases for what
lands; propose changes against the spec first ([change process](../SPEC.md#11-versioning-and-extensibility)).
