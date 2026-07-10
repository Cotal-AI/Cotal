# Cotal Wire Specification

> **Status:** Draft, v0.4 (pre-1.0). This document is the normative wire contract. Libraries
> (including the reference TypeScript implementation) are thin clients over it; where a
> client disagrees with this document, this document wins.
>
> **Layered authority.** Message *shapes* are defined by the machine-readable schema,
> [`spec/cotal.schema.json`](spec/cotal.schema.json) (§5); this document's prose defines
> *semantics*: routing, delivery guarantees, presence, authorization, and conformance. For
> the reference implementation's operator surfaces (the CLI, the `cotal_*` tools), see the
> [Reference docs](docs/README.md#reference); those describe the TypeScript implementation,
> not this contract.
>
> **Editors:** Cotal maintainers. **Last updated:** 2026-07-10. Changes are tracked in
> [Appendix D](#appendix-d-change-log); versioning rules are §11.
>
> **v0.3 binding revision: owner+actor identity.** An instance's wire identity moves from a single
> id (the connection nkey, used as the sender token everywhere) to a two-token **principal**
> `(owner, actor)` (§2): the human/account owner and the agent actor become distinct routing tokens,
> so every subject carries the sender as `<owner>.<actor>` (§3), and grants, durables, presence, and
> `from.id` re-key onto the principal (§6, §8, §9). The connection nkey survives only as the transport
> credential, keying the per-connection reply inbox `_INBOX_<connId>` (§2, §10); the wire identity and
> the connection credential are now distinct. Cross-owner **and** same-owner cross-actor forge/read
> isolation is a normative confinement property (§9). `parseSubject` splits the tokens; a well-formed
> split is necessary but not sufficient: a reader additionally rejects a non-principal owner token
> (e.g. an old-shape alias carrying a raw nkey) at the surfacing boundary (§3, §9). The owner-token
> *format* (`u_` + 26 base32-lower) is normative; its *derivation* from an owner's identity (login →
> auth callout, or another identity adapter) is a pluggable edge, not fixed by this contract. This
> supersedes the v0.2/early-v0.3 single-id grammar. As with the live-delivery revision, the advertised
> wire `protocolVersion` (§6, §11) is the migration's normative target, not a claim that every surface
> has cut over.
>
> **v0.4 binding revision: endpoint control surface.** Structured command traffic moves from the v0
> `ctl` control rail to one standardized, typed, discoverable endpoint surface (§13): class +
> instance + scatter rails with per-command broker enforcement, a versioned envelope, three
> delivery contracts (ephemeral / record / journal), normative composites (action, checkpoint,
> guard, capability handle, session), content-addressed contracts with governed traits, and
> lifecycle identity (§13.1) extending §2/§6/§8. This is an intentional **hard cut** (§11,
> §13.11): the v0 control grammar, envelope, and authority tiers are deleted, not dual-served.
> The advertised `protocolVersion` targets `0.4` at the completion of this revision's migration;
> `1.0` remains reserved as a later stability declaration, not part of this revision.
>
> **v0.3 binding revision: channel live delivery.** Channel *live* delivery moves from a single
> mediated JetStream live-tail durable (`chat_<id>`) to native core-NATS subscriptions bounded by
> `sub.allow`, with durability provided by an explicit per-channel `live`/`durable` delivery class
> (§4, §7, §8). Join/leave becomes a direct subscribe/unsubscribe with no privileged mediation,
> and channel membership moves off consumer topology to a privileged-written registry (§7). This
> supersedes the v0.2 single-durable live-tail. The reference implementation migrates additively
> (the legacy durable and the new core-sub path coexist behind `id` dedup until the legacy path is
> removed), but that migration path is not itself normative. The advertised wire `protocolVersion`
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
- **Service**: an anycast role reached by name (`svc`, §4).
- **Endpoint (control surface)**: a daemon that registers a service identity, publishes
  typed contracts, and serves commands on the endpoint rails (§13).
- **Broker**: the message router for a space. v0 assumes a single trusted broker.
- **Delivery message**: a multicast, unicast, or anycast `CotalMessage`.
- **Endpoint request**: a typed request/reply command addressed to an endpoint class or
  instance on the `ep` rails (§13). The v0 `ctl` control rail is deleted (§13.11).

---

## 2. Identity

An instance's wire identity is a **principal** = a pair of routing tokens `(owner, actor)`:

- **`owner`**: the account that owns the instance: the human (or organization) an agent acts on
  behalf of. In an authenticated deployment it is a derived **owner token** (`u_` followed by 26
  base32-lower characters), a namespaced, nkey-disjoint token deterministically derived from the
  owner's stable identity (e.g. an IdP subject) by the deployment's identity adapter; the wire
  contract fixes the token *format*, not the derivation mechanism, which is a pluggable edge. In open
  dev mode the owner is the literal `local`.
- **`actor`**: the instance's own handle within that owner (its agent id). Distinct actors under one
  owner are distinct principals and are confined from one another (§9), so one human's two agents
  cannot forge or read as each other.

Each token is sanitized to `[A-Za-z0-9_]` (see §3) with `-` additionally reserved as the form
separator, so a principal has two unambiguous serializations: the **dot-form** `<owner>.<actor>` and
the **dash-form** `<owner>-<actor>`. The same principal MUST appear identically as: the
`AgentCard.id` (§6, dot-form), the sender tokens in subjects (§3), the message `from.id` (§5,
dot-form), the presence key (§6, dot-form), and the per-instance durable names (§8, dash-form).

**The principal is distinct from the connection credential.** In the authenticated NATS binding the
connecting user is still an Ed25519 nkey (base32, 56 chars, prefix `U`, e.g. `UAQG...`), stable for
the lifetime of the connection, but it is **not** the wire identity. The nkey authenticates the
transport and scopes only the per-connection reply inbox `_INBOX_<connId>.>` (§10); the principal
that keys every subject, grant, and durable is carried by the minted grant, not by the nkey. This
separation is what lets a login (§9) mint a fresh connection whose nkey the client never sees while
the principal stays stable across reconnects.

- A client that authenticates with a static credential MUST adopt the principal that credential's
  grant names; if a principal is also set explicitly (via the card) it MUST match, else the client
  MUST fail before publish.
- A client that authenticates through the auth callout (user mode, §9) cannot know its connection
  nkey before connecting, so it chooses its own reply-inbox nonce (`connId`) and derives its
  principal from its bearer; the broker's minted grant, not the client's self-read, is the
  boundary.
- Open dev mode MAY use `local` as the owner and an opaque stable actor, but open mode is outside
  the security claims in §9 and is not a conformant authenticated deployment.

Future binding, not v0: portable `did:key` identity plus signed envelopes so authenticity
survives an untrusted relay. See the threat model in [docs/security.md](docs/security.md).

---

## 3. Subject layout

Every wire subject is rooted at `cotal.<space>`. `<space>` and every routing token are
sanitized: any character outside `[A-Za-z0-9_-]` maps to `_`. Sanitization is lossy; tokens
MUST NOT be decoded back into display names.

The **sender** of every delivery is a principal (§2), carried as **two adjacent tokens**
`<owner>.<actor>`. Routed kinds (`inst`) also carry the recipient principal as two tokens.

| Purpose | Subject | Sender tokens | Delivery |
| --- | --- | --- | --- |
| Multicast | `cotal.<space>.chat.<owner>.<actor>.<channel...>` | 3–4 | §4 multicast |
| Unicast | `cotal.<space>.inst.<recipOwner>.<recipActor>.<sndOwner>.<sndActor>` | 5–6 | §4 unicast |
| Anycast | `cotal.<space>.svc.<role>.<owner>.<actor>` | 4–5 | §4 anycast |
| Endpoint rails | `cotal.<space>.ep.<call\|all\|inst\|reply>.…`, `cotal.<space>.ep<e\|f\|j\|t\|w\|s>.…` | see §13.2 | §13 control surface |
| Trace | `cotal.<space>.trace.<instance>` | n/a | reserved |

Token indexing is zero-based on `subject.split(".")`: `cotal` = 0, `<space>` = 1,
`<kind>` = 2. The sender principal is recovered as the dot-form `<owner>.<actor>` (= the message
`from.id`, §5), so a guard comparing `from.id` to the subject sender uses one value.

**Two-token sender, and its asymmetry.** A reader MUST locate the sender by kind:

- `chat`: sender owner at token 3, actor at token 4; the channel is everything after, tokens 5+,
  so it may be hierarchical (`team.backend`).
- `svc`: route target at token 3; sender owner at token 4, actor at token 5.
- `ep`: per-mode arities with the caller as the trailing identity tokens; §13.2 defines them.
- `inst`: recipient owner+actor at tokens 3–4; sender owner+actor at tokens 5–6.

The two-token sender is what lets a native publish grant **forge-lock** the sender suffix (e.g.
`inst.*.*.<myOwner>.<myActor>` permits a DM to anyone but only *as me*), so the broker enforces
sender authenticity and a receiver need not re-verify a payload claim. A subject that does not match
one of these shapes (wrong prefix or wrong per-kind arity) MUST be treated as having no sender and
MUST NOT be read as a delivery. `parseSubject` **splits only**: it recovers the tokens but does not
validate that `<owner>` is a well-formed owner token; trust comes from the broker's forge-locked
grant, and a reader that surfaces content additionally rejects a non-principal owner token at the
surfacing boundary (§9). Reference implementation: `parseSubject` in
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
`anycast`), not from payload routing fields, which are advisory. ("Delivery kind", the
addressing axis, is distinct from a channel's `live`/`durable` **delivery class**, §7.) A peer can put your id in
payload `to`, but cannot publish on your private unicast subject. Reference:
`MessageMeta.kind`.

**Delivery guarantee: `live` and `durable` classes.** Channel delivery has two classes, fixed
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
  (§7): a message evicted by retention before ack may be lost; the guarantee is not unbounded.

Unicast (`to`) and anycast (`toService`) are at-least-once via their own DM/TASK consumers (§8);
they have no channel membership and are not subject to the per-channel delivery-class mechanism. An
`@mention` (§5) on a `live` channel additionally writes a durable copy to each mentioned target
**authorized to read that channel** (its `allowSubscribe` covers the channel), so an authorized but
offline target still receives it; an `@mention` MUST NOT deliver channel content to a target outside
its read ACL. Durable mention routing resolves each lowercased name to a unique current instance id
from presence at publish time; an ambiguous (multiple live matches) or unresolvable name yields no
durable copy, and authorization is checked against the resolved id's current `allowSubscribe`. A
target authorized for a channel is **mention-reachable** there whether or not it is currently joined; this is intentional (an `@mention` can pull an authorized peer in) and is distinct
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

Endpoint requests and replies (the control surface) use the versioned typed envelope of
§13.3 (`EndpointRequest`/`EndpointReply`); they are not Cotal delivery messages. The v0
`ControlRequest`/`ControlReply` shapes are deleted (§13.11).

Receivers MUST ignore unknown object fields. Unknown conformant extension `Part.kind` values
MUST be ignored unless the receiver explicitly supports that extension. Bare unrecognized
core-kind values are not conformant. Messages MUST fit the broker's configured maximum payload.
v0 has no artifact transfer part; large payload transport is reserved for a future Object Store
extension.

**Schema.** The JSON Schema (draft-07) at
[`spec/cotal.schema.json`](spec/cotal.schema.json) is **authoritative for message shapes**:
a conformant delivery message MUST validate against it, and where this document's field
tables and the schema diverge on a shape, the schema wins. Delivery *semantics* (routing,
guarantees, rejection) are defined by this document's prose. The schema is generated from
the reference source, [`packages/core/src/types.ts`](packages/core/src/types.ts)
(`pnpm gen:schema`), and committed; the published copy lives at
`https://docs.cotal.ai/cotal.schema.json`.

**Rejection reasons.** The three permanent anomalies in §4 are terminated, never redelivered.
These reason tokens are advisory (for logs and error surfaces); the action is uniform:

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
| `lifecycleUid` | string | MUST in auth mode from v0.4 | the current managed-lifecycle UID (§13.1); distinguishes a live instance from a same-name successor. Advisory for display; authority checks use the trusted lifecycle mapping, not presence |
| `channelModes` | `Record<string, ChannelMode>` | MAY | per-channel attention overrides (`ChannelMode` = `quiet` \| `muted`), keyed by concrete channel name. Advisory, **not** access control (the broker still authorises and delivers); a receive-side preference, reset on restart |
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
`defaults.deliveryClass` MUST be written at space creation from the deployment profile
(local/self-hosted ⇒ `durable`, persistence on by default; public/web-scale ⇒ `live`, durability
opt-in per channel), so the effective default is always discoverable on the wire, never inferred
from out-of-band context. The same effective config MUST be the single source of truth for live
join, durable fan-out, history read, and membership surfacing; an implementation MUST NOT resolve
the class differently in different paths.

Join subscribes the instance to the channel; leave unsubscribes it. A join target MUST be within
the instance's read ACL (`allowSubscribe`, §9); a join outside it MUST be refused by the broker on
subscribe. A client MUST NOT publish to wildcard channels, but a wildcard read ACL (`team.>`)
authorizes subscribing to any one concrete channel under it **without enumerating channels in
advance**. In the NATS binding, join is a native `sub.allow`-bounded core subscription to the
channel subject and leave is the corresponding unsubscribe; **no privileged mediation is
required**: the broker enforces every subscribe against `sub.allow`, so an instance whose ACL
permits a channel joins and leaves it on its own, with no manager present. Open mode behaves the
same (the client subscribes directly). Leaving the last channel is permitted: under the core-sub
binding an empty subscription set subscribes to nothing (the v0.2 "empty filter subscribes to all"
hazard and its last-channel-leave refusal were artifacts of the multi-filter durable and no longer
apply). On a `durable` channel, join additionally establishes durable membership, a separate
**privileged** step: the instance requests durable membership from the server-side delivery daemon (a
durable-join command on the `delivery` endpoint, §13, carrying the channel and its captured join
cursor) and the daemon writes the membership record. This is decoupled from the live subscribe, so a self-serve live join never depends
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
3. If effective replay is on, read retained messages for that channel up to the watermark,
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

Channel membership governs **durable-delivery inclusion** (who receives fan-out copies into their
per-subscriber backstop) and is broker-known, not self-reported. It is NOT a confidentiality
boundary tighter than the read ACL: `allowSubscribe` bounds what content an instance may read (live
and history, §9), and an ACL-holder can self-join, so membership adds delivery semantics, not read
confinement. In the NATS binding, membership is a privileged-written record in the space registry
plane under a key the agent's profile cannot write (NOT the agent's presence key), carrying per-member
join/leave cursors so a publish concurrent with a join or leave orders deterministically; it is NOT
derived from consumer topology, and an agent MUST NOT self-assert its own membership. It is written by
the server-side delivery daemon in response to a durable-join command on the `delivery` endpoint
(§8, §13, Appendix B), distinct from and not required by the self-serve live subscribe. The implementation MUST re-authorize every
**durable-backstop** read of `(instance, channel, message)` against the instance's current read ACL
and membership before surfacing content, so a channel dropped from the ACL or **left** is no longer
surfaced from the backstop: **leave is a hard read boundary for the durable backstop** (it does not
revoke the ACL: an instance may still re-subscribe live, or read ACL-bounded history, within
`allowSubscribe`). Membership remains observability data for liveness/roster purposes and MUST NOT be
used as a send authorization gate.

