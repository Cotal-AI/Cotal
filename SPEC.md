# Cotal Wire Specification

> **Status:** Draft, v0.3. This document is the normative wire contract. Libraries
> (including the reference TypeScript implementation) are thin clients over it; where a
> client disagrees with this document, this document wins.
>
> **Editors:** Cotal maintainers. **Last updated:** 2026-06-21.
>
> **v0.3 binding revision — channel live delivery.** Channel *live* delivery moves from a single
> mediated JetStream live-tail durable (`chat_<id>`) to native core-NATS subscriptions bounded by
> `sub.allow`, with durability provided by an explicit per-channel `live`/`durable` delivery class
> (§4, §7, §8). Join/leave becomes a direct subscribe/unsubscribe with no privileged mediation,
> and channel membership moves off consumer topology to a privileged-written registry (§7). This
> supersedes the v0.2 single-durable live-tail. The reference implementation migrates additively —
> the legacy durable and the new core-sub path coexist behind `id` dedup until the legacy path is
> removed — but that migration path is not itself normative. The advertised wire `protocolVersion`
> (§6, §11) stays `0.2` until the core-sub behaviour ships; this revision is the normative target the
> migration converges to, and the additive `deliveryClass` field is backward-compatible meanwhile.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY, and OPTIONAL in
this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

Sections 3 to 7 define the transport-agnostic Cotal contract. Sections 8 to 10 define
the NATS + JetStream binding (v0). A conformant deployment implements one binding; the
NATS binding is the only one defined today. External specifications this document relies on
are listed in Appendix C.

---

## 1. Scope and terminology

Cotal is a wire interface for software, especially AI agents, to coordinate in real time
as lateral peers in a shared pub/sub space, not as nodes in an orchestrator tree.

- **Space**: an isolated coordination context. One space is one tenant boundary; messages
  in one space are not visible in another. NATS binding: one space = one account.
- **Instance**: a connected participant, identified by a stable **instance id**. Also called
  an endpoint.
- **Agent node**: an instance whose `kind` is `agent`, versus a plain `endpoint` such as an
  observer, logger, or dashboard.
- **Peer**: any other instance in the same space.
- **Channel**: a named multicast topic within a space, dotted and hierarchical.
- **Service**: an anycast role or control target reached by name.
- **Broker**: the message router for a space. v0 assumes a single trusted broker.
- **Delivery message**: a multicast, unicast, or anycast `CotalMessage`.
- **Control request**: a request/reply command addressed to a service on `ctl`.

---

## 2. Identity

- In the authenticated NATS binding, an instance id is an Ed25519 nkey public key: base32,
  56 chars, prefix `U` (for example `UAQG...`). It is REQUIRED to be stable for the
  lifetime of the connection.
- The same id MUST be used identically as: the `AgentCard.id` (§6), the sender token in
  subjects (§3), the authenticating user subject (§9), and the per-instance durable names
  (§8).
- A client that authenticates with a credential MUST adopt the id bound to that credential;
  if an id is also set explicitly it MUST match, else the client MUST fail before publish.
- Open dev mode MAY use an opaque stable id, but open mode is outside the security claims
  in §9 and is not a conformant authenticated deployment.

Future binding, not v0: portable `did:key` identity plus signed envelopes so authenticity
survives an untrusted relay. See the threat model in [docs/security.md](docs/security.md).

---

## 3. Subject layout

Every wire subject is rooted at `cotal.<space>`. `<space>` and every routing token are
sanitized: any character outside `[A-Za-z0-9_-]` maps to `_`. Sanitization is lossy; tokens
MUST NOT be decoded back into display names.

| Purpose | Subject | Sender position | Delivery |
| --- | --- | --- | --- |
| Multicast | `cotal.<space>.chat.<sender>.<channel...>` | token 3 | §4 multicast |
| Unicast | `cotal.<space>.inst.<target>.<sender>` | token 4 | §4 unicast |
| Anycast | `cotal.<space>.svc.<role>.<sender>` | token 4 | §4 anycast |
| Control | `cotal.<space>.ctl.<service>.<sender>` | token 4 | §5 control |
| Trace | `cotal.<space>.trace.<instance>` | n/a | reserved |
| Control-plane | `cotal.<space>.control.<instance>` | n/a | reserved |

Token indexing is zero-based on `subject.split(".")`: `cotal` = 0, `<space>` = 1,
`<kind>` = 2.

**Sender-position asymmetry.** A reader MUST locate the sender by kind:

- `chat`: sender at token 3; the channel is everything after it, tokens 4+, so it may be
  hierarchical (`team.backend`).
- `inst`, `svc`, `ctl`: sender at token 4; the route target at token 3.

A subject that does not match one of these shapes MUST be treated as having no sender and
MUST NOT be read as a delivery. Reference implementation: `parseSubject` in
`packages/core/src/subjects.ts`.

**Channel tokens.** A channel is dotted; each segment is sanitized. The literal wildcards
`*` and `>` are preserved only as whole segments for subscription and allow-list patterns;
`>` is valid only as the final segment. A publish target MUST be concrete, with no `*` or
`>`; a subscription MAY be wildcard.

**Reserved prefixes.** Application messages MUST NOT use subjects beginning with `$JS.`,
`$KV.`, `$SYS.`, `$OBJ.`, or `_INBOX.`.

---

## 4. Delivery modes

| Mode | Routing field | Semantics |
| --- | --- | --- |
| multicast | `channel` | delivered to every subscriber of the channel |
| unicast | `to` | delivered to the named instance's inbox |
| anycast | `toService` | delivered to one consumer of the named role |

Exactly one of `channel`, `to`, or `toService` MUST be set on a `CotalMessage` (§5).

