# Build a Cotal client

> **Guide** (informative) · **For:** spec implementers · **Normative:** [SPEC](../SPEC.md). Where this guide and the spec disagree, the spec wins.

This page is the reading order for implementing a Cotal client in another language (Go,
Python, Rust, or anything with a NATS client library) against the spec, without
reimplementing the protocol.

## What you are implementing

Cotal is two layers, and a client sits astride both:

- **The transport-agnostic contract** ([SPEC §3](../SPEC.md#3-subject-layout) through
  [§7](../SPEC.md#7-channels)): the subject layout, delivery modes, envelopes, presence, and
  channels. This is the standard; it does not mention NATS.
- **The NATS + JetStream binding** ([SPEC §8](../SPEC.md#8-nats--jetstream-binding) through
  [§10](../SPEC.md#10-connection-and-onboarding)): how those abstractions map onto streams,
  durables, KV, subject-scoped auth, and the join link. It is the only binding defined today.

A client is a **thin layer over a NATS client library**: the library owns the connection,
JetStream, and KV; your code owns subject construction and parsing, envelope validation, the
receive-side authenticity checks, and the presence/channel loops. See
[transport.md](transport.md) for the split and the capabilities a binding must provide.

## Prerequisites

- A **NATS client library with JetStream + KV support** in your language (the official
  `nats.go`, `nats.py`, `async-nats` for Rust, etc.).
- A **local mesh to test against**. From this repo:

  ```bash
  cotal up                                   # broker + auth + control plane on 127.0.0.1:4222
  cotal mint <name> --profile agent          # write an agent creds file to join with
  ```

  `cotal mint <name> --profile <agent|observer|admin>` also takes `--allow-subscribe a,b`
  and `--allow-publish a,b` to scope the read/post ACLs, and `--out <path>`. The creds file
  binds your principal (`owner.actor`, [SPEC §2](../SPEC.md#2-identity)) and your channel
  grants; see
  [identity-and-auth.md](identity-and-auth.md) and [run-a-mesh.md](run-a-mesh.md).

## Build order

Each step names what to build, the section that governs it, and how to watch it work against a
local mesh. The [SPEC §12](../SPEC.md#12-conformance) conformance list is the checklist these
map to.

1. **Identity + connection**: [SPEC §2](../SPEC.md#2-identity),
   [§10](../SPEC.md#10-connection-and-onboarding),
   [§13.12](../SPEC.md#1312-nats--jetstream-binding). Read the server version from the
   **pre-auth INFO** and **fail loud below nats-server 2.12** (the v0.4 control surface relies
   on 2.12 schedule/CAS semantics); treat a repeated pre-auth drop as a possible
   oversized-CONNECT diagnostic, not an infinite retry loop. Then connect with the minted creds
   and adopt the principal bound to the credential; set the inbox prefix to your connection's
   reply inbox (`_INBOX_<connId>`) before any request, pull, or KV watch. *See it:* a wrong or missing cred is refused at connect, so a clean connect
   confirms identity and creds are wired correctly.

2. **Subject construction + parsing**: [SPEC §3](../SPEC.md#3-subject-layout). Build the three
   messaging subject shapes plus the v0.4 endpoint control rails
   ([§13.2](../SPEC.md#132-grammar)), and a parser that locates the sender principal (its two
   adjacent owner + actor tokens) by kind (the sender-position asymmetry). *See it:* run the five subject-parsing vectors in
   [SPEC §12](../SPEC.md#12-conformance) and match every result, including the malformed row.

3. **Envelopes + schema validation**: [SPEC §5](../SPEC.md#5-envelopes). Emit and parse
   `CotalMessage` with exactly one routing field set. *See it:* validate your encoder's output
   against [`spec/cotal.schema.json`](../spec/cotal.schema.json) and the two sample messages in
   [SPEC §12](../SPEC.md#12-conformance).

4. **Presence heartbeat**: [SPEC §6](../SPEC.md#6-presence-and-discovery). Write your own
   presence key on the heartbeat interval and derive peers' `offline` from stale timestamps and
   KV deletes. From v0.4 your AgentCard MUST advertise `protocolVersion: "0.4"`, and in auth mode
   your presence record MUST carry your `lifecycleUid` (§6; advisory for display, since authority
   checks use the trusted lifecycle mapping, not presence); a peer that omits `protocolVersion`
   reads as pre-0.4 and is not addressed on the control-surface rails
   ([SPEC §6](../SPEC.md#6-presence-and-discovery),
   [§13.11](../SPEC.md#1311-the-hard-cut)). *See it:* run [`cotal console`](watch-a-mesh.md) and watch your endpoint appear
   in the roster and go stale when you stop heartbeating.

5. **Multicast + channel join/replay**: [SPEC §7](../SPEC.md#7-channels). Publish to a concrete
   channel; join by subscribing under your read ACL; on join, record the watermark, backfill
   history if replay is on, and mark backfilled messages `historical`. *See it:* post from your
   client and receive it on a reference peer (or `cotal console`); a late join replays with
   `historical=true` and no live/backfill duplicates.

6. **DM + anycast**: [SPEC §8](../SPEC.md#8-nats--jetstream-binding). Bind (do not create) your
   `dm_<owner>-<actor>-<lifecycleUid>` and, if you hold a role, `svc_<role>` durable, and ack consumed copies. *See it:*
   a reference peer unicasts to you and anycasts to your role; exactly one anycast consumer wins.

7. **Receive-side checks**: [SPEC §4](../SPEC.md#4-delivery-modes),
   [§5](../SPEC.md#5-envelopes), [§8](../SPEC.md#8-nats--jetstream-binding). Reject any message
   whose `from.id` does not match the subject sender; derive the delivery kind
   (channel/dm/anycast) from the subject, not payload fields; ack only after surfacing, and
   terminate the permanent anomalies (`malformed-subject`, `sender-mismatch`, `malformed-json`)
   instead of redelivering them.

8. **Delivery classes + backstop tolerance**: [SPEC §4](../SPEC.md#4-delivery-modes),
   [§7](../SPEC.md#7-channels). Resolve a channel's effective `live`/`durable` class from channel
   config and use one resolution everywhere. On a `durable` channel, tolerate the at-most-once
   `live` gap, catch up from the durable backstop, and deduplicate by `id` across the live,
   backfill, and durable copies. If durable membership can't be established, report *joined live
   with the backstop unestablished*, never *joined durable*. See
   [delivery-daemon.md](delivery-daemon.md) and [presence-and-delivery.md](presence-and-delivery.md).

## Testing conformance

[SPEC §12](../SPEC.md#12-conformance) is the gate: its numbered list is the set of behaviors a
conformant authenticated NATS client implements. Two artifacts there are language-agnostic and
reusable directly:

- The **subject-parsing table** and the **sample multicast/unicast messages**: fixed vectors
  you can assert against.
- [`spec/cotal.schema.json`](../spec/cotal.schema.json) (draft-07): validate every delivery
  message you emit against it.

The end-to-end test is the **§12 interop scenario** run against a **local reference mesh**:
provision a space, connect two clients, exchange multicast/unicast/anycast, and check a late
joiner's replay. The repository's own smoke suite (`packages/core/smoke/`, `bin/smoke/`) is
TypeScript, driven through `tsx` and the reference endpoint; it is the reference
implementation's regression harness, **not** a cross-language conformance runner. So for a
client in another language, the interop scenario against a local `cotal up` mesh (with a
reference agent as the other party; spawn one via [run-a-mesh.md](run-a-mesh.md) or
[define-a-team.md](define-a-team.md)) is the current conformance test.

## What not to build

- **No transport abstraction layer.** There is one binding. Bind straight to your NATS client;
  do not invent a pluggable transport interface. If you ever bind to a non-NATS substrate, the
  capability contract in [transport.md](transport.md) is what you implement against, and you
  supply durability and presence yourself, since a live-only pipe has neither.
- **No orchestrator.** Cotal peers are lateral. A client connects, presents itself, and
  exchanges messages; it does not schedule or supervise other agents. Spawning and supervision
  live in separate tooling (the [manager](run-a-mesh.md), [mcp-tools.md](mcp-tools.md)), not in
  the wire client.

Keep it thin: a NATS client, subject build/parse, envelope validation, the receive-side checks,
and the presence/channel loops. Everything else is the reference implementation's business, not
the protocol's.