On a `durable` channel, membership carries the member's **join cursor** (the CHAT frontier captured
at join, the same watermark used to deconflict the live tail and the backfill) and, on leave, a
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

Channel **live** delivery is a native core-NATS subscription to `cotal.<space>.chat.*.*.<channel>`
(wildcard sender owner+actor) bounded by `sub.allow` (§9), not a durable consumer; join/leave is the
subscribe/unsubscribe and needs no privileged mediation. The legacy v0.2 `chat_<owner>-<actor>`
live-tail durable is removed from this binding (it MAY coexist transiently during migration behind
`id` dedup, but is not part of the contract).

Durable consumers. Per-instance durables are keyed on the principal's **dash-form** `<owner>-<actor>`
(a `.` is illegal in a durable name; see §2), so a durable name-scopes to exactly one principal:

| Durable | Stream | Filter | Policy |
| --- | --- | --- | --- |
| `chathist_<owner>-<actor>` | CHAT | one `cotal.<space>.chat.*.*.<channel>` per read | transient single-filter consumer for history reads (join-backfill / focus-recall); created per read scoped to one channel in `allowSubscribe`, then deleted; `AckNone`. History is ACL-bounded by the pinned filter, not membership-gated (§7, §9) |
| `dm_<owner>-<actor>` | DM | `cotal.<space>.inst.<owner>.<actor>.>` | provisioner-created in auth mode; bind only; `DeliverPolicy.All`; `AckExplicit`; `ack_wait=60000ms` |
| `svc_<role>` | TASK | `cotal.<space>.svc.<role>.>` | provisioner-created in auth mode; bind only; `AckExplicit`; `ack_wait=60000ms` |

Per-instance durable names use the principal's dash-form `<owner>-<actor>` (both tokens
fail-loud-validated, not lossily sanitized), so a durable name-scopes to exactly one principal (§2).
The authenticated wire identity is the principal, not the connection nkey. From v0.4, in auth mode,
per-instance durable state is additionally **lifecycle-scoped** (§13.1): durable consumer names,
pending delivery cursors, membership rows, and ACL/ledger rows key on
`(principal, lifecycleUid)` (dash-form `<owner>-<actor>-<lifecycleUid>`), terminal retirement
records per-stream sequence cutoffs before an alias is reused, and a same-name successor
inherits none of its predecessor's pending state (its consumers start at the recorded cutoffs).