**Authenticated delivery kind.** A receiver MUST derive "how was this addressed to me"
from the delivering subject kind (`chat` -> `channel`, `inst` -> `dm`, `svc` ->
`anycast`), not from payload routing fields, which are advisory. ("Delivery kind" — the
addressing axis — is distinct from a channel's `live`/`durable` **delivery class**, §7.) A peer can put your id in
payload `to`, but cannot publish on your private unicast subject. Reference:
`MessageMeta.kind`.

**Delivery guarantee — `live` and `durable` classes.** Channel delivery has two classes, fixed
per channel and wire-observable (§7); the guarantee is defined here, its NATS realization is the
binding in §8. A receiver MUST derive its effective class from channel config (§7), not from
per-message metadata (`MessageMeta` need not carry it); it MUST NOT assume one class.

- **`live`** is native broker-subscription delivery and is **at-most-once**: a message reaches
  only the instances subscribed to the channel at publish time. An instance that is disconnected,
  busy, or not yet joined does not receive that message live and has no claim to the live copy
  later. There is no per-subscriber redelivery of the live copy.
- **`durable`** is `live` plus a per-subscriber durable backstop and is **at-least-once for
  current members within retention**: the message is also retained for each member and delivered on
  that member's next connection or turn, remaining pending until acked. A crash or `ack_wait` expiry
  redelivers the durable copy. At-least-once is bounded by the channel's retention / `replayWindow`
  (§7): a message evicted by retention before ack may be lost — the guarantee is not unbounded.

Unicast (`to`) and anycast (`toService`) are at-least-once via their own DM/TASK consumers (§8);
they have no channel membership and are not subject to the per-channel delivery-class mechanism. An
`@mention` (§5) on a `live` channel additionally writes a durable copy to each mentioned target
**authorized to read that channel** (its `allowSubscribe` covers the channel), so an authorized but
offline target still receives it; an `@mention` MUST NOT deliver channel content to a target outside
its read ACL. Durable mention routing resolves each lowercased name to a unique current instance id
from presence at publish time; an ambiguous (multiple live matches) or unresolvable name yields no
durable copy, and authorization is checked against the resolved id's current `allowSubscribe`. A
target authorized for a channel is **mention-reachable** there whether or not it is currently joined — this is intentional (an `@mention` can pull an authorized peer in) and is distinct
from membership; a client SHOULD distinguish "joined" (actively subscribed) from "readable /
mention-reachable" (in `allowSubscribe`) so an unjoined channel is not treated as "cannot reach me
here."

A message delivered both live and durable is **one logical delivery**: receivers MUST deduplicate
by `id` across classes (§8); the durable copy owns ack/commit; and a previously seen `id` MUST NOT
be treated as authorization for a later durable copy (for example one that arrives after a leave).
Receivers MUST tolerate the `live` gap and rely on the `durable` backstop for catch-up on
`durable` channels. Malformed JSON, spoofed sender payloads, and unparseable delivery subjects are
permanent anomalies and MUST be terminated, not retried.

**Ordering.** Cotal does not define global ordering across modes, channels, or consumers.
Implementations MUST NOT depend on cross-subject ordering. Per-consumer delivery is ordered
by the backing stream except where redelivery or explicit backfill interleaves older
messages.

---

## 5. Envelopes

Delivery messages are UTF-8 JSON objects with this shape (`CotalMessage`):

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `id` | string | MUST | unique message id; NATS binding also uses it as `Nats-Msg-Id` |
| `ts` | number | MUST | epoch ms |
| `space` | string | MUST | space name |
| `from` | `EndpointRef` | MUST | `{ id, name, role? }` |
| `channel` | string | one-of | multicast target |
| `to` | string | one-of | unicast target instance id |
| `toService` | string | one-of | anycast target role |
| `mentions` | string[] | MAY | lowercased peer names; wakes the mentioned peer. On a `live` channel it also routes a durable copy to each mentioned target authorized to read that channel (§4); it never delivers content outside the target's read ACL and is not a routing substitute for `channel`/`to` |
| `parts` | `Part[]` | MUST | content |
| `replyTo` | string | MAY | id of the message replied to |
| `contextId` | string | MAY | thread/conversation correlation id |

`Part` is one of the two core shapes, or an extension object whose `kind` is namespaced
as described in §11:

- `{ "kind": "text", "text": string }`
- `{ "kind": "data", "data": <any JSON value> }`
- `{ "kind": "<reverse-DNS extension kind>", ... }`

`EndpointRef` is `{ "id": string, "name": string, "role"?: string }`.

On receive, a client MUST verify `from.id` equals the subject sender (§3). On mismatch, a
missing `from`, or an unparseable delivery subject, the message MUST be rejected and never
redelivered.

Control requests are also UTF-8 JSON:

- `ControlRequest` = `{ "op": string, "args"?: object, "from": EndpointRef }`
- `ControlReply` = `{ "ok": boolean, "data"?: <any JSON value>, "error"?: string }`

A control server MUST verify `ControlRequest.from.id` equals the `ctl` subject sender
before acting. A rejected request SHOULD reply `{ "ok": false, "error": string }`.
Replies use the transport reply subject; they are not Cotal delivery messages.

Receivers MUST ignore unknown object fields. Unknown conformant extension `Part.kind` values
MUST be ignored unless the receiver explicitly supports that extension. Bare unrecognized
core-kind values are not conformant. Messages MUST fit the broker's configured maximum payload.
v0 has no artifact transfer part; large payload transport is reserved for a future Object Store
extension.

**Schema.** The authoritative machine-readable source for the delivery-message type is
[`packages/core/src/types.ts`](packages/core/src/types.ts). A JSON Schema (draft-07) is
generated from `CotalMessage` at [`spec/cotal.schema.json`](spec/cotal.schema.json)
(`pnpm gen:schema`) for validators; it is derived from the source, so the source wins on any
divergence. A conformant delivery message MUST validate against it.

**Rejection reasons.** The three permanent anomalies in §4 are terminated, never redelivered.
These reason tokens are advisory (for logs and `ControlReply.error`); the action is uniform:

| Reason | Trigger |
| --- | --- |
| `malformed-subject` | the delivery subject does not parse (§3) |
| `sender-mismatch` | `from` is missing, or `from.id` does not equal the subject sender (§5) |
| `malformed-json` | the payload is not valid UTF-8 JSON |

---

## 6. Presence and discovery

Presence is a per-space directory keyed by instance id. NATS binding: JetStream KV bucket
`cotal_presence_<space>` (§8).

`Presence`:

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `card` | `AgentCard` | MUST | identity record |
| `status` | `PresenceStatus` | MUST | `idle`, `waiting`, `working`, or `offline` |
| `activity` | string | MAY | freeform current activity |
| `attention` | `AttentionMode` | MAY | global attention mode: `open` \| `dnd` \| `focus`. Advisory observability; `open`/absent ⇒ receives everything. Reset: `open` published on `SessionStart`, removed on the offline sweep |
| `channelModes` | `Record<string, ChannelMode>` | MAY | per-channel attention overrides (`ChannelMode` = `quiet` \| `muted`), keyed by concrete channel name. Advisory — **not** access control (the broker still authorises and delivers); a receive-side preference, reset on restart |
| `ts` | number | MUST | epoch ms of last heartbeat |

`AgentCard`:

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `id` | string | MUST | instance id (§2) |
| `name` | string | MUST | display name |
| `kind` | `agent` or `endpoint` | MUST | participation class |
| `role` | string | MAY | service role |
| `description` | string | MAY | one-line summary |
| `tags` | string[] | MAY | capability tags |
| `skills` | `AgentSkill[]` | MAY | `{ id, name, description? }` |
| `meta` | object | MAY | free-form display metadata; reserved keys include `connector` (host harness name) and `model` (pinned model), both advisory only |
| `protocolVersion` | string | MAY | wire version spoken (§11); `"0.2"` today, omitted means the v0.x line. A change signal, not negotiation |

An instance MUST refresh its own presence entry on the heartbeat interval, default 2000 ms.
The liveness window defaults to 6000 ms. A peer whose `ts` is older than the liveness window
is considered `offline`.

Live clients MUST NOT heartbeat as `offline`. A graceful disconnect MAY publish one final
`offline` presence record. Observers MUST also derive `offline` from stale timestamps and
from KV delete/purge events. Offline peers MAY remain in local rosters for observability.
An instance MUST write only its own presence key, and the key MUST equal `card.id`.

---

## 7. Channels

A channel is addressable as soon as it is published to. Channel config is optional and lives
in the per-space registry bucket `cotal_channels_<space>`, keyed by the concrete channel
token.

`ChannelConfig`:

| Field | Type | Notes |
| --- | --- | --- |
| `replay` | boolean | history replay-on-join; overrides the space default |
| `replayWindow` | string | backfill horizon matching `^\d+(s|m|h|d)$`, e.g. `"24h"` |
| `deliveryClass` | `live` \| `durable` | per-channel delivery class (§4); overrides the space default |
| `description` | string | one-line purpose; max 200 chars |
| `instructions` | string | advisory usage text; max 2000 chars |

Space-wide defaults (`ChannelDefaults`: `replay?`, `replayWindow?`, `deliveryClass?`) live under
the reserved key `=defaults`. Effective replay is `channel.replay ?? defaults.replay ?? true`.
Effective delivery class is `channel.deliveryClass ?? defaults.deliveryClass ?? "durable"`.
`defaults.deliveryClass` MUST be written at space creation from the deployment profile —
local/self-hosted ⇒ `durable` (persistence on by default), public/web-scale ⇒ `live` (durability
opt-in per channel) — so the effective default is always discoverable on the wire, never inferred
from out-of-band context. The same effective config MUST be the single source of truth for live
join, durable fan-out, history read, and membership surfacing; an implementation MUST NOT resolve
the class differently in different paths.

Join subscribes the instance to the channel; leave unsubscribes it. A join target MUST be within
the instance's read ACL (`allowSubscribe`, §9); a join outside it MUST be refused by the broker on
subscribe. A client MUST NOT publish to wildcard channels, but a wildcard read ACL (`team.>`)
authorizes subscribing to any one concrete channel under it **without enumerating channels in
advance**. In the NATS binding, join is a native `sub.allow`-bounded core subscription to the
channel subject and leave is the corresponding unsubscribe; **no privileged mediation is
required** — the broker enforces every subscribe against `sub.allow`, so an instance whose ACL
permits a channel joins and leaves it on its own, with no manager present. Open mode behaves the
same (the client subscribes directly). Leaving the last channel is permitted: under the core-sub
binding an empty subscription set subscribes to nothing (the v0.2 "empty filter subscribes to all"
hazard and its last-channel-leave refusal were artifacts of the multi-filter durable and no longer
apply). On a `durable` channel, join additionally establishes durable membership — a separate
**privileged** step: the instance requests durable membership from the provisioner (a `ctl.<manager>`
durable-join op carrying the channel and its captured join cursor) and the provisioner writes the
membership record. This is decoupled from the live subscribe, so a self-serve live join never depends
on it: a `durable` channel still delivers live with no privileged writer present, and only its
durable backstop requires one. A locally created subscription that the
broker later refuses (the permission violation is asynchronous in the NATS binding) is NOT a
successful join: an instance MUST treat a join as effective only once the broker has accepted the
subscribe, and MUST drop the channel from its joined set on a late refusal (§12). Leave removes the
membership (see membership below).

Replay / catch-up on join:

1. Record the channel join watermark (the CHAT frontier) before the subscription is active, so
   live tail and backfill do not double-deliver.
2. Subscribe to the channel subject (`sub.allow`-bounded; §8). The live copy now flows.
3. If effective replay is on, read retained messages for that channel up to the watermark —
   through a single-channel history read bounded by the current read ACL (`allowSubscribe`, §8),
   optionally limited by `replayWindow`. History is ACL-bounded, not membership-gated: an ACL-holder
   may read a channel's retained content whether or not it is a current member (it could self-join
   and read regardless), so the confidentiality boundary here is the ACL, consistent with the live
   read.
