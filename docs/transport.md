# Transport bindings and the capability contract

> What in Cotal is the *protocol*, what is the *transport*, and what a transport binding must
> provide. Informative companion to the normative [wire spec](../SPEC.md) and the
> [NATS/JetStream mapping](architecture.md#technical-mapping-nats--jetstream).

Cotal runs on NATS/JetStream today. That is the reference binding, not the definition of the
protocol. This page names the boundary so "transport-agnostic" means something testable. There
is no transport abstraction layer in code yet, because there is no second binding. For now, the
separation lives in the spec.

## The two layers

- **The Cotal protocol** (transport-agnostic) is the wire contract. It includes the message
  shapes ([`types.ts`](../packages/core/src/types.ts), with a generated
  [`cotal.schema.json`](../spec/cotal.schema.json)), the addressing model (`space / service /
  instance`, three delivery modes, and `ctl` request/reply), and the coordination semantics:
  spaces, channels, presence, history/replay, discovery, version/change rules, and
  authenticated directedness. Sender and message class come from the delivering subject, not
  from the payload. **This is the standard.**
- **A transport binding** is an implementation of that contract on a concrete substrate.
  NATS/JetStream is the reference binding; [`subjects.ts`](../packages/core/src/subjects.ts) is
  its NATS encoding.

Cotal's coordination model lives in the protocol layer. The transport is the way a deployment
implements it.

## The transport capability contract

A conforming binding must provide these capabilities, or Cotal has to supply them above the
transport.

| # | Capability | What it means |
|---|---|---|
| 1 | **Addressed routing** | Hierarchical names with wildcards, and the three delivery modes: multicast (publish to one concrete channel, subscribe to a channel or subtree), unicast (one instance), and anycast (one-of-N for a role, load-balanced). Also includes service-addressed control request/reply. Sender **and** delivery-class must be attributable to the delivering subject, not the payload. |
| 2 | **Durable delivery and history** | At-least-once store-and-forward so an offline or mid-turn agent misses nothing: per-instance bookmarks for multicast/unicast, per-role queued work for anycast, explicit ack plus redelivery, duplicate tolerance by message id, and bounded late-join replay. |
| 3 | **Presence and registry state** | A small per-space key/value store: own-key presence writes keyed by instance id, TTL/stale/delete-derived `offline`, and durable channel config. |
| 4 | **Identity** | A stable per-instance id the transport can bind delivery and authenticity to. |
| 5 | **Authorization and isolation** | A per-space boundary: an agent emits only as itself and only to its declared `allowPublish` channels (default-deny), and reads only its own DMs and chat within its `allowSubscribe` ACL; plus cross-space isolation. |

Capabilities 1, 4, and 5 are transport-shaped: routing, identity, and authorization are
properties of the pipe. Capabilities 2 and 3 are state. A live-only pipe does not provide them,
so Cotal would have to add them.

## NATS reference binding

NATS/JetStream satisfies all five capabilities:

| Capability | NATS realization |
|---|---|
| Routing | Subjects `cotal.<space>.{chat\|inst\|svc\|ctl}.<sender|route>.…`; sender encoded in the subject (`parseSubject` is the sole authority); `*`/`>` wildcards; queue groups for anycast; `ctl` request/reply for control. |
| Durability and history | JetStream streams `CHAT_/DM_/TASK_<space>`, per-instance chat/DM durables (`chat_`/`dm_`), per-role task durables (`svc_`), at-least-once ack-on-surface, `Nats-Msg-Id` publish dedup, Direct-Get chat backfill for late join. |
| Presence and registry | KV buckets `cotal_presence_<space>` (TTL/stale/delete-derived liveness) and `cotal_channels_<space>` (durable channel config). |
| Identity | The instance's **nkey public key** = `card.id` = subject sender token = JWT subject = the id token used in per-instance durable names ([`identity.ts`](../packages/core/src/identity.ts)). |
| Authz and isolation | Operator-signed **account per space** plus per-profile JWT ACLs (agent/observer/admin plus the narrow operator-side profiles — supervisor/provisioner/teardown/control-caller/deployer/operator/probe/purger; **no allow-all profile**) built from the shared subject/stream builders ([`provision.ts`](../packages/core/src/provision.ts)). |

Capabilities 2 and 3 are offloaded to JetStream and KV. Cotal does not implement history,
presence, ack/redelivery, or publish dedup itself; it uses the native NATS mechanisms. Handlers
still need to be idempotent: this is durable delivery, not exactly-once processing.

## Binding to another transport

The contract is what a second binding implements against. Routing, identity, and authorization
(1, 4, 5) are properties many transports can provide. Durability and presence (2, 3) are state.
A live-only transport does not have them. On any transport without native store-and-forward and
a presence/registry store, Cotal has to supply those pieces itself. A non-NATS binding is
therefore more than a pipe swap.

## What this means

- The portable part is the protocol layer: types/schema, addressing, delivery/control
  semantics, presence/channel semantics, and change rules.
- Keep NATS as the reference binding and **do not** build a pluggable transport interface in
  code until a second binding has a consumer. The contract above *is* the decoupling for now.
- Any "transport-agnostic" claim must name capabilities 2 and 3 as transport-provided today
  (not Cotal-implemented), so the claim stays checkable.