**Durable backstop (§4).** The per-subscriber durable copy is a delivery contract, not a pinned
layout: each member has a private durable store, written on publish for a `durable` channel's current
members and, for an `@mention` on a `live` channel, for each mentioned target authorized to read that
channel (its `allowSubscribe` covers it), so an authorized but offline target still receives it. The
agent holds **no content-bearing read** on this mixed store. A **trusted reader** (the server-side
delivery daemon) pulls each pending entry, re-authorizes `(instance, channel, message)` against the
member's **current read ACL** and, for `durable`-channel fan-out entries, its **membership interval**
(the message's CHAT sequence is `> joinCursor` and `≤ leaveCursor`; §7), not a current-member boolean,
so a pre-leave entry stays deliverable and a post-`leaveCursor` one does not,
and delivers each authorized copy to the member over an **at-least-once** handoff (its own
`dlv_<owner>-<actor>` DELIVER consumer, carrying the same ack semantics, not a fire-and-forget publish). The trusted reader MUST NOT ack or
delete the backstop entry until the member has confirmed the copy was surfaced or handled (or it has
been transferred to an equivalent per-member at-least-once mechanism with the same ack semantics); on a
downstream nak, timeout, or crash before that confirmation, the entry remains pending and redelivers, so
a crash between the `dlv` handoff and the member surfacing the message cannot lose it, and `durable`
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
subscribers live (§4 `live`) and is retained for history and the durable backstop in one publish;
the publish path is unchanged from v0.2; only the live *read* moves to a core subscription.
Ack/nak/term semantics apply to JetStream-consumed copies (history, DM, anycast, and the durable
backstop): receivers MUST ack only after a message has actually been surfaced or handled, MAY nak
transient failures, and MUST term permanently invalid messages. The at-most-once `live` copy is not
acked.

History on join uses the pinned single-filter `chathist_<owner>-<actor>` consumer create above, bounded to
`allowSubscribe`; agents are not granted unfiltered Direct Get. DM and TASK MUST NOT enable Direct Get
because it would bypass the consumer-create deny that is part of the confidentiality boundary.

KV buckets are also streams and are pre-created:

| Bucket | Holds | TTL |
| --- | --- | --- |
| `cotal_presence_<space>` | presence (§6) | 6000 ms |
| `cotal_channels_<space>` | channel registry (§7) | none |
| `cotal_membership_<space>` | derived channel-membership feed (below) | none |

**Derived channel-membership feed (observability).** `cotal_membership_<space>` is a per-agent
(key = `card.id`) derived view of who is subscribed to each channel: the **union** of an agent's
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
dev mode is available but out of scope for the security claims here. *(Informative
operator-facing views of this section: [docs/identity-and-auth.md](docs/identity-and-auth.md),
[docs/channels-and-permissions.md](docs/channels-and-permissions.md); the threat model is
[docs/security.md](docs/security.md).)*

- **Account = space, user = agent.** A space is one NATS account. A per-space operator signs
  the account; an account signing key mints per-agent user JWTs.
- **Profiles are default-deny allow-lists.** Subject, stream, durable, and KV names are built
  from the same builders as §3 and §8. Exact profile shapes are in Appendix B.
- **An agent's channel scope is three concepts**, each a list of channel names or wildcard
  subtrees (`team.>`): `subscribe`, the active read set, the channels it subscribes to at boot
  (now native core subscriptions; mutable at runtime by direct subscribe/unsubscribe with no
  mediation); it MUST be a subset of `allowSubscribe`. `allowSubscribe`, the read **ACL**, the
  channels it MAY read (default = `subscribe`), minted as native `sub.allow` subscribe grants over
  `cotal.<space>.chat.*.*.<channel>` (wildcards preserved, so an open ACL needs no enumeration) and
  as the matching per-channel history-consumer create grants. `allowPublish`, the post **ACL**,
  the channels it may publish to; **default-deny** (a chat publish grant is minted only for a
  declared channel).

Every grant below is keyed on the agent's **principal** `<owner>.<actor>` (§2), except the reply
inbox, which is keyed on the **connection** `<connId>`: the connection nkey (static mode) or the
client-chosen nonce (user mode, §9). This is the one place the wire identity and the connection
credential diverge (§2): the principal keys subjects/durables/presence; the connId keys the inbox.

| Profile | Application publish | Read surface | Notes |
| --- | --- | --- | --- |
| `agent` | own `chat.<owner>.<actor>.<ch>` for each `allowPublish` channel (post ACL, default-deny), `inst.*.*.<owner>.<actor>`, `svc.*.<owner>.<actor>`; endpoint request forms per minted capability (`ep.call`/`ep.all`/`ep.inst` with the capability's authz-mode/target pattern, caller triple `<owner>.<actor>.<uid>` pinned; `describe` by default; `epj` submissions for journaled capabilities; §13.9); own presence key | own `_INBOX_<connId>.>` + own endpoint reply rail (`ep.reply.*.….<owner>.<actor>.<uid>.>`); channel live tail via native `sub.allow` subscriptions to `chat.*.*.<channel>` per `allowSubscribe` (wildcards preserved); CHAT history via single-filter `chathist_<owner>-<actor>-<uid>` creates, one per `allowSubscribe` channel (ACL-bounded); own lifecycle-scoped `dm_…`/`svc_…` bind-only; durable backstop via own bind-only lifecycle-scoped `dlv_…` DELIVER consumer, **no** grant on the mixed pre-auth fan-out stream; granted record-key/event-topic read subtrees per capability | read bounded by `allowSubscribe`; durable copies re-authorized (current ACL + membership + lifecycle) by the trusted reader before the `dlv` handoff; no Direct Get; DM/TASK/DLV create denied |
| `observer` | none | chat, CHAT history, presence, channel registry | DMs invisible |
| `admin` | none | whole space live tap plus DM history | plaintext god-view, opt-in |
| scoped host profiles | least-privilege per function | least-privilege per function | The former allow-all `manager` is **deleted**; its host duties split into scoped, single-function creds (`supervisor`, `provisioner`, `delivery`, `membership-rw`, `operator`, `purger`, `teardown`, `channel-writer`, …). No allow-all credential exists. Appendix B summarizes them; concrete grant lists live in `provision.ts` until the host-profile docs increment. |

DM and TASK confidentiality, and the CHAT read boundary, close the leak paths:

1. Replies and pull responses ride a per-connection inbox prefix, `_INBOX_<connId>.>`, which
   `sub.allow` permits alongside the agent's channel read grants (next item) and nothing else. In user
   mode the client picks `<connId>` (a nonce) and the callout scopes the inbox to it, so a
   wildcard-inbox subscribe that would sniff peers' DM deliveries is refused. Re-authorized durable
   copies do NOT ride the inbox; they ride the agent's own `dlv_<owner>-<actor>` DELIVER consumer
   (item 5, §8).
2. **Channel live reads are bounded by `sub.allow`.** `allowSubscribe` is minted as native subscribe
   grants over `cotal.<space>.chat.*.*.<channel>` (wildcards preserved); the broker refuses, per
   subscribe, any channel subject outside the ACL. There is no per-channel consumer name to confine,
   so an open ACL (`team.>`, `>`) grants selective single-channel join with no enumeration and no
   read-breakout. A `>` grant is read-all chat in the space by design (credential compromise reads
   all chat), so it suits trusted/local deployments, not least privilege.
3. A consumer create on the bare/multi-filter subject is not ACL-constrainable, so the provisioner
   pre-creates `dm_<owner>-<actor>`, `svc_<role>`, and the per-member `dlv_<owner>-<actor>` handoff
   durables. Agents bind their own `dm_<owner>-<actor>`/`svc_<role>`/`dlv_<owner>-<actor>` only (never
   create); the mixed pre-auth fan-out store is read by a trusted reader, not the agent (§8, item 5).
   Those bare/multi-filter create forms are not granted to agents (default-deny), with explicit
   create-denies on `DM_<space>`, `TASK_<space>`, and the `DLV` stream; on `CHAT_<space>` the only
   consumer-create an agent holds is the pinned single-filter history create (next item), so a broad
   CHAT create-deny is intentionally absent: it would also deny that pinned create.
4. CHAT history reads are bounded to `allowSubscribe`: a consumer create on the extended subject
   `$JS.API.CONSUMER.CREATE.<stream>.<name>.<filter>` carries a single filter the server pins to the
   request body, so an agent is granted exactly one such create-subject per `allowSubscribe` channel
   and can read history of no other channel. The unfiltered Direct Get grant is not given to agents.
5. **The durable backstop is read by a trusted reader, not the agent.** The agent holds no
   content-bearing read on the mixed pre-auth fan-out store; a trusted reader (the server-side delivery
   daemon) MUST re-authorize `(instance, channel, message)` against the member's current read ACL and,
   for `durable`-channel fan-out entries, its current membership, before handing the authorized
   copy off to the member's own `dlv_<owner>-<actor>` DELIVER consumer:
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
query leaks chat subject *metadata* (channel names, sender ids, and per-subject counts) for
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
- A client MUST set `inboxPrefix` to `_INBOX_<connId>` before any request, pull consumer, or KV
  watch operation, where `<connId>` is the connection identifier (the connection nkey in static
  mode; the client-chosen nonce in user mode, §2/§9), NOT the owner+actor principal, which the
  client may not know pre-connect.

Authenticated onboarding has two bindings. **Out-of-band credential minting** provisions a per-agent
credential ahead of connect (the static path). **Auth-callout onboarding** validates a user bearer at
connect time and mints the scoped data-account JWT then (user mode, §2/§10): the client presents a
deny-all sentinel credential plus its bearer, the callout derives the owner+actor principal and grants,
and re-binds the connection into the data account. The owner-token *derivation* (how a bearer maps to
an owner token) is a pluggable identity adapter (any OIDC/IdP via a thin bridge), not fixed by this
contract; the callout *mechanism* and the resulting grants are. A bearer MAY carry a server-authored
**view** claim, minted only by the deployment's signed-in human exchange (never accepted from the
client or from a managed agent-secret exchange) and re-authorized against the live grant ledger at
every connect: the callout then mints the connection as the named elevated profile (Appendix B:
`admin`, or a scoped host profile such as `purger`, `channel-writer`, `deployer`) instead of `agent`.

---

## 11. Versioning and extensibility

- Wire contract version is v0.2 as advertised today. `AgentCard.protocolVersion` (§6) carries
  this string. The two v0.3 binding revisions (channel live delivery and owner+actor identity,
  see the header) and the **v0.4 endpoint control surface** (§13) are the normative targets the
  reference implementation is converging to. The control surface is an intentional **hard
  cut on the pre-1.0 line** (§13.11): the v0.3 control grammar and envelope are removed from
  this contract, not dual-served — a breaking revision, permitted pre-1.0, shipping under an
  explicit new version marker per this section's rule; the marker is the disjoint endpoint
  subject grammar and versioned envelope. The advertised `protocolVersion` bumps to `0.4` when
  the control-surface migration completes (one campaign, one merge); a version string is not a
  per-surface cutover claim. **`1.0` is deliberately deferred**: it is a stability declaration
  to outside implementers, made separately once the contract has settled (further pre-1.0
  arcs — presence/addressing, multi-space, federation — may still break the wire). **The wire `protocolVersion`
  is the compatibility signal**; dated document snapshots (below) are navigation artifacts, not
  negotiation; an implementation MUST NOT treat a document date as an interop key.
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

**Document snapshots.** Published revisions of this document are dated snapshots
(`YYYY-MM-DD`, the **Last updated** date above): the current revision is canonical, and a
superseded one stays retrievable from the repository history (the git history and tagged
releases of `SPEC.md`), so a client built against it can still be audited. The snapshot
date advances on any normative change; the wire `protocolVersion` moves only per the
change process below.

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

*(An informative build-order walkthrough of this checklist is
[docs/build-a-client.md](docs/build-a-client.md).)*

A conformant authenticated NATS client MUST:

1. Use one stable principal `<owner>.<actor>` as its wire identity everywhere: subject sender
   tokens (§3), `from.id` (§5), presence key (§6), durable names (dash-form, §8); and treat the
   connection credential (nkey) as distinct, keying only its reply inbox (§2).
2. Publish only on subjects whose sender tokens are its own principal `<owner>.<actor>` (§3).
3. Publish delivery messages as UTF-8 JSON through JetStream with `msgID = id` (§8).
4. Set exactly one routing field on each delivery message (§5).
5. Reject any received delivery message whose `from.id` does not match the subject sender, and whose
   subject `<owner>` is not a well-formed principal owner token: a subject that split-parses but
   carries a non-owner in the owner slot (e.g. a raw nkey, an old-shape alias) MUST NOT be surfaced
   as a delivery (§3, §5).
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

Test vectors use these sample principals (`<owner>.<actor>`); `<ownerA>` = `u_aaaaaaaaaaaaaaaaaaaaaaaaaa`,
`<ownerB>` = `u_bbbbbbbbbbbbbbbbbbbbbbbbbb` (owner tokens are `u_` + 26 base32-lower, §2):

- Alice: `<ownerA>.alice`
- Bob: `<ownerB>.bob`
- Reviewer role: `reviewer`

Subject parsing. `parseSubject` **splits only** (§3): it recovers tokens by prefix and per-kind arity
but does NOT validate the owner token: a well-formed *split* is necessary, not sufficient, for a
subject to be surfaced as a delivery. The last row shows an old-shape alias that split-parses yet MUST
be dropped at the surfacing boundary (§9):

| Subject | Result |
| --- | --- |
| `cotal.main.chat.<ownerA>.alice.team.backend` | `kind=chat`, `sender=<ownerA>.alice`, `rest=team.backend` |
| `cotal.main.inst.<ownerB>.bob.<ownerA>.alice` | `kind=inst`, `sender=<ownerA>.alice`, `rest=<ownerB>.bob` (recipient) |
| `cotal.main.svc.reviewer.<ownerA>.alice` | `kind=svc`, `sender=<ownerA>.alice`, `rest=reviewer` |
| `cotal.main.ctl.manager.<ownerA>.alice` | no sender; v0 control subject, retired (§13.11): nothing serves it and it MUST NOT be handled |
| `cotal.main.chat.<ownerA>.alice` | no sender; malformed (owner+actor but no channel token) |
| `cotal.main.chat.UAQGWOEVJKMIO4WXSYOTLARXYOZTCXFK67JASEH6AFFFYK6FOPSKQCAD.team.backend` | split-parses (`kind=chat`, `owner=UAQ...QCAD`, `actor=team`, `rest=backend`) but MUST be dropped: `UAQ...QCAD` is not a principal owner token (§3, §9) |

Sample multicast message:

```json
{
  "id": "018f1d0a-0000-7000-9000-000000000001",
  "ts": 1710000000000,
  "space": "main",
  "from": {
    "id": "u_aaaaaaaaaaaaaaaaaaaaaaaaaa.alice",
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
    "id": "u_aaaaaaaaaaaaaaaaaaaaaaaaaa.alice",
    "name": "alice"
  },
  "to": "u_bbbbbbbbbbbbbbbbbbbbbbbbbb.bob",
  "parts": [{ "kind": "text", "text": "Direct note." }]
}
```

Interop scenario:

1. Provision a space and credentials for Alice and Bob.
2. Alice and Bob connect with inbox prefixes `_INBOX_<connId>` (per-connection, §2).
3. Both write presence and join `team.backend`.
4. Alice multicasts on `team.backend`; Bob receives with `kind=channel`.
5. Alice unicasts to Bob; Bob receives with `kind=dm`.
6. Alice anycasts to `reviewer`; exactly one reviewer receives with `kind=anycast`.
7. A late joiner joins `team.backend`; replayed messages arrive with `historical=true` and
   live-tail duplicates at or below the join watermark are ack-dropped.

---

## 13. Endpoint control surface (v0.4)

Everything on the mesh that serves structured commands — the manager daemon, the delivery
daemon, a wrapped MCP server, a third-party service — is an **endpoint**: a daemon that
registers a service identity, publishes its contracts, and answers `describe`. There is no
special-cased service in this contract: `manager` and `delivery` are endpoint names like any
other, and no subject or envelope in this section knows them. This section supersedes and
**deletes** the v0 control rail (`ctl.<service>.<owner>.<actor>`, `ControlRequest`/
`ControlReply`, the `self`/`manager`/`admin`/`delivery`/`delivery-admin` service tiers, and the
reserved `control.<instance>` subject). The cut is hard (§13.11): no v0 control subject,
envelope, handler, or grant survives, and a pre-cut control credential cannot reach a post-cut handler.

Layering: identity and transport are §2/§3, extended by the lifecycle identity below; §13.1
identity; §13.2 grammar; §13.3 envelope; §13.4 delivery contracts; §13.5 verbs; §13.6
composites; §13.7 contracts and discovery; §13.8 distributed guarantees; §13.9 authority
boundary; §13.10 receipts and signing anchors; §13.11 the hard cut; §13.12 the NATS binding;
§13.13 conformance.

### 13.1 Lifecycle identity

The principal `owner.actor` (§2) is a **recyclable routing alias**: despawning an agent frees
its actor name, and a later spawn may legitimately reuse it. An alias is therefore never
sufficient *authority* identity on this surface. Two further identity components exist:

- **Lifecycle UID** (`lifecycleUid`, one token `[a-z0-9]{8,32}`): an unguessable, never-reused
  identifier of one managed lifecycle under a principal. The minting authority (the manager for
  managed agents; the provisioner for endpoint daemons and operator credentials) mints it
  **before the entity is reachable** and persists a CAS-fenced mapping
  `{ principal, lifecycleUid, owner, managerInstance, currentCredentialId, processEpoch,
  state: active | retired, revision }` (`currentCredentialId` is a public key
  identifier/fingerprint plus authority epoch — never secret material). A supervised restart
  of the same entity **preserves**
  the UID (revoking/rotating the connection credential and advancing the process epoch); a
  terminal despawn, explicit stop, or supervision escalation **durably retires** the UID
  *before* the alias is freed. A retired UID is never reactivated; the allocator is durable
  and monotonic across manager restart, so recycling cannot move to the allocator.
- **Process epoch** (`incarnation`, an unsigned integer): the fenced ownership epoch of the
  process currently animating an identity, advanced by CAS on every takeover or restart. At
  most one live epoch owns an identity; a superseded process MUST stop serving and its commits
  are rejected (§13.8).

Binding rule (normative): **durable** authority and state — sturdy handles, accepted goals,
checkpoint tokens and resumes, durable consumers and delivery state, ledger rows — bind
`(principal, lifecycleUid)` and survive supervised restart. **Live** authority — session
grants, reply attribution, serve/commit ownership — additionally binds the process epoch and
dies on restart. The alias alone authorizes nothing: a delayed or redelivered request, handle,
or teardown that names a recycled alias fails against the replacement because the lifecycle
UID differs. Endpoint daemons carry the same triple, with the **stable logical instance id**
(`instanceId`, `[a-z0-9]{1,16}`, persisted for the endpoint lifetime) as their routable
identity component; `instanceId` is to an endpoint what `lifecycleUid` is to a managed agent,
and both follow the same restart-preserve / terminal-retire / epoch-fence rules.

**Cross-plane scoping.** Chat/DM/presence *subjects* keep the §3 grammar (the alias), but
their backing state is lifecycle-scoped: presence carries the current `lifecycleUid` (§6);
per-instance durable consumers, pending delivery cursors, durable memberships, history
cutoffs, and ACL/ledger rows key on `(principal, lifecycleUid)` (§8, §9). Explicit same-name
recreation inherits **no** predecessor authority or content: terminal retirement records
per-stream sequence cutoffs before the alias is freed, messages published while no lifecycle
is active do not flow to a later replacement, and retirement across streams is ordered and
reconciled (never assumed atomic). **Destructive cleanup is lifecycle-keyed**: every teardown
of a lifecycle's files, ledger rows, durables, ACL, membership, or cursors carries the
retiring UID + expected ownership revision and deletes only if that UID still owns the
resource (delete-if-current); the alias stays reserved until retirement and cleanup have
durably completed, so a stale detached teardown can never destroy a same-name successor.
Supervised restart of the same UID retains all of it.
Intentional role-mailbox continuity across lifecycles is only available as an explicit,
separately authorized transfer operation — never an accidental consequence of string reuse.

### 13.2 Grammar

**Endpoint names.** An endpoint name is one or more labels, each matching `[a-z0-9-]+` (`_`
MUST NOT appear in a label). Single-label names (`manager`, `delivery`) are reserved for
endpoints shipped by this contract's reference implementation and require the space operator's
provisioning authority to serve; a third-party endpoint name MUST be reverse-DNS (two or more
labels under a domain its author controls, e.g. `com.acme.deploy`) and is mintable only under
the owner that registered that domain claim. In a wire subject the name is one token with `.`
replaced by `_` (`com_acme_deploy`); because `_` cannot appear in a label the mapping is
bijective. Name authority is the credential, never the registry (§13.9).

**Command tokens.** A command name is one token `[a-z0-9-]{1,32}`. The command is a validated
subject token so the broker enforces per-command authority (§13.9). `describe` and `cancel`
are reserved command names (§13.7, §13.6).

**Request subjects.** Three modes under one kind `ep`. Every request carries the caller as
**three** forge-locked tokens `<owner>.<actor>.<uid>` (principal + lifecycle UID, §13.1). A
`call` (reply expected) additionally carries a caller-chosen unguessable **nonce** token
(`[A-Za-z0-9_-]{16,64}`) as the final token; a `cast` omits it. A command whose contract
declares it **targeted** carries an **authorization-mode token** and the target's three
identity tokens between the command and the caller:

| Form | Subject |
| --- | --- |
| Class call | `cotal.<space>.ep.call.<endpoint>.<command>[.<authz>.<tOwner>.<tActor>.<tUid>].<owner>.<actor>.<uid>.<nonce>` |
| Class cast | `cotal.<space>.ep.call.<endpoint>.<command>[.<authz>.<tOwner>.<tActor>.<tUid>].<owner>.<actor>.<uid>` |
| Class scatter | `cotal.<space>.ep.all.<endpoint>.<command>[.…target…].<owner>.<actor>.<uid>.<nonce>` |
| Instance call/cast | `cotal.<space>.ep.inst.<endpoint>.<iOwner>.<iActor>.<instanceId>.<command>[.…target…].<owner>.<actor>.<uid>[.<nonce>]` |
| Reply | `cotal.<space>.ep.reply.<endpoint>.<iOwner>.<iActor>.<instanceId>.<epoch>.<owner>.<actor>.<uid>.<nonce>` |

`call` is served by a queue group (one member per request); `all` is served by a plain
subscription on every instance (§13.5 scatter); `inst` addresses one instance by its stable
triple. Within each mode the optional target block and the optional nonce give distinct
arities, so parsing is unambiguous; a subject matching none of the shapes has no sender and
MUST NOT be handled.

**The authorization-mode token** (`<authz>`) makes the authority gradient explicit and
broker-enforced where it is statically expressible, and honestly validator-primary where it is
not. Four modes:

- `self` — the target is the caller: grants pin `<tOwner>.<tActor>.<tUid>` to the caller's own
  three tokens. Broker-confined.
- `owner` — owner-domain: grants pin `<tOwner>` to the caller's own owner and wildcard the
  rest (`<owner>.*.*`); an operator/admin capability MAY be minted with a wildcard target
  owner (`*.*.*`) on this mode. Broker-confined.
- `child` — static-mesh own-child (`spawner == caller`): a **distinct trusted-validator form**.
  The grant means "may ask this validator", not "already authorized"; the handler MUST
  fresh-check the immutable spawner relation against durable state and fail closed.
- `ledger` — fresh-ledger escalation: a distinct trusted-validator form; the handler MUST
  fresh-read the authorization ledger and fail closed on lookup failure, timeout, or absence.

`child` and `ledger` are never wildcard-reachable from an `owner` grant (distinct token ⇒
distinct subject ⇒ distinct grant row). A handler MUST resolve the target — the
revision-pinned `(alias, lifecycleUid)` mapping (§13.1) — immediately before effect and reject
any request whose body target disagrees with the subject target tokens (`target-mismatch`) or
whose expected target lifecycle UID does not match the current mapping (`expired`). The
subject, never the body, is the authorization boundary; handler policy only narrows.

**Replies.** Every reply rides the dedicated reply rail above, **deterministically derived
from the authenticated request subject**: the responder copies the caller triple and nonce
from the request subject and prefixes its own endpoint/instance/epoch tokens. A responder
MUST ignore any transport- or payload-supplied reply target (the confused-deputy boundary).
Confinement and attribution are structural: the caller's read grant is its own rail
(`ep.reply.*.*.*.*.*.<owner>.<actor>.<uid>.>`), so it reads only replies addressed to it; the
responder's publish grant pins its own instance triple and epoch
(`ep.reply.<endpoint>.<iO>.<iA>.<iId>.<epoch>.>`), so the answering instance and epoch are
read off the broker-authenticated reply subject, never trusted from the payload. A stale
process (superseded epoch) publishes attributably stale replies that callers reject. An
instance that never received a request cannot address its reply rail (the nonce is
unguessable), and scatter gathers reject replies from instances outside the frozen expected
set (§13.5).

**Event and journal subjects.** Endpoint-published planes, captured by per-space streams
(§13.12); the publishing instance's identity is forge-locked into the subject:

| Plane | Subject |
| --- | --- |
| Events | `cotal.<space>.epe.<endpoint>.<iOwner>.<iActor>.<instanceId>.<topic...>` |
| Canonical facts | `cotal.<space>.epf.<endpoint>.<topic...>` |
| Submissions | `cotal.<space>.epj.<endpoint>.<command>.<owner>.<actor>.<uid>` |
| Timers | `cotal.<space>.ept.<endpoint>.<iOwner>.<iActor>.<instanceId>.<timerId>` |
| Work pools | `cotal.<space>.epw.<endpoint>.<pool>.<topic...>` |
| Sessions | `cotal.<space>.eps.<endpoint>.<sessionId>.<in|out>` |

Reserved event topics: `ev.<cluster>.<event>` (cluster events), `goal.<cOwner>.<cActor>.
<cUid>.<goalId>.<t>` (per-goal action progress; the caller identity in the subject gives
mint-time read containment), `cp.<token>.<t>` (checkpoint transitions). Reserved fact topics:
`acc.<id>` (canonical acceptance), `goal.<cOwner>.<cActor>.<cUid>.<goalId>.result` (terminal
results), `receipt.<requestId>`. Submissions are publishable directly by capability holders
and are **explicitly untrusted** (§13.4); canonical fact subjects are publishable only by
their mediated writer (§13.9). `<id>`, `<goalId>`, `<timerId>`, `<token>`, `<sessionId>` are
single tokens `[A-Za-z0-9_-]{1,64}`.

The v0 subjects `cotal.<space>.ctl.>` and `cotal.<space>.control.>` are retired: nothing
serves them and no post-cut credential carries a grant on them. `trace.<instance>` remains reserved,
unchanged.

### 13.3 Envelope

Requests, replies, submissions, events, facts, and progress payloads are UTF-8 JSON. The
envelope is versioned and typed; `ControlRequest`/`ControlReply` are deleted.

`EndpointRequest`:

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `v` | `1` | MUST | envelope version; other values rejected (`unsupported-version`) |
| `id` | string | MUST | caller-chosen request id, `[A-Za-z0-9_-]{1,64}`; the idempotency key at the declared scope (§13.8); the JetStream `Nats-Msg-Id` on journaled planes |
| `op` | object | MUST | `{ endpoint, command, inputDigest?, outputDigest? }`; MUST agree with the subject (`op-mismatch`). Digests bind the invocation to the described contract; a member that cannot honor them replies `contract-mismatch`, never coerces |
| `class` | `ephemeral` \| `action` \| `journal` | MUST | declared delivery class; MUST equal the command's contract class (`class-mismatch`); immutable per submission |
| `target` | object | targeted ops | `{ id: <tOwner>.<tActor>, lifecycleUid }` — MUST equal the subject target tokens (`target-mismatch`) |
| `args` | object | MAY | validated against the input schema before any effect (`bad-request`) |
| `from` | `EndpointRef` | MUST | as §5; `from.id` MUST equal the subject sender principal, and the sender UID token MUST match the caller's minted lifecycle UID (broker-enforced by the grant) |
| `deadlineMs` | number | MUST for call/scatter | caller deadline budget; bounded, never unbounded |
| `correlation` | object | MAY | `{ traceparent?, tracestate?, baggage? }` per W3C Trace Context; propagated to downstream calls, events, facts, receipts |
| `auth` | string | MAY | opaque signed authorization-context slot (capability handle, obligations, payment proof) |

`EndpointReply`:

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `v` | `1` | MUST | |
| `id` | string | MUST | echoes the request `id` |
| `ok` | boolean | MUST | |
| `data` | any JSON | MAY | present iff `ok`; validated against the output schema |
| `error` | object | iff `!ok` | `{ code, message, details?[] }`; codes below; `details[]` entries carry reverse-DNS `kind` |
| `receipt` | string | MAY | opaque signed receipt slot (§13.10) |

The answering instance, its epoch, and the addressee are read from the **reply subject**
(§13.2), not from payload fields; a payload claim of either is advisory display data only.

**Monotonic attenuation (invariant).** Envelope content — the `auth` slot, a handle,
obligations — may only narrow what the presenting credential already permits, never widen it.
A handler that honors envelope content as authority beyond the broker grant is non-conformant.
Authority *conferral* exists only as trusted redemption (§13.6 capability handle).

**Error catalog.** `code` is one token: `bad-request`, `unsupported-version`, `op-mismatch`,
`class-mismatch`, `target-mismatch`, `sender-mismatch`, `unauthenticated`,
`permission-denied`, `not-found`, `already-exists`, `conflict` (CAS/fencing loss,
fingerprint conflict, duplicate resume), `contract-mismatch`, `contract-invalid` (schema
outside the profile / over budget at registration), `failed-precondition`,
`deadline-exceeded`, `cancelled`, `expired` (lease, handle, lifecycle UID, epoch, token),
`unavailable` (no responder), `unimplemented`, `resource-exhausted`, `internal`. Extensions
add codes only under reverse-DNS.

### 13.4 Delivery contracts

Three delivery contracts, chosen per command class, declared in the contract, immutable per
submission. Decision rule: crash means "just re-ask" → **ephemeral**; long-lived state
something converges on → **record**; must survive restart, be audited, metered, or
compensated → **journal**. Wrong-class submission fails loud.

**Ephemeral** — request/reply on the `ep` rails; no broker persistence; at-most-once effect
unless the command is idempotent by `id`. No-responder is a loud `unavailable`.

**Record** — a `{kind, schema, spec, status, meta}` resource in the per-space records bucket,
stored as **two keys with independent revisions**: `<key>.spec` and `<key>.status`. The split
is the broker-enforced writer boundary: the spec-writer and status-writer roles hold publish
grants on their own key only (per-kind writer table, §13.9). Writes use per-key CAS; a lost
race is a loud `conflict`. The merged logical read carries `status.observedSpecRevision`; a
reader treats `observedSpecRevision < spec.revision` as a stale-but-valid level-triggered
projection, not an error. Watch delivers current values then deltas per key; a watcher that
falls behind MUST re-read both keys and resume, never patch forward across a gap. Records are
bounded (§13.8).

**Journal** — an explicitly **untrusted at-least-once submission log** feeding **canonical
accepted-fact subjects** with a mediated writer; effects consume only canonical facts, never
raw submissions.

1. A journaled submission is published to the submission plane (`epj`) with
   `Nats-Msg-Id = id`; within the broker dedupe window duplicates collapse natively.
   Submission subjects and fact subjects are disjoint by construction (§13.2), so a
   submission credential cannot write a fact.
2. The **canonicalizer** — the narrowly scoped mediated writer for this endpoint's facts
   (§13.9) — validates each submission (schema, fingerprint, authorization epoch per §13.6)
   and **accepts** each id exactly once by publishing to `epf.<endpoint>.acc.<id>` with
   create-only CAS (expected last sequence on the subject = 0). First accept wins atomically;
   a later attempt fails its CAS and reads the existing fact. There is no append-then-memo
   pair to crash between; the acceptance state machine is recoverable at any interruption
   point (re-validate, re-attempt CAS, observe the winner).
3. The acceptance fact binds `id` to the submission **fingerprint**: the RFC 8785 digest of
   `{endpoint, command, schemaDigest, args, caller: {id, lifecycleUid}}`. Same id + same
   fingerprint is the same request (idempotent, first-wins); same id + different fingerprint
   is a loud `conflict`, never accepted or effected.
4. Acceptance facts/tombstones are retained at least the declared **idempotency horizon**
   (default 24h, space-configurable); beyond it a reused id is explicitly new work.
   Submission retention MAY be shorter; the canonical subjects are the authority (D12) for
   anything auditable, metered, compensated, effected, or replayed. Ordering is per-subject;
   consumers never assume cross-subject order.

### 13.5 Verbs

- **call** — bounded request/reply (`deadlineMs` mandatory). Class call is queue-group
  anycast; instance call addresses one stable instance. No responder → `unavailable`.
- **cast** — same subjects, no nonce, no reply; at-most-once. A cast to a journaled command is
  `class-mismatch`; journaled work goes through submissions.
- **watch** — observe a record (KV watch; fell-behind ⇒ re-read, §13.4) or an event topic
  (live subscription within the read grant plus filtered replay from the event stream).
  Per-key and per-goal subjects carry read containment; a watch grant names the exact subtree.
- **claim** — competitive at-most-one-winner pull from a durable work pool (`epw`). A claim
  carries a lease `(fencingToken, leaseDeadline)`: the token increases monotonically per work
  item on every (re)assignment; the deadline is the **lease authority's clock** (the pool's
  owning endpoint), never the worker's. Expiry revokes the claim at the deadline even before
  reassignment: every Cotal-owned commit from claimed work flows through the owning
  authority's **mediated commit path** (§13.9), which rejects a stale token OR an expired
  lease against its own clock (`expired`). Workers hold no bypass write. Redelivery
  re-fences.