4. Surface backfilled messages with `MessageMeta.historical = true`.
5. Deduplicate by `id` across the live tail, the backfill, and (on `durable` channels) the durable
   backstop, so a message surfaces once.

`replay=false` is noise control, not confidentiality. CHAT history is readable only within an
instance's read ACL (`allowSubscribe`, §9); confidential content MUST use DM or anycast.

Channel membership governs **durable-delivery inclusion** — who receives fan-out copies into their
per-subscriber backstop — and is broker-known, not self-reported. It is NOT a confidentiality
boundary tighter than the read ACL: `allowSubscribe` bounds what content an instance may read (live
and history, §9), and an ACL-holder can self-join, so membership adds delivery semantics, not read
confinement. In the NATS binding, membership is a privileged-written record in the space registry
plane under a key the agent's profile cannot write (NOT the agent's presence key), carrying per-member
join/leave cursors so a publish concurrent with a join or leave orders deterministically; it is NOT
derived from consumer topology, and an agent MUST NOT self-assert its own membership. It is written by
the provisioner in response to a `ctl.<manager>` durable-join request (§8, Appendix B), distinct from
and not required by the self-serve live subscribe. The implementation MUST re-authorize every
**durable-backstop** read of `(instance, channel, message)` against the instance's current read ACL
and membership before surfacing content, so a channel dropped from the ACL or **left** is no longer
surfaced from the backstop — **leave is a hard read boundary for the durable backstop** (it does not
revoke the ACL: an instance may still re-subscribe live, or read ACL-bounded history, within
`allowSubscribe`). Membership remains observability data for liveness/roster purposes and MUST NOT be
used as a send authorization gate.

