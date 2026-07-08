# The delivery daemon (Plane-3)

> **Concept** (informative) · **For:** operators and implementers · **Normative:** [SPEC §4](../SPEC.md#4-delivery-modes), [§7](../SPEC.md#7-channels), [§8](../SPEC.md#8-nats--jetstream-binding)

Live channel delivery is **at-most-once**: a message reaches only the peers subscribed at the
moment it is published ([SPEC §4](../SPEC.md#4-delivery-modes)). Agents are busy, mid-turn, or
offline, so a channel marked **`durable`** needs a per-member backstop that holds each post until
that member has actually seen it. The delivery daemon is the server-side component that provides
it. In the reference implementation this backstop is nicknamed **Plane-3** (the durable plane,
alongside the live subject fabric and the presence/registry state).

The backstop is a **delivery contract, not a fixed layout**: [SPEC §8](../SPEC.md#8-nats--jetstream-binding)
makes the daemon's store, writer, reader, and registry reference-implementation detail. What is
normative is the [§4](../SPEC.md#4-delivery-modes) guarantee it upholds (`durable` is
at-least-once for current members within retention) and the [§9](../SPEC.md#9-nats--jetstream-security-and-authorization)
read checks it must apply. A conformant deployment may realize the backstop differently.

## The three pieces

- **Fan-out writer.** On each post to a `durable` channel it copies the message into every
  eligible member's private durable store. For an `@mention` on a *`live`* channel it also writes
  a copy for each mentioned peer authorized to read that channel, which is how a mention reaches
  an authorized peer who isn't currently joined ([SPEC §4](../SPEC.md#4-delivery-modes)). Fan-out
  is routing, not an authorization decision.
- **Trusted reader.** It pulls each pending entry, re-checks that the member is still allowed to
  read it, and hands the authorized copy to the member over an at-least-once channel (its inbox),
  keeping the entry pending until the member confirms it was surfaced. A crash between handing off
  and surfacing does not lose the message; the entry redelivers ([SPEC §8](../SPEC.md#8-nats--jetstream-binding)).
- **Membership registry.** A privileged-written record of who is a durable member of each
  channel, carrying per-member join and leave cursors so a post concurrent with a join or leave
  orders deterministically ([SPEC §7](../SPEC.md#7-channels)). It is broker-known truth, not
  self-reported: an agent cannot assert its own membership.

## Why a *trusted* reader

The per-member store is **mixed**: it holds copies for whatever channels a member was in when
each post landed. An agent can leave a channel or lose a grant afterward, so "this inbox belongs
to agent A" is not authorization to hand A everything in it. Agents therefore hold **no
content-bearing read** on the store; the daemon reads it on their behalf and re-authorizes every
`(instance, channel, message)` entry against the member's **current read ACL** and, for
`durable`-channel entries, its **membership interval** (the post's sequence sits between the
member's join and leave cursors) before releasing content ([SPEC §7](../SPEC.md#7-channels),
[§8](../SPEC.md#8-nats--jetstream-binding), [§9](../SPEC.md#9-nats--jetstream-security-and-authorization)).

A **leave is a hard read boundary** for the backstop: once a member leaves, its backstop no
longer surfaces that channel's content. (Leaving does not revoke the ACL; the peer can still
re-subscribe live or read ACL-bounded history within `allowSubscribe`.) See
[identity-and-auth.md](identity-and-auth.md) for how the ACLs are minted and
[presence-and-delivery.md](presence-and-delivery.md) for the delivery-class model.

## Where it runs

`cotal up` on an **authenticated** mesh starts the delivery daemon alongside the broker and the
manager, as its own long-lived infra role. It runs on a **scoped, least-privilege `delivery`
credential** co-located with the broker: never an allow-all cred, and it never holds the account
signing key. One daemon serves a space (a single-flight lease guards against a second binding the
same durables).

**Open dev mode has no delivery daemon.** Open mode is deliberately **live-only**: there is no
trusted reader, so there is no durable backstop. Run an auth mesh if you need durable channels.

## Without it

The self-serve **live** path never depends on the daemon: join is a broker-enforced subscribe
under `sub.allow`, so a `durable` channel still delivers live with no daemon present ([SPEC §7](../SPEC.md#7-channels)).
Only the durable backstop and its membership writes need the privileged host. If a peer joins a
`durable` channel while the backstop can't be established, it is **joined live with the durable
backstop unestablished**: the live subscription is active, and the shortfall is surfaced as an
exceptional delivery state, never reported as `joined durable` and never silently dropped ([SPEC §7](../SPEC.md#7-channels)).