- **scatter** — a request on the `all` rail. The caller freezes a **request-scoped expected
  set** — the live instances of the class from the service registry (stable instance ids +
  registration revisions) at send time. Gather accepts at most one terminal reply per expected
  `instanceId` (attribution from the reply subject, §13.2); duplicates are dropped; replies
  from outside the frozen set are classified `unexpected` and never count toward completion.
  Completion is all-expected-replied or deadline, in which case the result is explicitly
  partial with `missing` / `unexpected` / `late` classifications. An empty or unreadable
  registry is `failed-precondition`, not an empty success. Deadline mandatory.

### 13.6 Composites

Patterns over the verbs and contracts; zero new transport.

**Action** — a long-running command (`class: action`).

1. The caller submits with a client-generated `goalId` and the request fingerprint (§13.4).
   The endpoint replies accept/reject within the call deadline; acceptance is a journal fact.
   **Authorization linearizes at acceptance**: the acceptance fact persists the caller and
   target lifecycle tuples, command + contract digests, and the authorization decision
   revision/epoch it was made under. A scope narrowing before acceptance rejects the goal;
   after acceptance it blocks *new* goals but an accepted goal continues — unless the
   command's contract declares **continuous reauthorization**, in which case each declared
   checkpoint re-validates and deterministically transitions to `cancelling`/`failed`
   (`permission-denied`) on narrowing. Handle expiry/revocation mid-goal follows the same
   declared policy.