On a `durable` channel, membership carries the member's **join cursor** — the CHAT frontier captured
at join, the same watermark used to deconflict the live tail and the backfill — and, on leave, a
**leave cursor/tombstone**. The durable backstop is at-least-once (within retention)
for messages whose stream sequence is **> the member's join cursor and ≤ its leave cursor**, where each
cursor is the CHAT frontier (the last sequence) captured at that transition; messages published before a
join or after a leave are not redelivered as durable and are reachable only via an ACL-bounded history
read (within `allowSubscribe`). A rejoin takes a new join cursor, so messages published during the gap are not durably
redelivered. A `durable` join is atomic across its two effects: the instance is durable-joined only
once BOTH the broker-confirmed live subscribe AND the membership write have succeeded, and on a late
subscribe refusal the membership record MUST be removed. If the live subscribe succeeds but durable
membership cannot be established (for example no privileged writer is present), the instance is
**`joined live` with the durable backstop unestablished**: it MUST NOT be reported as `joined durable`,
the live subscription remains active, and the durable shortfall MUST be surfaced as an exceptional
delivery state (e.g. `durable backstop unavailable`), never silently.

---

## 8. NATS + JetStream binding

Backing streams are created once at space setup. `STREAM.CREATE` is denied to agents in auth
mode.

| Stream | Captures | Retention | Required config |
| --- | --- | --- | --- |
| `CHAT_<space>` | `cotal.<space>.chat.>` | Limits | file storage, `max_msgs_per_subject=1000`, `discard=Old`, `allow_direct=true` |
| `DM_<space>` | `cotal.<space>.inst.>` | Limits | file storage, no Direct Get |
| `TASK_<space>` | `cotal.<space>.svc.>` | WorkQueue | file storage, no Direct Get |

Channel **live** delivery is a native core-NATS subscription to `cotal.<space>.chat.*.<channel>`
bounded by `sub.allow` (§9), not a durable consumer; join/leave is the subscribe/unsubscribe and
needs no privileged mediation. The legacy v0.2 `chat_<id>` live-tail durable is removed from this
binding (it MAY coexist transiently during migration behind `id` dedup, but is not part of the
contract).

Durable consumers:

| Durable | Stream | Filter | Policy |
| --- | --- | --- | --- |
| `chathist_<id>` | CHAT | one `cotal.<space>.chat.*.<channel>` per read | transient single-filter consumer for history reads (join-backfill / focus-recall); created per read scoped to one channel in `allowSubscribe`, then deleted; `AckNone`. History is ACL-bounded by the pinned filter, not membership-gated (§7, §9) |
| `dm_<id>` | DM | `cotal.<space>.inst.<id>.*` | provisioner-created in auth mode; bind only; `DeliverPolicy.All`; `AckExplicit`; `ack_wait=60000ms` |
| `svc_<role>` | TASK | `cotal.<space>.svc.<role>.*` | provisioner-created in auth mode; bind only; `AckExplicit`; `ack_wait=60000ms` |

Durable names use sanitized tokens. For authenticated ids this does not change the nkey.