2. States: `accepted → running ⇄ waiting → succeeded | failed | cancelled | expired`, with
   `cancelling` between a cancel and its terminal state. This is the **single status
   vocabulary** for every long-running surface.
3. Progress rides per-goal events (`epe…goal.<caller triple>.<goalId>.progress`), read-scoped
   to the caller at mint time. The goal's current state is a status-only record projection;
   the journal owns the facts.
4. Cancel is the reserved `cancel` command: `graceful` (compensations, default) or
   `terminate`. Cancel of an unknown/terminal goal is `failed-precondition` with the cached
   outcome attached. Cancel races completion at the mediated commit point: first terminal
   fact wins; the loser observes it.
5. The terminal result is a journal fact and is cached. The full payload is retained at least
   the declared result retention (default 24h); a **terminal tombstone**
   `{goalId, fingerprint, state, outcomeDigest}` at least the idempotency horizon (≥ result
   retention). Same goalId + fingerprint returns the cached outcome (after payload eviction:
   the tombstone summary, `data.evicted: true`); same goalId + different fingerprint is
   `conflict`; beyond the horizon a reused goalId is explicitly new work.
6. **Bounded readiness (`uncertain`).** An action whose success signal may lawfully not
   arrive within its deadline (e.g. spawn readiness) completes the *call* with the outcome
   `uncertain` — a bounded caller outcome, never rewritten — while its goal **status record**
   remains non-terminal and MAY later reconcile to the real outcome (ready/exited), observable
   via watch. The cached caller result is immutable; reconciliation is status-record-only.
7. Goals bind the target's `(principal, lifecycleUid)` (§13.1): a goal accepted against a
   lifecycle is not redeemable, cancellable, or effectful against a same-name successor. A
   restarted instance (same `instanceId`/UID, advanced epoch) recovers its goals from journal
   + records; a superseded epoch cannot commit transitions.

**Awaitable checkpoint** — one durable pause primitive (approvals, guard holds, payment
authorization). A waiting action mints a checkpoint: a durable token persisted with the goal,
a `waiting` status carrying the checkpoint id and its **deadline generation**, and a durable
timer (§13.12). Deadlines are mandatory. Heartbeat/extension CAS-advances the generation in
status, then replaces the timer (same-subject schedule publish; the 2.14 atomic
stop-plus-publish is NOT assumed at the 2.12 floor). A firing timer carries
`(timerId, generation)`; the endpoint validates the generation against current status before
acting — stale fires **no-op**. Because status and timer are two resources with no atomic
bridge, a **durable reconciler** on the owning endpoint repairs the pair after crash or
leadership change: every `waiting` status without a current-generation schedule is re-armed;
orphaned schedules no-op. Cancellation of a timer is cleanup, never the correctness boundary.
Timer retention MUST exceed the maximum deadline plus a recovery margin. Resume: a `resume`
command presenting the checkpoint token; resume authorization is **one-use** (journaled by
create-only CAS on the checkpoint token; duplicate resume is `conflict`) and holder-bound
(§13.10). Expiry fails the checkpoint closed.

**Guard checkpoint** — the pre-effect authorization hook. A command carrying the governed
`ai.cotal.guarded` trait MUST NOT effect until the guard endpoint named by the trait value
answered **allow** (class call). Answers: `allow | deny | hold` plus optional signed
obligations (attenuations the endpoint MUST apply; monotonic). `hold` converts the action to
`waiting` on a checkpoint owned by the guard decision. Timeout or unreachable guard is
**deny** (fail closed). Ordering is guard-then-effect. Side-effecting guards own their own
reconciliation.

**Capability handle** — the one passable reference type: a signed JSON grant, RFC 8785
canonical, Ed25519-signed by a key in the trust-anchor registry (§13.10):

`{ v: 1, id, space, issuer: { keyId }, holder: { id, lifecycleUid }, grants: [{ endpoint,
instanceId?, commands[] }], iat, nbf?, exp, parentDigest?, sturdy, epoch?, sig }`

- **Two uses, both fail-closed.** *Attenuation:* presented in the `auth` slot, a handle only
  narrows — the handler enforces `effective = presenter-cred ∩ handle.grants ∩
  issuer-authority`; it never confers broker reach. *Conferral:* a handle grants reach only by
  **redemption through the trusted auth path** (the exchange/callout of §9/§10), which mints a
  short-lived credential whose grants are the intersection of issuer authority, handle grants,
  and the redeeming holder's current lifecycle + credential; no handler-side widening exists.
- **Holder-bound:** `holder` names the one `(principal, lifecycleUid)` that may present or
  redeem it; bearer transfer exists only as an explicit issuer-signed re-issue. `space` binds
  it to one space. A recycled alias cannot present its predecessor's handles (UID mismatch).
- **Attenuation chain:** `parentDigest` references the parent handle; a child's grants MUST be
  ⊆ the parent's; verification walks to a registered anchor, failing closed on widening,
  unknown/revoked keys, or expiry.
- **Sturdy vs live:** live handles (`sturdy: false`) bind the current process `epoch`, are
  never persisted, `exp ≤ 24h`, and die on restart. Sturdy handles bind the lifecycle UID
  (surviving supervised restart), persist as `handle.<id>` records (status = revocation
  state), and verifiers MUST check revocation (fail closed if unreadable). Max sturdy TTL is
  space-configured (default 30d).
- Handles are reusable within TTL unless a composite declares one-use (checkpoint resume);
  the replay matrix of §13.10 governs every signed artifact.

**Session (bidirectional stream)** — the generic composite for interactive byte/frame
streams (terminal attach is its first consumer; nothing terminal-specific is normative). A
session is established by an ordinary command whose answer is a **session grant**: a one-use,
holder-bound handle (live: bound to caller lifecycle + serving instance epoch) naming a fresh
unguessable `sessionId` and the session subjects `eps.<endpoint>.<sessionId>.in` (caller →
endpoint) and `….out` (endpoint → caller). Redemption mints exact asymmetric grants: the
caller publishes `in` and subscribes `out`; the serving instance the reverse; no third party
holds either. Frames are opaque; flow control is bounded (window declared in the grant;
overflow is `resource-exhausted`, never unbounded buffering). Close is explicit (either side;
a close frame + grant revocation); expiry and revocation follow the handle rules; the session
dies with the serving instance's epoch (restart terminates it — a durable session is a new
establishment). Routing is authenticated broker routing end to end; there is no loopback URL
or out-of-band transport in the contract, and cross-machine reachability is exactly broker
reachability.

**Virtual endpoints.** An endpoint MAY be virtual: registered (`spec.activation = on-demand`)
with no live instance. Its commands ride work pools (claim) — submissions buffer durably,
bounded, while nothing serves. An **activator** (holder of its activation capability) watches
the pool and starts an instance; single-writer per identity is fenced by instance-record CAS +
epoch. Passivation drains, updates status, exits; durable reminders ride the timer plane.
Supervision is restart-intensity escalation: more than `maxRestarts` (default 3) within
`restartWindow` (default 60s) escalates — the instance stops restarting, status records
`escalated`, the lifecycle retires terminally (§13.1), and the failure is loud.

### 13.7 Contracts and discovery

**Clusters.** An endpoint's surface is a set of composable **capability clusters**, each
`{ urn, revision, attributes[], commands[], events[] }`:

- `urn` — reverse-DNS cluster type URN (`ai.cotal.lifecycle`, `com.acme.deploy`).
- `attributes` — readable/watchable state; each declares a name, value schema, and record
  derivation (which record key carries it). Attribute reads/subscribes ride the record
  contract, never ephemeral replies.
- `commands` — each declares name, input/output schemas, `class`, `targeted` (and if so which
  authz modes it admits), its **capability requirement** (the named capability minting maps to
  subjects, §13.9), and optional traits.
- `events` — name + payload schema; events ride the journal contract on the event plane
  (`epe….ev.<cluster>.<event>`), read-contained by event-topic grants.

An **endpoint type** is a conformance set of cluster URNs. `manager` and `delivery` are
ordinary conformance sets defined by the reference implementation; core knows only
"endpoint".

**Schemas.** Contract schemas are JSON Schema **2020-12**, validated by a real 2020-12
validator (the reference implementation pins `ajv`), under this normative resource profile: a
schema is a **closed resource bundle** — either fully self-contained (local `$defs`/`#/…`
refs) or referencing other contract-store artifacts **by digest** only. `$id`/`$anchor`/
`$dynamicRef` resolve deterministically within the bundle; ambient HTTP/file/URI resolution
MUST NOT occur. Contract identity is the digest of the **complete resolved closure**, not the
root document alone. Registration-time bounds (loud `contract-invalid`, distinct from
invocation-time `bad-request`): document ≤ 256 KiB, closure ≤ 1 MiB, nesting ≤ 32, ref chain
≤ 32, bounded pattern complexity and compile/validation time budgets (§13.8). Runtime
validation at the serving boundary is mandatory: args before any effect, replies against the
output schema. Authoring tooling is free (the reference implementation authors in Zod); the
wire artifact and validation semantics are the JSON Schema documents themselves.

**Content addressing.** A contract artifact (cluster document, schema bundle member, trait
definition or attachment) is identified by the SHA-256 digest of its RFC 8785 canonical JSON
(strict RFC 8785 over I-JSON; the reference implementation pins `json-canonicalize`'s strict
path and gates on the RFC's published test vectors, including number-serialization and
surrogate edges). Artifacts live in the per-space contract Object Store keyed by digest;
readers MUST verify fetched bytes against the digest and fail loud on mismatch. Publication
is mediated (§13.9): artifacts are immutable once published.

**Descriptor and describe.** Each instance registers a **service record** (kind `svc`, key
`svc.<endpoint>.<iOwner>.<iActor>.<instanceId>`): spec = `{ endpoint, endpointType?,
clusterDigests[], protocol: { v: 1 }, activation? }`, status = `{ epoch, state,
observedSpecRevision, … }` (writer table §13.9). `describe` is a reserved untargeted
ephemeral command every endpoint MUST serve, returning the descriptor with clusters inline or
by digest. **Authorization-scoped answers use a trusted authorization source only**: the
answer is intersected against a fresh view of the caller's authority obtained from the
deployment's authorization ledger/callout (§9/§10), keyed by the broker-authenticated caller
identity — never against payload- or slot-asserted scope, which is ignored. If the trusted
view is unavailable or stale beyond its declared freshness bound, describe fails closed
(`unavailable`) rather than answering from a weaker source; deployments MAY declare an
endpoint's descriptor public, in which case no view is consulted and the answer says so.
Descriptor visibility is never inferred from reachability of `describe` alone. A KV browse
index (record kind `contracts`) is an advisory convenience copy; `describe` is authoritative.

**Invocation binding.** A caller that discovered a command SHOULD pin
`op.inputDigest`/`op.outputDigest`; a serving member MUST honor them or reject
`contract-mismatch`. Rolling updates keep classes contract-homogeneous: an incompatible
generation registers a distinct routable identity (new endpoint name or explicit version
label) until homogeneous.

**Traits.** A trait attaches governed metadata to a cluster, command, attribute, or event.
A **trait definition** `{ urn, valueSchema (digest), selector, breakingChanges, authority }`
is content-addressed and signed: `ai.cotal.*` definitions by the space-operator authority;
third-party definitions by their defining owner's registered key. **Attachment authority is
distinct from definition authority**: every *required/governed* attachment (this revision governs
exactly `ai.cotal.guarded` and `ai.cotal.priced`) is separately signed by the definition's
named authority over `{ endpoint, command, inputSchemaDigest (complete closure), traitUrn,
value }`, so a self-published descriptor cannot strip, forge, or downgrade a governed
annotation; removal or downgrade is an authorized contract revision. Enforcement is
fail-closed at the pre-effect seam: missing, unverifiable, or stale governed attachments
refuse before effect. Non-governed traits are unsigned vocabulary.

**Compatibility.** Cluster evolution is BACKWARD by default: within a revision line, changes
MUST be additive and added fields MUST carry defaults; removal, rename, or semantic change
mints a new cluster URN version. A push-time JSON-native compatibility differ + review gate
enforce this in the reference workflow (repository tooling under `scripts/`, not shipped
client code). The discovery protocol itself is versioned additively under `protocol.v`.

### 13.8 Distributed guarantees

- **Idempotency scope.** Ephemeral idempotent commands by `id` (handler-local, within result
  retention); journaled submissions and actions by `id`/`goalId` + fingerprint within the
  declared horizon. Exactly-once is bounded honestly: delivery is at-least-once; Cotal
  guarantees idempotent submission/fact recording and fenced commits of Cotal-owned state; an
  external side effect is exactly-once only when the external API honors the propagated
  idempotency key or fencing token, else the contract documents at-least-once effects.
- **Fencing and mediated commits.** Every Cotal-owned authoritative transition flows through
  its mediated writer (§13.9) carrying `(fencingToken | lifecycleUid | epoch)` as applicable;
  the writer validates token currency, unexpired lease against its own clock, lifecycle
  currency, and epoch currency. Value-carried tokens + CAS stop conforming-but-stale writers;
  scoped credentials + mediation stop everything else. The threat boundary of any
  direct-owner write is explicitly downgraded (§13.9).
- **CAS conflict.** Any lost CAS is a loud `conflict`; the loser re-reads and re-decides.
- **Retry/backoff.** Only idempotent-at-scope operations are retried: exponential backoff,
  base 250 ms, factor 2, cap 15 s, full jitter, bounded by the caller deadline.
- **Deadlines.** Mandatory on call, scatter, claims, checkpoints, timers, sessions. Reference
  default call deadline 15 s; defaults are overridable, never removable.
- **Cancellation ordering.** First terminal fact at the mediated commit point wins.
- **Watch recovery.** Fell-behind ⇒ snapshot re-read then resume; bounded relist; no silent
  gap-skipping.
- **Ordering/partitioning.** Per-subject only; the subject is the partition key.
- **Retention floors.** Submissions ≥ dedupe window; facts/tombstones ≥ idempotency horizon;
  results ≥ result retention; receipts ≥ receipt retention; timers ≥ max deadline + recovery
  margin; an endpoint MUST refuse to start against a store below its declared floors.
- **Backpressure and budgets.** Bounded consumer pending (default 1024), bounded
  virtual-endpoint pools and session windows, flow control on watches; overload is
  `resource-exhausted`. Schema compile/validate budgets (reference: 100 ms / 10 ms) and
  bounded regex; over budget is `contract-invalid`/`bad-request`.
- **Timers.** Broker message schedules at the 2.12 floor; same-subject replacement only;
  generation-validated firing (stale ⇒ no-op); durable reconciliation repairs
  status↔schedule divergence; replication and offline-assets downgrade fail loud at the
  broker floor gate.

### 13.9 Authority boundary

The credential is the coarse boundary; every subject in §13.2 is default-deny. Every
**statically expressible** authorization dimension — caller identity + lifecycle, endpoint,
command, target owner/alias/UID for `self`/`owner` modes, serve identity, reply attribution,
plane writer ownership — is broker-enforced through the subject grammar. The **named dynamic
relations** — static-mesh own-child, fresh-ledger escalation, target-mapping currency,
authorization epochs after acceptance — are trusted-validator-primary by design, fail-closed,
and operate only within the broker ceiling. Handlers only narrow.