**Durable backstop (§4).** The per-subscriber durable copy is a delivery contract, not a pinned
layout: each member has a private durable store, written on publish for a `durable` channel's current
members — and, for an `@mention` on a `live` channel, for each mentioned target authorized to read that
channel (its `allowSubscribe` covers it), so an authorized but offline target still receives it. The
agent holds **no content-bearing read** on this mixed store. A **trusted reader** (the privileged
provisioner) pulls each pending entry, re-authorizes `(instance, channel, message)` against the
member's **current read ACL** — and, for `durable`-channel fan-out entries, its **membership interval**
(the message's CHAT sequence is `> joinCursor` and `≤ leaveCursor`; §7), not a current-member boolean,
so a pre-leave entry stays deliverable and a post-`leaveCursor` one does not —
and delivers each authorized copy to the member over an **at-least-once** handoff (e.g. its `inbox`,
carrying the same ack semantics — not a fire-and-forget publish). The trusted reader MUST NOT ack or
delete the backstop entry until the member has confirmed the copy was surfaced or handled (or it has
been transferred to an equivalent per-member at-least-once mechanism with the same ack semantics); on a
downstream nak, timeout, or crash before that confirmation, the entry remains pending and redelivers — so
a crash between the inbox publish and the member surfacing the message cannot lose it, and `durable`
stays at-least-once end-to-end, not maybe-once. Content
for a channel dropped from the ACL, or (for a durable channel) left, is never surfaced (at-least-once for
the member within retention; **leave is a hard read boundary for the backstop**); a `live`-channel
`@mention` copy is delivered and `id`-deduped the same way. The read MUST run in this trusted component
the agent cannot bypass, because a self-bound consumer has no server-side per-message ACL/membership
filter. The store's stream/subject layout, the fan-out writer, the trusted reader, and the membership
registry are reference-implementation, not normative; a conformant deployment MAY realize the backstop
differently as long as the §4 guarantee and the §9 checks hold.

Publishers MUST publish channel, unicast, and anycast delivery messages through JetStream and set
the JetStream message id to `CotalMessage.id` (`Nats-Msg-Id` on the wire). A JetStream publish is
an ordinary subject publish that the stream also captures, so the same message reaches core
subscribers live (§4 `live`) and is retained for history and the durable backstop in one publish —
the publish path is unchanged from v0.2; only the live *read* moves to a core subscription.
Ack/nak/term semantics apply to JetStream-consumed copies (history, DM, anycast, and the durable
backstop): receivers MUST ack only after a message has actually been surfaced or handled, MAY nak
transient failures, and MUST term permanently invalid messages. The at-most-once `live` copy is not
acked.

History on join uses the pinned single-filter `chathist_<id>` consumer create above, bounded to
`allowSubscribe`; agents are not granted unfiltered Direct Get. DM and TASK MUST NOT enable Direct Get
because it would bypass the consumer-create deny that is part of the confidentiality boundary.

KV buckets are also streams and are pre-created:

| Bucket | Holds | TTL |
| --- | --- | --- |
| `cotal_presence_<space>` | presence (§6) | 6000 ms |
| `cotal_channels_<space>` | channel registry (§7) | none |
| `cotal_membership_<space>` | derived channel-membership feed (below) | none |

**Derived channel-membership feed (observability).** `cotal_membership_<space>` is a per-agent
(key = `card.id`) derived view of who is subscribed to each channel — the **union** of an agent's
`live` core-subscriptions (read by a privileged daemon from the broker's connection view) and its
`durable` memberships (the members registry), each value `{ live: string[], durable: string[],
observedAt }` with `live` keeping subscription patterns (wildcards) the consumer expands at read time.
It exists so an observer can show silent readers and `live`-channel membership without a broker-admin
credential in the dashboard tier; it is written by a scoped privileged daemon and read by the
admin/observer profile only. It is **DISPLAY-ONLY and broker-derived**: it MUST NOT be an input to any
delivery, ACL, or authorization decision (authority for those stays the broker's `sub.allow` and the
members registry), and it is not part of the normative wire contract a client must implement.

---

## 9. NATS + JetStream security and authorization

**On by default.** A space is provisioned with decentralized JWT auth. Open unauthenticated
dev mode is available but out of scope for the security claims here.

- **Account = space, user = agent.** A space is one NATS account. A per-space operator signs
  the account; an account signing key mints per-agent user JWTs.
- **Profiles are default-deny allow-lists.** Subject, stream, durable, and KV names are built
  from the same builders as §3 and §8. Exact profile shapes are in Appendix B.
- **An agent's channel scope is three concepts**, each a list of channel names or wildcard
  subtrees (`team.>`): `subscribe` — the active read set, the channels it subscribes to at boot
  (now native core subscriptions; mutable at runtime by direct subscribe/unsubscribe with no
  mediation); it MUST be a subset of `allowSubscribe`. `allowSubscribe` — the read **ACL**, the
  channels it MAY read (default = `subscribe`), minted as native `sub.allow` subscribe grants over
  `cotal.<space>.chat.*.<channel>` (wildcards preserved, so an open ACL needs no enumeration) and
  as the matching per-channel history-consumer create grants. `allowPublish` — the post **ACL**,
  the channels it may publish to; **default-deny** (a chat publish grant is minted only for a
  declared channel).

| Profile | Application publish | Read surface | Notes |
| --- | --- | --- | --- |
| `agent` | own `chat.<id>.<ch>` for each `allowPublish` channel (post ACL, default-deny), `inst.*.<id>`, `svc.*.<id>`, `ctl.<manager>.<id>`; own presence key | own `_INBOX_<id>.>`; channel live tail via native `sub.allow` subscriptions to `chat.*.<channel>` per `allowSubscribe` (wildcards preserved); CHAT history via single-filter `chathist_<id>` creates, one per `allowSubscribe` channel (ACL-bounded); own `dm_<id>` and `svc_<role>` bind-only; **no** backstop read grant — durable copies arrive via a trusted reader on `_INBOX_<id>` | read bounded by `allowSubscribe`; durable copies re-checked by the trusted reader (current ACL + membership) before delivery; no Direct Get; DM/TASK/backstop create denied |
| `observer` | none | chat, CHAT history, presence, channel registry | DMs invisible |
| `admin` | none | whole space live tap plus DM history | plaintext god-view, opt-in |
| `manager` | broad | broad | provisioner host; SHOULD be scoped in a future version |

DM and TASK confidentiality, and the CHAT read boundary, close the leak paths:

1. Replies, pull responses, and trusted-reader durable copies (§8) ride a per-identity inbox prefix,
   `_INBOX_<id>.>`, which `sub.allow` permits alongside the agent's channel read grants (next item)
   and nothing else.
2. **Channel live reads are bounded by `sub.allow`.** `allowSubscribe` is minted as native subscribe
   grants over `cotal.<space>.chat.*.<channel>` (wildcards preserved); the broker refuses, per
   subscribe, any channel subject outside the ACL. There is no per-channel consumer name to confine,
   so an open ACL (`team.>`, `>`) grants selective single-channel join with no enumeration and no
   read-breakout. A `>` grant is read-all chat in the space by design — credential compromise reads
   all chat — so it suits trusted/local deployments, not least privilege.
3. A consumer create on the bare/multi-filter subject is not ACL-constrainable, so the provisioner
   pre-creates `dm_<id>`, `svc_<role>`, and the per-subscriber durable backstop. Agents bind
   `dm_<id>`/`svc_<role>` only; the backstop is read by a trusted reader, not the agent (§8, item 5).
   Those bare/multi-filter create forms are not granted to agents (default-deny), with explicit
   create-denies on `DM_<space>`, `TASK_<space>`, and the backstop stream; on `CHAT_<space>` the only
   consumer-create an agent holds is the pinned single-filter history create (next item), so a broad
   CHAT create-deny is intentionally absent — it would also deny that pinned create.
4. CHAT history reads are bounded to `allowSubscribe`: a consumer create on the extended subject
   `$JS.API.CONSUMER.CREATE.<stream>.<name>.<filter>` carries a single filter the server pins to the
   request body, so an agent is granted exactly one such create-subject per `allowSubscribe` channel
   and can read history of no other channel. The unfiltered Direct Get grant is not given to agents.
5. **The durable backstop is read by a trusted reader, not the agent.** The agent holds no
   content-bearing read on the mixed backstop store; a trusted reader (the provisioner) MUST
   re-authorize `(instance, channel, message)` against the member's current read ACL — and, for
   `durable`-channel fan-out entries, its current membership — before delivering content to the member:
   broker ownership of an inbox ("this is agent A's") is not authorization, since the store can hold
   messages for channels A has since dropped from its ACL or left, and a self-bound consumer cannot
   filter per-message on membership. Fan-out-on-write is routing, not an authorization check; for a
   durable channel a `leave` is a hard read boundary on the backstop. History/backfill reads are instead
   self-served and bounded by the current read ACL (the pinned single-filter create above), consistent
   with the live read. An `@mention` durable copy is written only to a target authorized to read the
   channel, so `mentions` cannot carry content outside a target's read ACL.
6. **"Current read ACL" is the effective broker-accepted credential.** An ACL narrowing takes effect
   when the credential/permissions are updated and enforced by the broker (re-mint / reconnect /
   revocation), not as an instantaneous global value; until then an existing broad credential remains
   broad. Both the broker `sub.allow` checks and the trusted-reader re-checks are evaluated against that
   effective credential.

This binding provides containment and authenticity under a single trusted broker: an agent
can emit only as itself and only to its declared `allowPublish` channels, and read only its own
DMs and chat *content* within `allowSubscribe` (and, for `durable` content, its current
membership), enforced by the server. It does not provide
non-repudiation, does not survive an untrusted relay, and DMs are plaintext to the broker and
to `admin`. The read bound is on **content**, not metadata: agents hold `STREAM.INFO` on CHAT
(for the join watermark, the recall drop-marker, and channel-list counts), so a `subjects_filter`
query leaks chat subject *metadata* — channel names, sender ids, and per-subject counts — for
channels outside `allowSubscribe` (channel names are already public via the registry). Hiding
that metadata is deferred strict-containment work. See [docs/security.md](docs/security.md).

---

## 10. Connection and onboarding

Join link grammar:

```text
cotal://[token@]host[:port]/space[?channel=a,b]      plaintext
cotals://[token@]host[:port]/space[?channel=a,b]     TLS required
cotal://user:pass@host/space                         user/password auth
```

- Default port is `4222`.
- `channel` and `channels` query parameters are equivalent comma-separated channel lists.
- Credentials in `userinfo` are parsed out and passed to the NATS client as connect options;
  they are not left inside the server URL.
- Bare `userinfo` with no `:` is a token. `user:pass` is username/password.
- `cotals://` means `nats://host:port` plus TLS-required connect options.
- Credentials (`creds`) are mutually exclusive with token and username/password auth.
- A client MUST set `inboxPrefix` to `_INBOX_<id>` before any request, pull consumer, or KV
  watch operation.

Auth-callout onboarding, where a bootstrap token mints per-agent creds at connect time, is
reserved for a later version. v0 authenticated onboarding is out-of-band credential minting.

---

## 11. Versioning and extensibility

- Wire contract version is v0.2. It is pre-1.0 (the v0.x line) and may still change.
  `AgentCard.protocolVersion` (§6) carries this string.
- v0 has no in-band capability negotiation. Deployments MUST agree on the binding and
  version out of band. A participant MAY advertise the version it speaks via
  `AgentCard.protocolVersion` (§6) as a one-way change signal; v0 defines no behavior on a
  mismatch beyond rejecting messages it cannot parse.
- New message families, subjects, and routing kinds are added in the core contract,
  generalized for all deployments, not in one example.
- Receivers MUST ignore unknown object fields and MUST NOT treat an unknown field as an
  error.
- A future v1 MUST either keep v0 subjects backward-compatible or use an explicit new
  version marker in subjects, credentials, or deployment config.

**Change process.** This document is the change-control point: a change lands here first,
generalized into `core`, and the reference implementation follows. Additive changes (a new
optional field, a new namespaced `Part.kind`, a new subject) are backward-compatible and ship as
a minor bump, since receivers ignore what they do not recognize. Changing the meaning of an
existing field or subject, or removing or renaming one, is breaking: it ships as a major bump
(v1) under a new version marker in subjects, credentials, or deployment config.

**Extension namespacing.** Core `Part.kind` values, `meta` keys, and `tags` are bare and reserved
to this spec (`text`, `data`, and future core additions). A non-core extension MUST namespace its
custom `Part.kind` values and `meta` keys reverse-DNS, under a domain its author controls, e.g.
`{ "kind": "com.acme.snapshot" }` or `meta["com.acme.region"]`; Cotal's own non-core extensions
use `ai.cotal.*`. This keeps third-party names from colliding with each other or with future core
names, with no central registry.

Reserved future work: signed envelopes, `did:key` identity, artifact/object-store parts,
auth-callout bootstrap tokens, manager profile scoping, revocation/TTL for minted creds, and
federated/untrusted relay bindings.

---

## 12. Conformance

A conformant authenticated NATS client MUST:

1. Use one stable authenticated id everywhere (§2).
2. Publish only on subjects whose sender token is its own id (§3).
3. Publish delivery messages as UTF-8 JSON through JetStream with `msgID = id` (§8).
4. Set exactly one routing field on each delivery message (§5).
5. Reject any received delivery message whose `from.id` does not match the subject sender
   (§5).
6. Derive delivery kind (channel/dm/anycast) from the subject, not payload routing fields (§4).
7. Ack only surfaced/handled messages and terminate permanent anomalies (§4, §8).
8. Write only its own presence key on the heartbeat interval (§6).
9. Set the per-instance inbox prefix before transport operations (§10).
10. Treat unknown fields as ignorable (§11).
11. Resolve a channel's effective delivery class (`live`/`durable`) from channel config, not from a
    deployment assumption, and use one resolution across live join, durable fan-out, history read,
    and membership surfacing (§4, §7).
12. On a `durable` channel, tolerate the at-most-once `live` gap and catch up via the durable
    backstop; deduplicate by `id` across the live, backfill, and durable copies (§4, §8).
13. Join and leave a channel's **live** subscription by subscribing/unsubscribing under `sub.allow`
    with no privileged mediation; treat a live join as effective only once the broker accepts the
    subscribe, and drop it on a late permission refusal. On a `durable` channel, additionally establish
    durable membership via the privileged provisioner; if it cannot be established, report `joined live`
    with the durable backstop unestablished, never `joined durable` (§7, §9).
14. Bound history/backfill reads by the current read ACL, and re-authorize every durable-backstop read
    against the current read ACL (and, for `durable`-channel entries, membership) before surfacing
    content, treating a leave as a hard read boundary on the backstop (§7, §9).

Test vectors use these sample ids:

- Alice: `UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD`
- Bob: `UDI36ZKVNUM5WMO4QQ6HDQU7F4OH2RCXOJRX6GAIOS5SKVNNSKCDNLJA`
- Reviewer role: `reviewer`

Subject parsing:

| Subject | Result |
| --- | --- |
| `cotal.main.chat.UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD.team.backend` | `kind=chat`, `sender=UAQ...QCAD`, `rest=team.backend` |
| `cotal.main.inst.UDI36ZKVNUM5WMO4QQ6HDQU7F4OH2RCXOJRX6GAIOS5SKVNNSKCDNLJA.UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD` | `kind=inst`, `sender=UAQ...QCAD`, `rest=UDI...NLJA` |
| `cotal.main.svc.reviewer.UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD` | `kind=svc`, `sender=UAQ...QCAD`, `rest=reviewer` |
| `cotal.main.ctl.manager.UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD` | `kind=ctl`, `sender=UAQ...QCAD`, `rest=manager` |
| `cotal.main.chat.UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD` | no sender; malformed chat subject |

Sample multicast message:

```json
{
  "id": "018f1d0a-0000-7000-9000-000000000001",
  "ts": 1710000000000,
  "space": "main",
  "from": {
    "id": "UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD",
    "name": "alice",
    "role": "planner"
  },
  "channel": "team.backend",
  "mentions": ["bob"],
  "parts": [{ "kind": "text", "text": "Can you review this?" }],
  "contextId": "ctx-1"
}
```

Sample unicast message changes only the routing field:

```json
{
  "id": "018f1d0a-0000-7000-9000-000000000002",
  "ts": 1710000001000,
  "space": "main",
  "from": {
    "id": "UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD",
    "name": "alice"
  },
  "to": "UDI36ZKVNUM5WMO4QQ6HDQU7F4OH2RCXOJRX6GAIOS5SKVNNSKCDNLJA",
  "parts": [{ "kind": "text", "text": "Direct note." }]
}
```

Interop scenario:

1. Provision a space and credentials for Alice and Bob.
2. Alice and Bob connect with inbox prefixes `_INBOX_<id>`.
3. Both write presence and join `team.backend`.
4. Alice multicasts on `team.backend`; Bob receives with `kind=channel`.
5. Alice unicasts to Bob; Bob receives with `kind=dm`.
6. Alice anycasts to `reviewer`; exactly one reviewer receives with `kind=anycast`.
7. A late joiner joins `team.backend`; replayed messages arrive with `historical=true` and
   live-tail duplicates at or below the join watermark are ack-dropped.

---

## Appendix A: Reference implementation map

| Spec section | Source |
| --- | --- |
| §2 Identity | `packages/core/src/identity.ts` |
| §3 Subjects | `packages/core/src/subjects.ts` |
| §5 Envelopes, §6 Presence, §7 Channels | `packages/core/src/types.ts` |
| §8 Streams | `packages/core/src/streams.ts`, `packages/core/src/endpoint.ts` |
| §9 Security | `packages/core/src/provision.ts` |
| §10 Join link | `packages/core/src/link.ts` |

## Appendix B: Profile ACLs

This appendix is normative for the NATS binding. Names below use these placeholders:

- `P = cotal.<space>`
- `CHAT = CHAT_<space>`, `DM = DM_<space>`, `TASK = TASK_<space>`, `BSTOP = INBOX_<space>` (durable backstop stream; reference name, §8)
- `KV = KV_cotal_presence_<space>`
- `CHKV = KV_cotal_channels_<space>`
- `id = authenticated instance id`
- `role = authenticated agent role`
- `chatHistD = chathist_<id>`, `dmD = dm_<id>`, `svcD = svc_<role>` (the per-subscriber durable backstop `chatinbox_<id>` is read by the trusted reader, not the agent, so it has no agent-profile placeholder; §8)
- `inbox = _INBOX_<id>.>`

Grouped placeholders such as `<CHAT|DM|TASK>` mean one concrete subject per listed token.

### Agent

`sub.allow`:

- `inbox`
- `P.chat.*.<ch>` for every `allowSubscribe` channel — the **live read boundary**: native core-sub join/leave is a `sub.allow`-bounded subscribe to this subject, so an agent whose ACL permits a channel joins it alone with no manager. Wildcards preserved (e.g. `P.chat.*.team.>` for `allowSubscribe: team.>`); a `team.>` grant matches strictly deeper channels, not the bare `team`; a `>` grant is read-all chat in the space on credential compromise

`pub.allow`:

- `P.chat.<id>.<ch>` for every `allowPublish` channel (post ACL; none by default)
- `P.inst.*.<id>`
- `P.svc.*.<id>`
- `P.ctl.<manager>.<id>`
- `$JS.API.INFO`
- `$JS.API.STREAM.INFO.<CHAT|DM|TASK|KV|CHKV>`
- `$JS.API.CONSUMER.CREATE.<CHAT>.<chatHistD>.<P.chat.*.<ch>>` for every `allowSubscribe` channel (history reads; the single filter the server pins to the body — the agent's only CHAT consumer create. The live tail is the core `sub.allow` subscription above, not a JetStream consumer)
- `$JS.API.CONSUMER.INFO.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.MSG.NEXT.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.DELETE.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.INFO.<DM>.<dmD>`
- `$JS.API.CONSUMER.MSG.NEXT.<DM>.<dmD>`
- `$JS.ACK.<DM>.<dmD>.>`
- (no durable-backstop read grant: the agent does NOT bind the mixed backstop store; a trusted reader re-checks each entry and delivers authorized durable copies to the agent's `inbox`, §8)
- `$JS.API.CONSUMER.CREATE.<KV>.>`
- `$JS.API.CONSUMER.INFO.<KV>.>`
- `$JS.FC.>`
- `$KV.cotal_presence_<space>.<id>`
- `$JS.API.STREAM.MSG.GET.<CHKV>`
- `$JS.API.CONSUMER.CREATE.<CHKV>.>`
- `$JS.API.CONSUMER.INFO.<CHKV>.>`
- if `role` is set: `$JS.API.CONSUMER.INFO.<TASK>.<svcD>`,
  `$JS.API.CONSUMER.MSG.NEXT.<TASK>.<svcD>`, `$JS.ACK.<TASK>.<svcD>.>`

`pub.deny` (the agent binds these consumers, never creates them; its only consumer-create grant is the pinned per-channel `chatHistD` history create):

- `$JS.API.CONSUMER.CREATE.<DM>`
- `$JS.API.CONSUMER.CREATE.<DM>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<DM>.>`
- `$JS.API.CONSUMER.CREATE.<TASK>`
- `$JS.API.CONSUMER.CREATE.<TASK>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<TASK>.>`
- `$JS.API.CONSUMER.CREATE.<BSTOP>`
- `$JS.API.CONSUMER.CREATE.<BSTOP>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<BSTOP>.>`

A bare/multi-filter consumer create on `CHAT` is **not** explicitly denied — that would also deny the
pinned `chatHistD` create the agent needs — so it is default-denied (the agent holds no such allow),
leaving the single-filter history consumer above as the agent's only CHAT consumer.

### Observer

`sub.allow`:

- `P.chat.>`
- `inbox`

Application publish is denied. `pub.allow` contains only read/control verbs needed to read
CHAT history, presence, and channel registry:

- `$JS.API.INFO`
- `$JS.API.STREAM.INFO.<CHAT|KV|CHKV>`
- `$JS.API.CONSUMER.CREATE.<CHAT>`
- `$JS.API.CONSUMER.CREATE.<CHAT>.>`
- `$JS.API.CONSUMER.INFO.<CHAT>.>`
- `$JS.API.CONSUMER.MSG.NEXT.<CHAT>.>`
- `$JS.API.CONSUMER.DELETE.<CHAT>.>`
- `$JS.ACK.<CHAT>.>`
- `$JS.API.CONSUMER.CREATE.<KV>.>`
- `$JS.API.CONSUMER.INFO.<KV>.>`
- `$JS.API.STREAM.MSG.GET.<CHKV>`
- `$JS.API.CONSUMER.CREATE.<CHKV>.>`
- `$JS.API.CONSUMER.INFO.<CHKV>.>`
- `$JS.API.CONSUMER.DELETE.<CHKV>.>`
- `$JS.FC.>`

### Admin

Admin has observer grants, with `sub.allow = [P.>, inbox]`, plus DM history read grants:

- `$JS.API.STREAM.INFO.<DM>`
- `$JS.API.CONSUMER.CREATE.<DM>`
- `$JS.API.CONSUMER.CREATE.<DM>.>`
- `$JS.API.CONSUMER.INFO.<DM>.>`
- `$JS.API.CONSUMER.MSG.NEXT.<DM>.>`
- `$JS.API.CONSUMER.DELETE.<DM>.>`
- `$JS.ACK.<DM>.>`

Admin still has no application publish grants.

### Manager

Manager is allow-all in v0. It is the provisioner host and is responsible for pre-creating
`dm_<id>`, `svc_<role>`, and per-subscriber durable-backstop (`chatinbox_<id>`) durables, for
writing the privileged channel-membership records the durable backstop authorizes against (§7),
and for minting scoped credentials. The live channel subscribe does not depend on the manager — it
is broker-enforced via `sub.allow` — so self-serve live join works with no manager present; only
the durable backstop and its membership writes require this privileged host. It MUST NOT be issued
to ordinary agents.

## Appendix C: Normative references

| Reference | Used for |
| --- | --- |
| RFC 2119, RFC 8174 | requirement keywords |
| RFC 8259 | UTF-8 JSON envelopes (§5) |
| RFC 4648 | base32 instance-id encoding (§2) |
| RFC 8032 | Ed25519 keypairs behind nkeys (§2) |
| [NATS client protocol](https://docs.nats.io/reference/reference-protocols/nats-protocol) + [JetStream](https://docs.nats.io/nats-concepts/jetstream) | the v0 transport binding (§8) |
| [NATS decentralized JWT auth](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/jwt) + nkeys | identity and authorization (§2, §9) |