**Caller grants.** Minting maps each named capability to exact endpoint+command subjects:
publish on the request forms (class + instance) with the authz-mode/target pattern the
capability specifies, subscribe on the caller's own reply rail, publish on matching `epj`
submission subjects for journaled commands, and the exact record-key / event-topic subtrees
for attribute/event read capabilities (per-goal containment rides the caller triple in the
topic). The caller's lifecycle UID token is pinned in every granted subject, so a credential
is dead against its principal's next lifecycle by construction. Wildcards are bounded: `*` in
the command position only when the capability covers every command of the endpoint; `*` in
the endpoint position never, outside operator/admin profiles; `child`/`ledger` mode subjects
are never covered by an `owner`-mode wildcard. `describe` is granted by default for all
endpoints; a space MAY narrow it. Minted credentials MUST stay within the deployment's JWT
size envelope, validated against realistic maximum capability sets (reference gate: 16 KiB).

**Serve grants.** Serving is granted authority, dual to calling: an instance's credential
binds its registered service name + stable instance id + current epoch + command set —
subscribe on its class/instance request forms, publish on its epoch-pinned reply prefix, its
own `epe`/`ept` planes and session subjects, its work-pool consumer, and the record keys the
writer table assigns it. Nothing else. Serve credentials are re-minted on takeover (new
epoch); a superseded credential's replies and commits are rejectable by epoch. Core names
require operator provisioning authority; reverse-DNS names bind to their registered owner.
The registry is discovery; the serve grant is the authority: a foreign credential cannot
subscribe a class rail, answer as an instance, or enter a frozen scatter set.

**The ownership matrix (normative).** Every profile × resource × transition is classified
**mediated** or **direct**, in an independently reviewed matrix from which grants are
generated (never the reverse):

| Transition | Writer | Class |
| --- | --- | --- |
| Journal submission append | capability holder | direct — explicitly untrusted input |
| Canonical acceptance (`epf…acc.*`) | the endpoint's canonicalizer principal | mediated |
| Claim / action / checkpoint commits | the owning endpoint's commit path (validates fencing, lease clock, lifecycle, epoch) | mediated |
| Contract-artifact publication | the contract publisher principal | mediated — immutable once published |
| Record `spec` writes | the kind's declared spec-writer | per-kind: mediated or direct |
| Record `status` writes | the kind's declared status-writer | per-kind: mediated or direct |
| Events / timers / sessions | the owning instance | direct — subject-confined |

A **mediated** row means the raw storage grant is held only by a narrowly scoped writer
principal (per endpoint, never a universal writer), with authenticated caller binding,
idempotent request semantics, and bounded failure/backpressure; CAS headers, fingerprint
rules, schema validity, and digest-correct bytes are *enforced* there. A **direct** row means
the broker guarantees writer/key containment only, and the row **explicitly downgrades**
CAS/schema/header/byte correctness to a conforming-client guarantee; readers of direct-row
state fail loud on invalid content. No profile — agent, observer, admin, host — holds generic
`$JS.API.>`/`$KV.>`/`$OBJ.>` authority over control-surface state; the matrix is re-audited
mechanically (decoded-credential fixture + live positive/negative probes) at every phase that
adds a resource or changes ownership.

**Writer table (core kinds).** `svc` (spec+status: the instance), `signer` (spec+status:
space operator), `handle` (spec: issuer; status/revocation: issuer or space operator),
`contracts` index (the instance), `goal`/`cp` projections (status: the owning instance's
commit path). Lifecycle mapping records (§13.1): the minting manager's commit path, CAS-only.

**Trait seam.** Core owns the fail-closed pre-effect verification interfaces (guard call,
priced-proof verification, governed-attachment verification); policy engines, token formats,
and payment rails remain extensions behind those seams.

### 13.10 Receipts and signing trust anchors

**Receipts.** A receipt binds a request to its outcome, signed and non-repudiable, for
metering, disputes, and pipeline causality; payment semantics stay opaque to core.

`Receipt` = `{ v: 1, requestId, endpoint, command, instance: { id, instanceId, epoch },
caller: { id, lifecycleUid }, schemaDigests: { input, output }, argsDigest, outcome: { ok,
code? }, resultDigest?, ts, signer: { keyId }, sig }` — canonical JSON, Ed25519-signed.
Lifecycle and epoch are recorded as **evidence**, never redemption authority. A command
carrying `ai.cotal.priced` MUST verify an independently verifiable payment proof in the
`auth` slot before effect (never a bare "settled" assertion) and emit a receipt fact
(`epf….receipt.<requestId>`). Receipt retention: default 90 d, ≥ the idempotency horizon.
Verification: signature against the anchor registry + digest recomputation; forged or
request-mismatched receipts fail loud. Receipts MAY be emitted for unpriced commands.

**Trust anchors.** One per-space registry covers every signed artifact of this section —
authorization slots, capability handles, checkpoint resumes, trait definitions and
attachments, session grants, receipts. Anchors are `signer.<keyId>` records: spec =
`{ keyId, publicKey (Ed25519), roles ⊆ [handles, traits, receipts, resume, sessions],
validFrom, validTo }`, status = revocation. Verification (fail closed): resolve the key,
reject unknown keys, out-of-window use, role mismatch, or revocation (immediate for new
verifications; effected work is not retroactively unwound). Rotation registers a successor
and closes the predecessor's window; overlap is permitted for handoff. Third-party trait
authorities register under their reverse-DNS domain claim. Trust roots never merge across
spaces.

**Replay matrix (normative).** Per signed artifact: capability handle — reusable within TTL,
holder-bound, revocable if sturdy; checkpoint resume — **one-use**, holder-bound;
session grant — **one-use** redemption, then live, epoch-bound; obligation — bound to its
goal/request, reusable within it; payment proof — per the priced contract's declared policy,
default one-use per request id; receipt — evidence, not authority, replay-irrelevant. Every
artifact carries `iat`/`exp` and a nonce/id; every verifier rejects out-of-window or
wrong-holder presentation.

### 13.11 The hard cut

This section is an intentional hard cut on the pre-1.0 line per §11. The version marker is
the grammar itself: the `ep`/`epe`/`epf`/`epj`/`ept`/`epw`/`eps` subject kinds and the
versioned envelope are disjoint from every v0.3 control subject and shape, and the old rails
are removed — subjects, envelopes,
handlers, credential grants, minting paths. No compatibility adapter, dual serving, or
translation window exists. A credential minted before the cut can publish only into dead v0
subjects: nothing subscribes them, no post-cut handler is reachable from them, no trusted
reply can be elicited (a pre-cut grant matches no endpoint-surface subject by construction —
verified adversarially with captured pre-cut credentials from every old profile). The wire
`protocolVersion` (§6, §11) targets `0.4` at the completion of this revision's migration, per
the §11 convention that the advertised version is the migration's normative target; `1.0` is
a separate, later stability declaration (§11).

### 13.12 NATS + JetStream binding

**Broker floor.** The control surface REQUIRES NATS server ≥ 2.12 (message schedules, atomic
create-CAS, counters). Implementations MUST check the connected broker at startup and fail
loud below the floor or when schedules are unavailable (including the offline-assets
downgrade mode). No sweeper fallback exists. Only 2.12 schedule semantics are assumed
(same-subject replacement; NOT the 2.14 stop-plus-publish path).

Per-space resources, created at space setup (`STREAM.CREATE` remains denied to agents):

| Resource | Captures / holds | Retention notes |
| --- | --- | --- |
| `EPJ_<space>` stream | `cotal.<space>.epj.>` (submissions, untrusted) | Limits; `duplicate_window` = dedupe window; retention ≥ window |
| `EPF_<space>` stream | `cotal.<space>.epf.>` (canonical facts) | Limits; acceptance via create-only CAS (`Nats-Expected-Last-Subject-Sequence: 0`); retention ≥ horizons |
| `EPE_<space>` stream | `cotal.<space>.epe.>` (events, progress) | Limits; space policy |
| `EPT_<space>` stream | `cotal.<space>.ept.>` (timers) | `AllowMsgSchedules`; retention ≥ max deadline + margin |
| `EPW_<space>` stream | `cotal.<space>.epw.>` (work pools) | WorkQueue; non-overlapping per-pool consumers |
| `EPS_<space>` stream or core-only | `cotal.<space>.eps.>` (sessions) | live frames core-sub; bounded window |
| `cotal_records_<space>` KV | records: `svc`, `signer`, `handle`, `contracts`, `goal`, `cp`, lifecycle mappings | per-key CAS; split `.spec`/`.status` keys |
| `cotal_contracts_<space>` Object Store | content-addressed contract artifacts | digest-keyed; verify-on-read; mediated publication |

Claim pools are pull consumers on `EPW` with `AckExplicit`; `ack_wait` realizes the lease
deadline and the item value carries the fencing token — but commit authority is the mediated
path (§13.9), not the consumer ack alone. Filtered replay of events/facts uses pinned
single-filter consumer creates (the CHAT-history containment mechanism, §8/§9). Timer
schedules publish on their unique `ept…<timerId>` subject; replacement is a same-subject
publish (server rollup).

### 13.13 Conformance (control surface)

A conformant endpoint (v0.4) MUST:

1. Serve only under a credential whose serve grants match its registered name, stable
   instance id, and current epoch; register its service record before serving; advance the
   epoch by CAS on takeover and stop serving when superseded.
2. Answer `describe` authoritatively, intersected only against the trusted authorization view
   (or declared-public), failing closed when that view is unavailable.
3. Publish contract artifacts content-addressed and immutable; validate args/replies at
   runtime within the schema profile and budgets.
4. Reply only on the reply rail derived from the authenticated request subject; ignore
   payload/transport reply targets; let attribution ride the reply subject.
5. Enforce the envelope invariants (version/op/class/target/sender, catalog codes, monotonic
   attenuation); treat the subject, never the body, as the authorization boundary; resolve
   targets by `(alias, lifecycleUid)` against current mappings immediately before effect.
6. Route effects by delivery class; journaled effects only from canonical accepted facts
   through the mediated writer; fingerprint-bind ids first-wins; hold the declared horizons,
   retentions, and floors.
7. Validate every Cotal-owned commit through the mediated path (fencing token + unexpired
   lease + lifecycle + epoch as applicable); lose CAS loudly.
8. Implement advertised composites per §13.6: the single action vocabulary, authorization
   linearized at acceptance, one-use resumes, generation-validated timers with durable
   reconciliation, fail-closed governed traits, bounded sessions.
9. Fail loud below the broker floor.

A conformant caller (v0.4) MUST: hold a lifecycle-pinned credential and never present another
lifecycle's artifacts; choose ids/goalIds/nonces within the token grammar and reuse ids only
per the idempotency rules; declare `class` and honor `contract-mismatch`/`conflict`; freeze
scatter expectations from the registry and classify partial results; verify digests of
fetched artifacts and signed artifacts against the anchor registry, failing closed.

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
| §13 Endpoint control surface | `packages/core/src/` (endpoint rails, envelope, contracts — lands with the control-surface campaign) |

## Appendix B: Profile ACLs

This appendix is normative for the NATS binding. *(The operator-facing summary of these
grants is [docs/identity-and-auth.md](docs/identity-and-auth.md).)* Names below use these
placeholders:

- `P = cotal.<space>`
- `CHAT = CHAT_<space>`, `DM = DM_<space>`, `TASK = TASK_<space>`
- `DLV = <Plane-3 per-member delivery stream>`; `INBOX = <mixed pre-auth fan-out stream>` (the durable-backstop handoff, §8): fan-out writes `INBOX` (`dinbox.<owner>.<actor>`), the trusted reader re-authorizes and transfers to `DLV` (`dlv.<owner>.<actor>`), and the agent binds its own `DLV` DELIVER consumer. An agent gets **no** grant on `INBOX` (the mixed pre-auth store).
- `KV = KV_cotal_presence_<space>`
- `CHKV = KV_cotal_channels_<space>`; `DLVKV = <delivery lease/readiness KV>`
- `<owner>.<actor> = the authenticated principal` (§2): `<owner>` and `<actor>` are its two tokens; the dot-form is the wire/KV form, the dash-form `<owner>-<actor>` is the durable-name form
- `connId = the authenticated connection id` (the connection nkey in static mode; the client-chosen nonce in user mode); distinct from the principal, and keys ONLY the reply inbox
- `role = authenticated agent role`
- `chatHistD = chathist_<owner>-<actor>`, `dmD = dm_<owner>-<actor>`, `dlvD = dlv_<owner>-<actor>`, `svcD = svc_<role>` (all keyed on the principal dash-form; §8)
- `inbox = _INBOX_<connId>.>`

Grouped placeholders such as `<CHAT|DM|TASK>` mean one concrete subject per listed token.

### Agent

`sub.allow`:

- `inbox`
- `P.ep.reply.*.*.*.*.*.<owner>.<actor>.<uid>.>` (the agent's own endpoint reply rail: every endpoint's replies to THIS caller triple, §13.2; replies never ride the per-connection `inbox`)
- `P.chat.*.*.<ch>` for every `allowSubscribe` channel, the **live read boundary**: native core-sub join/leave is a `sub.allow`-bounded subscribe to this subject (wildcard sender owner+actor), so an agent whose ACL permits a channel joins it alone with no manager. Wildcards preserved (e.g. `P.chat.*.*.team.>` for `allowSubscribe: team.>`); a `team.>` grant matches strictly deeper channels, not the bare `team`; a `>` grant is read-all chat in the space on credential compromise

`pub.allow`:

- `P.chat.<owner>.<actor>.<ch>` for every `allowPublish` channel (post ACL; none by default)
- `P.inst.*.*.<owner>.<actor>` (DM any recipient, forge-locked to me as sender)
- `P.svc.*.<owner>.<actor>` (anycast any role, as me)
- endpoint request forms per minted capability (§13.9): every agent gets the baseline set
  (`describe` on all endpoints; the delivery endpoint's durable join/leave/list commands;
  self-targeted lifecycle commands with authz-mode `self`); the `spawn` capability adds the
  manager endpoint's lifecycle commands with authz-mode `owner`; `child`/`ledger` forms and
  wider target patterns only per explicitly minted capability. The caller triple
  `<owner>.<actor>.<uid>` is pinned in every granted form
- `$JS.API.INFO`
- `$JS.API.STREAM.INFO.<CHAT|KV|CHKV|DLVKV>`: CHAT plus the world-readable presence/registry/lease KVs only; **not** DM/TASK (agents bind those by name and never inspect them, so INFO there would only leak inbox/task metadata)
- `$JS.API.CONSUMER.CREATE.<CHAT>.<chatHistD>.<P.chat.*.*.<ch>>` for every `allowSubscribe` channel (history reads; the single filter the server pins to the body, the agent's only CHAT consumer create. The live tail is the core `sub.allow` subscription above, not a JetStream consumer)
- `$JS.API.CONSUMER.INFO.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.MSG.NEXT.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.DELETE.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.INFO.<DM>.<dmD>`
- `$JS.API.CONSUMER.MSG.NEXT.<DM>.<dmD>`
- `$JS.ACK.<DM>.<dmD>.>` (DM inbox: BIND-ONLY its own pre-created `dmD`, never create)
- `$JS.API.CONSUMER.INFO.<DLV>.<dlvD>`
- `$JS.API.CONSUMER.MSG.NEXT.<DLV>.<dlvD>`
- `$JS.ACK.<DLV>.<dlvD>.>`, the **durable backstop**: BIND-ONLY its own pre-created per-member DELIVER consumer `dlvD` (the trusted reader's re-authorized handoff, §8). The agent holds NO grant on the mixed pre-auth `INBOX` fan-out stream.
- `$JS.API.CONSUMER.CREATE.<KV>.>`
- `$JS.API.CONSUMER.INFO.<KV>.>`
- `$JS.FC.>`
- `$KV.cotal_presence_<space>.<owner>.<actor>`
- `$JS.API.STREAM.MSG.GET.<CHKV>`
- `$JS.API.CONSUMER.CREATE.<CHKV>.>`
- `$JS.API.CONSUMER.INFO.<CHKV>.>`
- `$JS.API.STREAM.MSG.GET.<DLVKV>` (delivery lease/readiness; read-only, non-gating)
- if `role` is set: `$JS.API.CONSUMER.INFO.<TASK>.<svcD>`,
  `$JS.API.CONSUMER.MSG.NEXT.<TASK>.<svcD>`, `$JS.ACK.<TASK>.<svcD>.>`

`pub.deny` (the agent binds these consumers, never creates them; its only consumer-create grant is the pinned per-channel `chatHistD` history create):

- `$JS.API.CONSUMER.CREATE.<DM>`
- `$JS.API.CONSUMER.CREATE.<DM>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<DM>.>`
- `$JS.API.CONSUMER.CREATE.<TASK>`
- `$JS.API.CONSUMER.CREATE.<TASK>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<TASK>.>`
- `$JS.API.CONSUMER.CREATE.<DLV>`
- `$JS.API.CONSUMER.CREATE.<DLV>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<DLV>.>`

A bare/multi-filter consumer create on `CHAT` is **not** explicitly denied (that would also deny the
pinned `chatHistD` create the agent needs), so it is default-denied (the agent holds no such allow),
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

### Scoped host profiles (formerly `manager`)

There is **no allow-all credential**. The privileged host duties are split into scoped,
single-function profiles, each granting only the verbs its function needs and none other:

- `provisioner`: pre-creates the per-instance lifecycle-scoped durables (`dm_…`, `svc_…`, the
  per-member `dlv_…` handoff) and mints scoped credentials; ephemeral onboarding authority.
- `supervisor`: the always-on agent-lifecycle daemon (the manager process's own connection). It
  is the manager endpoint's serve credential (§13.9) and the ONLY holder of the capabilities for
  the delivery endpoint's admin commands (below).
- `delivery`: the server-side Plane-3 infra: fan-out, trusted-reader re-authorization, and the
  membership/ACL records the durable backstop authorizes against (§7). It is the `delivery`
  endpoint's serve credential (§13.9); its admin commands — `reloadCreds`, the explicit adoption
  step of standing credential renewal (the daemon re-reads its re-signed creds file, pins the
  identity, swaps its connection, and reconnects the membership feed's rw connection, replying
  with the adopted JWT windows); and `evictPrincipal`, force-drop of a denied principal's live
  connections (system-account CONNZ scan → per-server KICK → re-scan verify, fail-closed on
  partial scans and on owners outside the principal namespace) — carry a capability requirement
  only the `supervisor` profile is minted; agents are broker-denied. The former
  `delivery-admin` control tier is deleted with the v0 rail (§13.11).
- `membership-rw`: the derived channel-membership graph feed reader/writer.
- `operator`, `purger`, `teardown`, `channel-writer`, `control-caller-*`, `deployer`, `probe`: the
  human-CLI and maintenance surfaces, each scoped to its verbs.

Standing host credentials are **bounded and renewed**: one-shot profiles carry minutes-scale
expiry; `supervisor`/`delivery`/`membership-rw` carry a 24h expiry with the manager as the named
renewal owner (self-remint for its own credential; same-nkey re-sign + explicit `reloadCreds`
adoption for the seed-less daemons); the two system-account credentials (`membership-observer`,
`connection-evictor`) carry a 30d expiry and are renewable ONLY by a system-account rotation +
broker restart; no persisted system-account minting secret exists, by design. On per-user-auth
spaces, static `agent`/`observer`/`admin` minting is retired entirely (the flip): agent identities
exist only as owner+actor principals under a logged-in user, and the elevated profiles of this
appendix are reached per-connection via the exchange-authored view claim instead (§10). The flip is
deny-new: a static
credential signed before it (or minted out-of-band with the account signing key) remains
broker-valid until signing-key rotation, which is the revocation lever for static material; the
guarantee therefore applies to spaces that never issued static user-facing credentials.

The live channel subscribe depends on none of these; it is broker-enforced via `sub.allow`, so
self-serve live join works with no host present; only the durable backstop and its membership writes
require a privileged host. None of these profiles is ever issued to ordinary agents. Full per-profile
grant lists are enumerated in `provision.ts` (`permissionsFor`); this appendix documents the `agent`,
`observer`, and `admin` profiles that make up the wire-facing security claim.

## Appendix C: Normative references

| Reference | Used for |
| --- | --- |
| RFC 2119, RFC 8174 | requirement keywords |
| RFC 8259 | UTF-8 JSON envelopes (§5) |
| RFC 4648 | base32 instance-id encoding (§2) |
| RFC 8032 | Ed25519 keypairs behind nkeys (§2) |
| [NATS client protocol](https://docs.nats.io/reference/reference-protocols/nats-protocol) + [JetStream](https://docs.nats.io/nats-concepts/jetstream) | the v0 transport binding (§8) |
| [NATS decentralized JWT auth](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/jwt) + nkeys | identity and authorization (§2, §9) |

## Appendix D: Change log

Normative revisions of this document, newest first. Dated snapshots per §11; the wire
`protocolVersion` is the compatibility signal, not these dates.

| Date | Revision |
| --- | --- |
| 2026-07-10 | **v0.4 binding revision: endpoint control surface (§13).** One standardized typed surface for every endpoint (manager, delivery, wrapped third-party servers): class/instance/scatter rails with per-command broker enforcement and an authorization-mode gradient, lifecycle identity (recyclable alias + never-reused lifecycle UID + fenced process epoch, §13.1, §2/§6/§8 extensions), versioned envelope with structured errors and signed slots, three delivery contracts (ephemeral, split-key records, untrusted submissions → mediated canonical facts), verbs call/cast/watch/claim/scatter, composites (action, checkpoint, guard, capability handle, session, virtual endpoints), content-addressed cluster contracts + governed traits + describe, the ownership matrix, receipts and trust anchors. **Hard cut:** deletes the v0 `ctl` rail, `ControlRequest`/`ControlReply`, the `self`/`manager`/`admin`/`delivery-admin` tiers, and the reserved `control.<instance>` subject. `protocolVersion` targets `0.4` at migration completion; `1.0` stays reserved as a later stability declaration. |
| 2026-07-07 | Documentation revision, no wire change: layered authority statement (schema authoritative for shapes, prose for semantics), document-snapshot policy and this change log (§11), reciprocal links to the informative docs. |
| 2026-07-03 | **v0.3 binding revision: owner+actor identity.** The wire identity becomes the two-token principal `(owner, actor)`: subjects carry the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id` re-key onto the pair (§2, §3, §6, §8, §9). The connection nkey remains only the transport credential (the per-connection reply inbox). Adds the per-user-auth authorization grammar and the owner-token format (§2, §9). Supersedes the single-id grammar. |
| 2026-06-21 | **v0.3 binding revision: channel live delivery.** Channel live delivery moves from the mediated per-instance live-tail durable to native `sub.allow`-bounded core subscriptions, with an explicit per-channel `live`/`durable` delivery class and the per-member durable backstop (§4, §7, §8); membership moves to a privileged-written registry (§7). Supersedes the v0.2 single-durable live-tail. |
| earlier | v0.2 and before predate change control: the v0.2 contract (single mediated live-tail durable binding) is superseded by v0.3 and kept only in history. |
