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
| Endpoint rails | `cotal.<space>.ep.<one\|all\|inst\|reply>.…`, `cotal.<space>.ep<c\|e\|f\|j\|r\|t\|w\|s>.…` | see §13.2 | §13 control surface |
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
`$KV.`, `$SYS.`, `$O.`, or `_INBOX.`. (`$O.` is the Object Store data/meta subject prefix
per ADR-20 — `$O.<bucket>.C.>` / `$O.<bucket>.M.>`; `OBJ_<bucket>` is a stream NAME, not a
subject prefix.)

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
| `protocolVersion` | string | MUST from v0.4 | wire version spoken (§11); `"0.4"` for this revision. Advertisement is the marker at the v0.4 reachability boundary (§13.11): a participant that omits it is pre-0.4 (omission means the pre-0.4 line, where the field was optional) and MUST NOT be addressed on the `ep` rails. A change signal, not negotiation |

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
| `chathist_<owner>-<actor>-<uid>` | CHAT | one `cotal.<space>.chat.*.*.<channel>` per read | transient single-filter consumer for history reads (join-backfill / focus-recall); created per read scoped to one channel in `allowSubscribe`, then deleted; `AckNone`. History is ACL-bounded by the pinned filter, not membership-gated (§7, §9) |
| `dm_<owner>-<actor>-<uid>` | DM | `cotal.<space>.inst.<owner>.<actor>.>` | provisioner-created in auth mode at lifecycle activation; bind only; `DeliverPolicy.ByStartSequence` with `OptStartSeq = activationFrontier + 1`, where the **activation frontier** is the DM-stream's last sequence captured at activation (`0` on an empty stream, so the start is `1`): `ByStartSequence` is inclusive and the lifecycle interval is half-open, so the consumer starts strictly AFTER the frontier — never `All`, which would replay a recycled alias's history and the inactive-gap backlog; `AckExplicit`; `ack_wait=60000ms` |
| `svc_<role>` | TASK | `cotal.<space>.svc.<role>.>` | provisioner-created in auth mode; bind only; `AckExplicit`; `ack_wait=60000ms`. **Intentionally role-shared, not lifecycle-scoped**: anycast work belongs to the role, and successive holders draining one pool is the contract |

From v0.4, each lifecycle's durable state lives in the **half-open interval**
`(activationFrontier, retirementFrontier]` per stream: consumers start strictly after the
activation frontier (`OptStartSeq = frontier + 1`, table above; the frontier is captured
AFTER any inactive alias gap), and terminal retirement records the
retirement frontier before the alias is freed — so a successor lifecycle never receives the
predecessor's pending backlog nor messages published while no lifecycle was active (§13.1).

Per-instance durable names use the principal's dash-form `<owner>-<actor>` (both tokens
fail-loud-validated, not lossily sanitized), so a durable name-scopes to exactly one principal (§2).
The authenticated wire identity is the principal, not the connection nkey. From v0.4, in auth mode,
per-instance durable state is additionally **lifecycle-scoped** (§13.1): durable consumer names,
pending delivery cursors, membership rows, and ACL/ledger rows key on
`(principal, lifecycleUid)` (dash-form `<owner>-<actor>-<lifecycleUid>`), terminal retirement
records per-stream sequence cutoffs before an alias is reused, and a same-name successor
inherits none of its predecessor's pending state: its consumers start after its OWN
activation frontier (which is ≥ the predecessor's retirement cutoff) — the cutoffs bound the
predecessor's interval, they are never the successor's start.

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
`dlv_<owner>-<actor>-<uid>` DELIVER consumer, carrying the same ack semantics, not a fire-and-forget publish). The trusted reader MUST NOT ack or
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

History on join uses the pinned single-filter `chathist_<owner>-<actor>-<uid>` consumer create above, bounded to
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
| `agent` | own `chat.<owner>.<actor>.<ch>` for each `allowPublish` channel (post ACL, default-deny), `inst.*.*.<owner>.<actor>`, `svc.*.<owner>.<actor>`; endpoint request forms per minted capability (`ep.one`/`ep.all`/`ep.inst` with the capability's authz-mode/target pattern, caller triple `<owner>.<actor>.<uid>` pinned; `describe` by default; `epj` submissions for journaled capabilities; §13.9); own presence key | own `_INBOX_<connId>.>` + own endpoint reply rail (`ep.reply.*.*.*.<owner>.<actor>.<uid>.*`, exact arity); channel live tail via native `sub.allow` subscriptions to `chat.*.*.<channel>` per `allowSubscribe` (wildcards preserved); CHAT history via single-filter `chathist_<owner>-<actor>-<uid>` creates, one per `allowSubscribe` channel (ACL-bounded); own lifecycle-scoped `dm_…`/`svc_…` bind-only; durable backstop via own bind-only lifecycle-scoped `dlv_…` DELIVER consumer, **no** grant on the mixed pre-auth fan-out stream; granted record-key/event-topic read subtrees per capability | read bounded by `allowSubscribe`; durable copies re-authorized (current ACL + membership + lifecycle) by the trusted reader before the `dlv` handoff; no Direct Get; DM/TASK/DLV create denied |
| `observer` | none | chat, CHAT history, presence, channel registry | DMs invisible |
| `admin` | none | whole space live tap plus DM history | plaintext god-view, opt-in |
| scoped host profiles | least-privilege per function | least-privilege per function | The former allow-all `manager` is **deleted**; its host duties split into scoped, single-function creds (`supervisor`, `provisioner`, `delivery`, `membership-rw`, `operator`, `purger`, `teardown`, `channel-writer`, …). No allow-all credential exists. Appendix B summarizes them; the concrete grant lists are **generated from the §13.9 ownership matrix** into `provision.ts` (the matrix is the single oracle; `provision.ts` is its artifact, Appendix B its summary). |

DM and TASK confidentiality, and the CHAT read boundary, close the leak paths:

1. Replies and pull responses ride a per-connection inbox prefix, `_INBOX_<connId>.>`, which
   `sub.allow` permits alongside the agent's channel read grants (next item) and nothing else. In user
   mode the client picks `<connId>` (a nonce) and the callout scopes the inbox to it, so a
   wildcard-inbox subscribe that would sniff peers' DM deliveries is refused. Re-authorized durable
   copies do NOT ride the inbox; they ride the agent's own lifecycle-scoped `dlv_<owner>-<actor>-<uid>` DELIVER consumer
   (item 5, §8).
2. **Channel live reads are bounded by `sub.allow`.** `allowSubscribe` is minted as native subscribe
   grants over `cotal.<space>.chat.*.*.<channel>` (wildcards preserved); the broker refuses, per
   subscribe, any channel subject outside the ACL. There is no per-channel consumer name to confine,
   so an open ACL (`team.>`, `>`) grants selective single-channel join with no enumeration and no
   read-breakout. A `>` grant is read-all chat in the space by design (credential compromise reads
   all chat), so it suits trusted/local deployments, not least privilege.
3. A consumer create on the bare/multi-filter subject is not ACL-constrainable, so the provisioner
   pre-creates `dm_<owner>-<actor>-<uid>`, `svc_<role>`, and the per-member `dlv_<owner>-<actor>-<uid>` handoff
   durables. Agents bind their own `dm_…-<uid>`/`svc_<role>`/`dlv_…-<uid>` only (never
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
   copy off to the member's own lifecycle-scoped `dlv_<owner>-<actor>-<uid>` DELIVER consumer:
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
contract; the callout *mechanism* and the resulting grants are. From v0.4 every minted connection also carries its **lifecycle UID** (§13.1): the manager
mints it for managed agents at provision, and the callout/exchange attaches it as a claim at
connect for user-mode connections, so the caller-UID token in every endpoint-rail grant is
authority-assigned, never client-chosen. A bearer MAY carry a server-authored
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
  version out of band. A participant advertises the version it speaks via
  `AgentCard.protocolVersion` (§6) as a one-way change signal — optional before the v0.4
  marker, MUST from v0.4 (§6, §13.11); v0 defines no behavior on a mismatch beyond rejecting
  messages it cannot parse.
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
existing field or subject, or removing or renaming one, is breaking. **Pre-1.0**, a breaking
change ships as a minor bump of the v0.x line under an explicit new version marker in
subjects, credentials, or deployment config (the v0.4 endpoint grammar is such a marker);
**post-1.0**, it ships as a major bump. `1.0` itself is a stability declaration, made
deliberately and separately from any wire change.

**Extension namespacing.** Core `Part.kind` values, `meta` keys, and `tags` are bare and reserved
to this spec (`text`, `data`, and future core additions). A non-core extension MUST namespace its
custom `Part.kind` values and `meta` keys reverse-DNS, under a domain its author controls, e.g.
`{ "kind": "com.acme.snapshot" }` or `meta["com.acme.region"]`; Cotal's own non-core extensions
use `ai.cotal.*`. This keeps third-party names from colliding with each other or with future core
names, with no central registry.

Reserved future work: signed envelopes, `did:key` identity, artifact/object-store parts,
auth-callout bootstrap tokens, manager profile scoping, and federated/untrusted relay
bindings. (Revocation/TTL for minted credentials is no longer future work on the control
surface: v0.4 defines it normatively via the credential ledger and the lifecycle barriers,
§13.1.)

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

- **Lifecycle UID** (`lifecycleUid`, one token `[a-z0-9]{26,32}`, ≥128 bits of CSPRNG
  entropy in a fixed canonical encoding): an unguessable, never-reused
  identifier of one managed lifecycle under a principal. The minting authority (the manager for
  managed agents; the provisioner for endpoint daemons and operator credentials) mints it
  **before the entity is reachable** and persists a CAS-fenced mapping
  `{ principal, lifecycleUid, owner, managerInstance, currentCredentialId, processEpoch,
  state: active | retired, revision }` under the alias's **CAS head key** (§13.7:
  `lifecycle.<owner>.<actor>` points to the single current UID; the UID-suffixed detail key
  holds the mapping) — activation is the head CAS, so two concurrent mints for one alias
  serialize there and exactly one activates (`currentCredentialId` is a public key
  identifier/fingerprint plus authority epoch — never secret material). A supervised restart
  of the same entity **preserves**
  the UID (revoking/rotating the connection credential and advancing the process epoch); a
  terminal despawn, explicit stop, or supervision escalation **durably retires** the UID
  *before* the alias is freed. A retired UID is never reactivated; the allocator is durable
  and monotonic across manager restart, so recycling cannot move to the allocator.
- **Process epoch** (`incarnation`, an unsigned integer): the fenced ownership epoch of the
  process currently animating an identity, advanced by CAS on every takeover or restart. At
  most one live epoch owns an identity; a superseded process MUST stop serving and its commits
  are rejected (§13.8). **The epoch fences egress only**: reply, event, timer, session, and
  record-write-ingress publish grants pin it (§13.9), but request subjects deliberately omit it — a caller cannot
  know the serving epoch — so **no subject-level fence for ingress exists or can exist**. An
  un-revoked superseded serve credential remains a member of the class queue group and can
  consume (and externally effect, and never validly answer) one call in N. Takeover therefore
  carries a **normative barrier, in order**: advance the epoch by CAS → freeze issuance for
  the lifecycle in the credential ledger (below) → revoke EVERY active credential-ledger
  row under the lifecycle prefix — every root (the superseded `currentCredentialId` and any
  earlier unexpired root: each root mint, initial or rotation, writes its own ledger row)
  and every ledgered descendant (handle-redemption-minted and per-session credentials,
  §13.6) — via the deployment's auth
  authority, verifying the updated revocation state is enforced on EVERY server of the
  cluster before proceeding (fail-closed on partial acknowledgment: an unrevoked-anywhere
  credential can reconnect there) → evict the live connections of every revoked
  credential's principal
  cluster-wide and verify the re-scan found none (the delivery endpoint's `evictPrincipal`:
  system-account CONNZ scan → per-server KICK → re-scan verify, fail-closed on partial
  scans; Appendix B) → only then activate the successor's serve subscription. Where
  revocation or verified eviction is unavailable (e.g. static credential material
  pre-rotation, Appendix B), takeover MUST fail loud rather than proceed.

**Credential ledger (normative).** Ingress has no epoch fence, so revocation is only as
complete as the set of credentials it covers — and the lifecycle's `currentCredentialId` is
not that set. Every credential the trusted auth path mints **derived from** a lifecycle — the
short-lived credential of a handle redemption, the two per-session credentials of a session
redemption (§13.6) — is recorded at mint time in a durable, auth-owned **credential ledger**
row `{ credentialId, lifecycleUid (the holder's), sourceChain: [root |
handle.<issuerKeyId>.<id>… | session.<sessionId>] — the FULL verified lineage: for a
handle redemption, EVERY handle in the presented `parentDigest` chain (§13.6), never only
the leaf — state: active | revoked (monotonic), exp }`, keyed
`cred.<lifecycleUid>.<credentialId>` so both barriers enumerate a lifecycle's full descendant
family by key prefix. Each mint additionally writes one reverse-index key
`bysrc.<issuerKeyId>.<id>.<lifecycleUid>.<credentialId>` per chain member, so **revoking a
sturdy handle revokes every credential minted under it or under any of its descendant
handles** — a credential redeemed through a child handle carries the parent in its
`sourceChain`/`bysrc` keys, so parent revocation reaches it without walking handle records.
An unledgered mint MUST NOT occur (the ledger write precedes credential
release, fail-closed), and the rule carries a mechanical audit invariant in the style of the
§13.9 matrix grep test: every credential the auth authority has ever released MUST resolve
to a `cred.<lifecycleUid>.<credentialId>` row — an issuance path that cannot show its ledger
row is non-conformant, auditable by diffing issued-credential ids against the ledger.

**Issuance gate (normative).** "Freeze issuance" is a durable transition, not an assertion:
each lifecycle has a gate key `gate.<lifecycleUid>` in the same auth KV, `state: open |
frozen` (monotonic, CAS). The mint protocol is **write rows → re-read gate → release**: the
auth path writes the `cred.`/`bysrc.` rows first, re-reads the gate, and releases the
credential only if the gate is still `open` — on `frozen` it aborts and marks its own row
revoked, never releasing. A barrier CASes the gate to `frozen` FIRST and only then
enumerates the family. The race is closed by total order, not timing: the gate and the rows
share one KV bucket — one stream, one sequence (§13.12) — so a row written before the
freeze is visible to the barrier's enumeration, and a row written after it forces the
mint's re-read to observe `frozen` and abort; no interleaving releases a credential the
enumeration misses. The ledger is written only by the trusted auth path
(§13.9 matrix; NATS binding: the auth KV, §13.12).

Binding rule (normative): **durable** authority and state — sturdy handles, accepted goals,
checkpoint tokens and resumes, durable consumers and delivery state, ledger rows — bind
`(principal, lifecycleUid)` and survive supervised restart. **Live** authority — session
grants, reply attribution, serve/commit ownership — additionally binds the process epoch and
dies on restart. The alias alone authorizes nothing: a delayed or redelivered request, handle,
or teardown that names a recycled alias fails against the replacement because the lifecycle
UID differs. Endpoint daemons carry the same triple, with the **stable logical instance id**
(`instanceId`, `[a-z0-9]{26,32}`, ≥128 bits of CSPRNG entropy, persisted for the endpoint
lifetime) as their routable identity component. `instanceId` is **minted by the provisioner,
never reused, and unique within `(space, endpoint)`** — the allocator records it in the
instance's service record by create-only CAS and rejects collisions durably. Reply
attribution, scatter deduplication, queue ownership, and the event/timer planes all key on
it, so its uniqueness and entropy are load-bearing, not cosmetic. `instanceId` is to an
endpoint what `lifecycleUid` is to a managed agent, and both follow the same
restart-preserve / terminal-retire / epoch-fence rules.

**Cross-plane scoping.** Chat/DM/presence *subjects* keep the §3 grammar (the alias), but
their backing state is lifecycle-scoped: presence carries the current `lifecycleUid` (§6);
per-instance durable consumers, pending delivery cursors, durable memberships, history
cutoffs, and ACL/ledger rows key on `(principal, lifecycleUid)` (§8, §9). Explicit same-name
recreation inherits **no** predecessor authority or content: terminal retirement records
per-stream sequence cutoffs before the alias is freed, messages published while no lifecycle
is active do not flow to a later replacement, and retirement across streams is ordered and
reconciled (never assumed atomic). **Destructive cleanup is broker-enforced where the resource is broker-addressable**: durable
consumer names, ACL rows, KV record keys, and membership rows are lifecycle-keyed — the UID
is part of the resource NAME — and the teardown credential (the deprovisioner) is minted
target-pinned to `(principal, lifecycleUid)` by exact name, so a credential minted for
lifecycle A cannot even NAME lifecycle B's resources; the broker denies the stale delete
outright. Only resources the broker cannot see (the manager's local credential/token/health
files) fall back to a handler-side **delete-if-current** check carrying the retiring UID +
expected ownership revision. In both regimes the alias stays reserved until retirement and
cleanup have durably completed, so a stale detached teardown can never destroy a same-name
successor. **Terminal retirement is additionally a credential barrier, in order**: durably
retire the UID → freeze issuance for the lifecycle in the credential ledger → revoke every
active credential-ledger row under the lifecycle prefix (all roots and all descendants,
credential ledger above), verifying revocation enforcement on every server as in the
takeover barrier → cluster-verified eviction of every revoked credential's live connections
(`evictPrincipal`, as in the takeover barrier above) → record the
per-stream retirement frontiers → only then free the alias. Chat/DM/presence subjects stay
alias-keyed, so without the revoke-and-verified-evict step a still-connected stale process
could keep speaking as the recycled alias. Where the deployment cannot revoke the credential
or cannot verify eviction, alias reuse is **forbidden**: a same-name respawn fails loud.
Supervised restart of the same UID retains all of it.
Intentional role-mailbox continuity across lifecycles is only available as an explicit,
separately authorized transfer operation — never an accidental consequence of string reuse.

### 13.2 Grammar

**Endpoint names.** An endpoint name is one or more DNS-shaped labels, each matching
`[a-z0-9]([a-z0-9-]*[a-z0-9])?` (no leading/trailing dash, no bare dashes; `_` MUST NOT
appear in a label). Single-label names (`manager`, `delivery`) are reserved for
endpoints shipped by this contract's reference implementation and require the space operator's
provisioning authority to serve; a third-party endpoint name MUST be reverse-DNS (two or more
labels under a domain its author controls, e.g. `com.acme.deploy`) and is mintable only under
the owner that registered that domain claim. In a wire subject the name is one token with `.`
replaced by `_` (`com_acme_deploy`); because `_` cannot appear in a label the mapping is
bijective. Name authority is the credential, never the registry (§13.9). Endpoint-name
tokens may contain `-` inside labels; they are never used to derive principal dash-form
names — control-surface consumer names are the §13.9 pinned grammars, each carrying a
stated collision-freedom argument, and none is ever parsed back into its components, so
the §2 dash-form separator stays unambiguous.

**Command tokens.** A command name is one token `[a-z0-9-]{1,32}`. The command is a validated
subject token so the broker enforces per-command authority (§13.9). `describe` and `cancel`
are reserved command names (§13.7, §13.6).

**Request subjects.** Three **addressing modes** under one kind `ep` — the mode token says
where a request routes, never which verb it is (the verb rides the envelope, §13.3/§13.5):
`one` (queue-group anycast: exactly one class member), `all` (scatter: every instance),
`inst` (one instance by its stable triple). The `one` rail's queue group is canonically
named by the endpoint-name token, and serve subscriptions to it are **queue-qualified
only** (§13.9): no credential can plain-subscribe the class rail, which is what keeps
per-request nonces visible only to the queue-selected instance. Every request carries the caller as **three**
forge-locked tokens `<owner>.<actor>.<uid>` (principal + lifecycle UID, §13.1) followed by a
caller-chosen unguessable **nonce** token (`[A-Za-z0-9_-]{22,64}`, ≥128 bits of CSPRNG
entropy; one outstanding call per nonce — reuse before the prior call resolves is a caller
error and the reply rail MUST treat the earlier subscription as dead) — always, on calls and
casts alike, so one grant row covers both verbs and no shape is distinguished by counting. A
command whose contract declares it **targeted** carries an **authorization-mode token** and,
per mode, zero to three pinned target tokens between the command and the caller:

| Form | Subject | Tokens |
| --- | --- | --- |
| Class, untargeted | `cotal.<space>.ep.one.<endpoint>.<command>.<owner>.<actor>.<uid>.<nonce>` | 10 |
| Class, `self` | `cotal.<space>.ep.one.<endpoint>.<command>.self.<owner>.<actor>.<uid>.<nonce>` | 11 |
| Class, `owner`/`any` | `cotal.<space>.ep.one.<endpoint>.<command>.<authz>.<tOwner>.<owner>.<actor>.<uid>.<nonce>` | 12 |
| Class, `child`/`ledger` | `cotal.<space>.ep.one.<endpoint>.<command>.<authz>.<tOwner>.<owner>.<actor>.<uid>.<nonce>` | 12 |
| Class, `handle` | `cotal.<space>.ep.one.<endpoint>.<command>.handle.<tOwner>.<tActor>.<tUid>.<owner>.<actor>.<uid>.<nonce>` | 14 |
| Scatter | as class forms with mode token `all` | 10-14 |
| Instance | `cotal.<space>.ep.inst.<endpoint>.<instanceId>.<command>[.<authz>[.<target tokens per mode>]].<owner>.<actor>.<uid>.<nonce>` | 11-15 |
| Reply | `cotal.<space>.ep.reply.<endpoint>.<instanceId>.<epoch>.<owner>.<actor>.<uid>.<nonce>` | 11 |

**Single-owner endpoint names (normative).** An endpoint name binds to exactly ONE owner
(§13.9: operator-provisioned core names, domain-owner-bound reverse-DNS names), so the name
token alone determines the serving owner and instance-addressed subjects carry **no owner
tokens**: `(endpoint, instanceId)` is the complete routable instance address. Two parties
wanting the "same" name use their own reverse-DNS names; an owner-qualified shared-name form,
if ever wanted, would be a later additive subject form, not a change to these. This is a
deliberate decision (E7b, approved by the space of this plan's owner) trading an
already-forbidden expressiveness for structurally smaller subjects and credentials.

The target's **lifecycle UID is body-carried, not a subject token** (`target.lifecycleUid`,
§13.3): a grant could only ever wildcard it (targets are dynamic; the UID is unknowable at
mint time), so a token there would add zero broker enforcement while costing every targeted
grant row a token — the trusted validator, not the broker, compares the expected UID against
the current mapping (§13.1). The one exception is `handle` mode: at handle redemption the
target's UID IS known and current, so the redemption-minted form pins the full target triple
as subject tokens (below) — pin what is knowable at mint time; body-carry only what is not.
Every form stays within the NATS 16-token recommendation.

**Explicit discrimination (never arity counting).** The forms are distinguished by the token
after `<command>`: it is either one of the six reserved authorization-mode tokens (`self`,
`owner`, `any`, `child`, `ledger`, `handle`) or the caller's owner token — and the two sets
are disjoint by construction, because an owner token is `local` or `u_`+base32 (§2), never a
bare mode word. The target-block arity then follows the mode (`self`: none;
`owner`/`any`/`child`/`ledger`: one `<tOwner>` token; `handle`: three —
`<tOwner>.<tActor>.<tUid>`) — a closed set at a fixed position, exactly the property that
makes per-mode arity safe. A parser dispatches on that set; a subject matching no defined shape
has no sender and MUST NOT be handled.

**Token bounds (normative).** On the endpoint rails every identity token is bounded:
`owner` ≤ 64, `actor` ≤ 64, `command` ≤ 32, `endpoint` ≤ 64, nonce and ids ≤ 64 characters;
`lifecycleUid` and `instanceId` are bounded by their single defining grammar
`[a-z0-9]{26,32}` (§13.1) — deliberately not restated here, so the bound cannot drift from
the definition. A total request or reply subject MUST NOT
exceed 1024 bytes; implementations validate fail-loud at build time. (Transport headroom:
the reference deployment raises `max_control_line` to 64 KiB; the PUB line is never the
binding constraint — minted-credential size is, §13.9.)

**The authorization-mode token** (`<authz>`) makes the authority gradient explicit and
broker-enforced where it is statically expressible, and honestly validator-primary where it is
not. Six modes:

- `self` — the target IS the caller: the form carries **no target tokens and no body
  `target`** (a supplied one is `target-mismatch`, never ignored); the endpoint derives the
  target from the broker-authenticated caller triple in the same subject. Fully
  broker-confined — including the lifecycle UID, because the caller's own `<uid>` token is
  the target's UID, forge-locked by the mint: a stale lifecycle's credential cannot even
  publish the successor's subject.
- `owner` — owner-domain: the target block is `<authz>.<tOwner>` (ONE target token); grants
  pin `<tOwner>` to the caller's own owner (standing mints; a handle redemption instead pins
  the issuer-signed target owner, §13.6). The target actor and expected lifecycle UID are
  body-carried (`target`) and validator-checked against the current mapping — the broker
  cannot express "any actor under my owner, currently mapped to this UID". An `owner`-mode
  grant is NEVER minted with a wildcard target owner. Broker-confined on the owner; validator
  on the rest.
- `any` — unrestricted target owner (`<authz>.<tOwner>` with `*`): a distinct mode mintable
  only for operator/admin capabilities, so no widening of an `owner` grant can ever reach
  it. Validator-checked target as for `owner`.
- `handle` — **redemption-minted only** (§13.6): the target block is
  `handle.<tOwner>.<tActor>.<tUid>` (THREE target tokens), each a literal pinned at
  redemption from the issuer-signed grant against the then-current mapping. Never a standing
  capability, never wildcarded. Broker-confined on the full target triple; the validator
  re-checks only currency — a subject `<tUid>` that no longer matches the current mapping is
  `expired`.
- `child` — static-mesh own-child (`spawner == caller`): a **distinct trusted-validator form**.
  The grant means "may ask this validator", not "already authorized"; the handler MUST
  fresh-check the immutable spawner relation against durable state and fail closed. Its
  `<tOwner>` ceiling is the caller's own owner, as for `owner` mode (a static-mesh child
  shares its spawner's owner).
- `ledger` — fresh-ledger escalation: a distinct trusted-validator form; the handler MUST
  fresh-read the authorization ledger and fail closed on lookup failure, timeout, or absence.
  Its grants pin literal `<tOwner>` values named at mint; a wildcard target owner in `ledger`
  mode is mintable only for operator/admin profiles.

`any`, `child`, `ledger`, and `handle` are never wildcard-reachable from a `self`/`owner`
grant (distinct token ⇒ distinct subject ⇒ distinct grant row). A handler MUST resolve the target — the
revision-pinned `(alias, lifecycleUid)` mapping (§13.1) — immediately before effect and reject
any request whose body target disagrees with the subject target tokens (`target-mismatch`) or
whose expected target lifecycle UID does not match the current mapping (`expired`). The
subject, never the body, is the authorization boundary; handler policy only narrows.

**Replies.** Every reply rides the dedicated reply rail above, **deterministically derived
from the authenticated request subject**: the responder copies the caller triple and nonce
from the request subject and prefixes its own endpoint/instance/epoch tokens (the owner is
determined by the endpoint name; no owner tokens appear). A responder
MUST ignore any transport- or payload-supplied reply target (the confused-deputy boundary).
The grants are exact-arity — no `>` tail admits subjects outside the grammar: the caller's
read grant is its own rail (`ep.reply.*.*.*.<owner>.<actor>.<uid>.*`), so it reads only
replies addressed to it; the responder's publish grant pins its own instance triple and
epoch (`ep.reply.<endpoint>.<iId>.<epoch>.*.*.*.*`), so the answering instance and
epoch are read off the broker-authenticated reply subject, never trusted from the payload.
Two properties, enforced differently — stated precisely: **attribution** (who answered) is
broker-enforced by the responder's pinned prefix; **addressing** (whom a responder may
answer) is capability-by-secret — the responder's grant spans all caller suffixes, and what
confines it to the requester is possession of the unguessable per-request nonce, which only
the request's recipients hold. A stale process (superseded epoch) publishes attributably
stale replies that callers reject; scatter gathers additionally reject replies from
instances outside the frozen expected set (§13.5). The **caller's** process epoch is
deliberately NOT encoded in the rails: reply consumption binds to the requesting process
because a caller MUST subscribe the exact concrete nonce subject before publishing a call
and MUST NOT persist nonces — a restarted successor never holds the predecessor's nonce
subscriptions, so in-flight calls die with the process (they are ephemeral by definition)
and a late reply is unreadable rather than misdelivered.

**Event and journal subjects.** Endpoint-published planes, captured by per-space streams
(§13.12); the publishing instance's identity is forge-locked into the subject:

| Plane | Subject |
| --- | --- |
| Events | `cotal.<space>.epe.<endpoint>.<instanceId>.<epoch>.<topic...>` |
| Canonical facts | `cotal.<space>.epf.<endpoint>.<topic...>` |
| Submissions | `cotal.<space>.epj.<endpoint>.<command>[.<authz>[.<target tokens per mode>]].<owner>.<actor>.<uid>` |
| Timers | `cotal.<space>.ept.<endpoint>.<instanceId>.<epoch>.<timerId>.<schedule\|armed\|fire>` |
| Record writes | `cotal.<space>.epr.<endpoint>.<instanceId>.<epoch>.<kind>.<qualifier...>` (mediated record-writer ingress — the instance's epoch-pinned rail for `svc`/`goal`/`cp` status writes; consumed ONLY by the record writer, which reads the writing epoch from the broker-authenticated subject, never from payload, §13.9) |
| Contract artifacts | `cotal.<space>.epc.<digest-hex>` (one immutable artifact per subject; `<digest-hex>` is the artifact's SHA-256 hex, 64 chars — the `sha256:` prefix is not a subject token; §13.7) |
| Work pools | `cotal.<space>.epw.<endpoint>.<pool>.<cOwner>.<cActor>.<cUid>.<id>` (one item per subject; the trailing four tokens are the item's **acceptance identity** — the accepted submission's caller triple + request id, §13.6) |
| Sessions | `cotal.<space>.eps.<endpoint>.<sessionId>.<epoch>.<in\|out>` |

Events carry the publishing instance's **epoch as a subject token**, pinned by the serve
grant, so a superseded process cannot emit progress indistinguishable from the current
incarnation's — readers match the current (or goal-accepted) epoch and treat stale-epoch
events as attributably stale. A **targeted** journal command carries the same authz/target
block in its submission subject as its request forms, so the broker confines targeted
journal work exactly as it confines calls; the canonicalizer additionally requires exact
body/subject agreement before acceptance. Timers use three forms: `.schedule` is the
instance-published **schedule request** — captured by a stream with message schedules
DISABLED, so any client-set scheduling header is inert bytes, and the mediated timer writer
rejects a request carrying one; `.armed` holds the **authoritative schedule message**,
published only by the mediated timer writer (§13.9), which derives the ADR-51
`Nats-Schedule-Target` — the sibling `.fire` subject — from the broker-authenticated
REQUEST subject's own tokens, never from any payload or header (a schedule's target MUST
differ from its publish subject per ADR-51; replacement is the writer's same-subject
publish on `.armed`); `.fire` is where fires appear. An instance's serve grant covers
**only `.schedule`** (epoch-pinned) — no client credential holds `.armed` or `.fire`
publish; fired messages are written by the broker's scheduler alone, and the handler
validates the carried `(timerId, generation)` against current status AND
`now ≥ the authoritative deadline` AND that the broker-authored scheduler-origin header
names its own exact sibling `.armed` subject (§13.12) before acting.

Reserved event topics: `ev.<cluster>.<event>` (cluster events), `goal.<cOwner>.<cActor>.
<cUid>.<goalId>.<t>` (per-goal action progress; the caller identity in the subject gives
mint-time read containment), `cp.<token>.<t>` (checkpoint transitions). Reserved fact topics:
`dec.<cOwner>.<cActor>.<cUid>.<id>` (canonical decisions — accepted/rejected — caller-scoped, §13.4), `quar.<sourceSeq>` (poison quarantine, §13.4 — its own family,
disjoint from the caller-id `dec` namespace by construction), `goal.<cOwner>.<cActor>.<cUid>.<goalId>.result` (terminal
results), `wrk.<pool>.<cOwner>.<cActor>.<cUid>.<id>` (per-work-item terminal results,
keyed by the item's acceptance identity, §13.5/§13.6), `cp.<token>` (one-use checkpoint
resume, journaled by create-only CAS, §13.6), `receipt.<cOwner>.<cActor>.<cUid>.<id>`
(caller-scoped — request ids are caller-chosen, so an endpoint-wide `receipt.<id>` would
let two callers collide and read each other's receipts). Submissions are publishable directly by capability holders
and are **explicitly untrusted** (§13.4); canonical fact subjects are publishable only by
their mediated writer (§13.9). `<id>`, `<goalId>`, `<timerId>`, `<token>`, `<sessionId>` are
single tokens `[A-Za-z0-9_-]{1,64}`.

The v0 subjects `cotal.<space>.ctl.>` and `cotal.<space>.control.>` are retired: nothing
serves them and no post-cut credential carries a grant on them. `trace.<instance>` remains reserved,
unchanged. `<pool>` is a single token `[a-z0-9-]{1,32}` (command-token grammar).

### 13.3 Envelope

Requests, replies, submissions, events, facts, and progress payloads are UTF-8 JSON. The
envelope is versioned and typed; `ControlRequest`/`ControlReply` are deleted.

`EndpointRequest`:

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `v` | `1` | MUST | envelope schema version (independent of the wire `protocolVersion`; the envelope starts at its own v1 inside the v0.4 revision); other values rejected (`unsupported-version`) |
| `id` | string | MUST | caller-chosen request id, `[A-Za-z0-9_-]{1,64}`; the idempotency key at the declared scope (§13.8), realized on journaled planes by the caller-scoped decision CAS (§13.4) — never by a transport header |
| `op` | object | MUST | `{ endpoint, command, inputDigest, outputDigest }`; MUST agree with the subject (`op-mismatch`). The digests bind the invocation to the described contract and are **both REQUIRED on every command except `describe`** (the discovery bootstrap) — unconditional, because every command declares both schemas: a side with no payload declares the canonical void schema (§13.7), whose digest exists like any other. A serving member rejects a missing digest (`contract-mismatch`) before any effect, and one that cannot honor a pinned digest replies `contract-mismatch`, never coerces |
| `class` | `ephemeral` \| `journal` | MUST | the submission's declared delivery contract; MUST equal the command's contract class (`class-mismatch`); immutable per submission. (`record` is a state contract, never a request class; the action composite is a command marker, not a class — an action command's submissions are `journal`) |
| `replyExpected` | boolean | MUST | the verb: `true` = call (a reply is expected on the reply rail; `deadlineMs` required; the caller subscribes its exact nonce before publishing), `false` = cast (fire-and-forget; a responder MUST NOT reply). The subject shape is identical for both — the verb never changes the grammar |
| `goalId` | string | action commands | MUST for a command whose contract declares the action composite: the client-generated goal id (§13.6); absent otherwise. `id` remains the per-request idempotency key |
| `target` | object | per mode | `{ owner, actor, lifecycleUid, mappingRevision? }`. **Absent for `self`** (and for untargeted ops): a supplied one is `target-mismatch`, never ignored. **Required for `owner`/`any`/`child`/`ledger`/`handle`**: `owner` MUST equal the subject `<tOwner>` token (`target-mismatch`); `actor` and `lifecycleUid` are validator-compared against the current mapping (`expired` on mismatch) — and in `handle` mode MUST additionally equal the subject `<tActor>`/`<tUid>` tokens (`target-mismatch`); `mappingRevision`, when present, additionally pins the exact mapping revision the caller observed |
| `args` | object | MAY | validated against the input schema before any effect (`bad-request`) |
| `from` | `EndpointRef` | MUST | as §5; `from.id` MUST equal the subject sender principal, and the sender UID token MUST match the caller's minted lifecycle UID (broker-enforced by the grant) |
| `deadlineMs` | number | MUST for call/scatter and journal submissions | caller deadline budget; bounded, never unbounded. On a journal-class submission it is the **decision deadline**: the bound within which the caller expects its durable decision fact (§13.4) |
| `correlation` | object | MAY | `{ traceparent?, tracestate?, baggage? }` per W3C Trace Context; propagated to downstream calls, events, facts, receipts |
| `auth` | string | MAY | opaque signed authorization-context slot (capability handle, obligations, payment proof). Opaque to the transport, never to identity: its **`authDigest`** (§13.4 fingerprint) is `sha256:<hex>` over the UTF-8 bytes of this string **exactly as carried** — the slot is already a canonical signed artifact, so it is digested as bytes, never re-canonicalized — and is absent from the fingerprint iff `auth` is absent |

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

Every other plane is typed too: a journaled **submission** is an `EndpointRequest` (same
envelope, published to `epj`); an **event** (incl. per-goal progress) is
`{ v: 1, topic, ts, data, correlation? }`; an **acceptance fact** is the `AcceptanceFact` of
§13.4; a **terminal result fact** carries the goal's terminal state (one of the five
terminal values of §13.6), outcome digest, and
result payload (or its digest-pinned reference). All are runtime-validated at their
consuming boundary.

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
add codes only under reverse-DNS. A `code` — catalog or extension — is one token of at
most **64 bytes**, so every fact shape that embeds one (`RejectionFact`, `QuarantineFact`)
stays bounded by construction and the §13.12 fact fixture is a true worst case.

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
race is a loud `conflict`. The merged logical read returns both
revisions and carries `status.observedSpecRevision`; a reader treats
`observedSpecRevision < spec.revision` as a stale-but-valid level-triggered projection, not
an error, and `observedSpecRevision > spec.revision` (a lagging spec read, possible across
replica freshness points) as its own signal to re-read the spec key — bounded retries until
caught up or the caller's deadline, never trusting the mismatched pair. Watch delivers
current values then deltas per key; a watcher that falls behind MUST re-read both keys and
resume, never patch forward across a gap. Records are
bounded (§13.8).

**Journal** — an explicitly **untrusted at-least-once submission log** feeding **canonical
accepted-fact subjects** with a mediated writer; effects consume only canonical facts, never
raw submissions.

1. A journaled submission is published to the submission plane (`epj`) as a **plain append**:
   submitters MUST NOT set `Nats-Msg-Id`, and native dedupe is **not relied upon** — the
   server does not accept a zero duplicate window (§13.12), so the reference config sets the
   server minimum and the guarantee rests on the header rule, not the window: a conformant
   submission carries no dedupe header and cannot be suppressed by one. Native broker dedupe
   keys on a caller-set header value compared
   **stream-wide**, so on a shared submissions stream any writer could pre-seed a predicted
   header value from its own allowed subject and silently suppress another caller's first
   submission for a full dedupe window — a cross-caller denial that no "advisory" framing
   makes safe; with the MUST NOT in force, a hostile header-bearing publish can suppress only
   another non-conformant header-bearing write. Transport retries therefore simply append
   again; the caller-scoped decision
   CAS below resolves every copy to one decision. Submission subjects and fact subjects are
   disjoint by construction (§13.2), so a submission credential cannot write a fact.
2. The **semantic fingerprint** covers every effect-defining dimension — the fingerprint
   object is `{endpoint, command,
   class, authz?, target?: {owner, actor, lifecycleUid, mappingRevision?}, inputDigest,
   outputDigest, args, authDigest?, caller: {id, lifecycleUid}, goalId?, id}` — and the
   fingerprint VALUE is that object's `sha256:<hex>` content digest per §13.7 (strict
   RFC 8785 over I-JSON — the SAME canonicalization every contract artifact uses; one
   canonicalizer, never a second): absent optional fields are OMITTED from the object, never
   written `null`, so two implementations digest identical bytes — which also makes the
   fingerprint **computable for EVERY parseable submission**, however incomplete: a
   parseable envelope missing `class` or digests fingerprints the subset it carries and is
   rejected with that fingerprint; only unparseable bytes or an invalid `id` lack one and go
   to quarantine. Same id +
   same fingerprint is the same request (idempotent, first-wins); same id + different
   fingerprint — including the same args retargeted at a different lifecycle — is a loud
   `conflict`, never accepted or effected.
3. The **canonicalizer** — the narrowly scoped mediated writer for this endpoint's facts
   (§13.9) — consumes the submission plane through a **normative durable `AckExplicit`
   consumer** and acks a submission ONLY after a durable decision fact exists — and, for a
   pool-admitted acceptance, ONLY after the §13.6 EPW enqueue create has additionally
   succeeded (or lost its CAS to an already-present entry): a crash anywhere between
   acceptance and enqueue therefore redelivers the submission, and the reconciliation
   predicate resolves the redelivered copy — recovery never has to DISCOVER orphaned
   acceptances, because an acceptance without its enqueue is by construction an unacked
   submission that comes back. A crash before
   the fact redelivers the submission; a crash after it observes the CAS winner on
   redelivery. It validates each submission (schema, body/subject agreement incl. the target
   block, authorization per §13.6, and — for work-pool commands — pool admission/capacity
   BEFORE acceptance) and then decides each request exactly once by publishing a
   **decision fact** to the caller-scoped subject
   `epf.<endpoint>.dec.<cOwner>.<cActor>.<cUid>.<id>` with create-only CAS (expected last
   sequence on the subject = 0), so distinct callers can never squat each other's ids.
   The decision is `accepted` or `rejected` (with the catalog error) — **rejection is as
   durable, caller-readable, and idempotent as acceptance**, so a permanently invalid
   submission is distinguishable from a lost one. First decision wins atomically; a later
   attempt fails its CAS and reads the existing fact. There is no append-then-memo pair to
   crash between. The canonicalizer is a **singleton per endpoint** (one active principal,
   epoch-fenced like any serve identity, recovered through the §13.1 takeover barrier):
   admission checks — pool capacity for work-pool commands — are thereby serialized with the
   decisions they gate, so two canonicalizers cannot both admit the last slot; capacity is
   consumed by the acceptance itself, never checked apart from it. A submission that cannot
   yield a decision key — unparseable bytes, or no `id` within the token grammar — is
   **quarantined, never redelivered forever**: the canonicalizer publishes a
   **`QuarantineFact`** to the disjoint quarantine family
   `epf.<endpoint>.quar.<sourceSeq>` (§13.2) — keyed by the source sequence, which exists
   for every stored copy by construction, in a family that shares no namespace with
   caller-chosen `dec` ids, so no legal request id can collide with a quarantine key — with
   create-only CAS, and terminally acks
   (`AckTerm`) the submission ONLY after that fact durably exists (or its CAS loss shows it
   already does), so a poison message cannot pin `MaxAckPending` and the
   fact-before-terminal-ack rule holds on the poison path exactly as on the decision path.
   `QuarantineFact` = `{ v: 1, decision: "quarantined", sourceSeq, submissionDigest (the
   `sha256:<hex>` digest of the raw stored bytes, §13.7), error: { code (catalog token),
   detail? (≤ 256 bytes) }, caller?: { id, lifecycleUid } (from the broker-authenticated
   submission subject, when it parses), ts }` — every field bounded or fixed-size, so the
   fact fits by construction; it never carries the poison bytes themselves.
4. Journal submissions set `replyExpected: false`; the caller **observes its decision** by
   watching/reading its own decision subtree (`epf.<endpoint>.dec.<its triple>.>` — a
   caller-scoped read grant minted with every journal capability). An action command's
   accept/reject is exactly its decision fact, expected within the submission deadline.
5. The **acceptance fact is self-sufficient for effect and replay** (`AcceptanceFact`, the
   `accepted` decision): `{ v: 1, id, decision: "accepted", fingerprint, request: <the
   canonical EndpointRequest, args INLINE — bounded by the broker's max_payload; a submission
   too large is refused loudly with resource-exhausted, never spilled into storage>, caller:
   {id, lifecycleUid}, target?: {owner, actor, lifecycleUid, mappingRevision},
   contractDigests: {input, output}, authzDecision: {revision, epoch},
   readinessDeadlineMs?: <the acceptance-relative readiness bound, present iff the command
   declares bounded readiness, §13.6 — persisted HERE because it is goal state, not the
   request's decision deadline>, sourceSeq, ts }`. The
   canonicalizer preflights the **serialized decision fact** — not merely the inline args —
   against `max_payload`: a submission whose acceptance fact would not fit is rejected
   `resource-exhausted`, and the rejection fact always fits by construction — every field
   is bounded or fixed-size (the operator floor assertion covers the maximum serialized
   rejection/quarantine fact, §13.12):
   `RejectionFact` = `{ v: 1, id, decision: "rejected", fingerprint, error: { code (catalog
   token), detail? (≤ 256 bytes) }, caller: {id, lifecycleUid}, authzDecision?: {revision,
   epoch}, sourceSeq,
   ts }` — the fingerprint and the catalog error, never the args (a parseable submission
   always yields the fingerprint; the unparseable/no-id case is the QuarantineFact above,
   which requires neither `id` nor `fingerprint`). Digest-pinned
   references inside a fact may name **only already-published public contract artifacts**,
   never per-request payloads: the contract store is public, immutable, and permanent —
   the opposite lifecycle of private, horizon-bounded request content (a large-payload
   facility, if ever needed, is its own future primitive with its own store, retention, and
   §13.9 rows). Effects and replay read the fact, never the raw submission (a TOCTOU re-read
   of the untrusted log is non-conformant).
6. Decision facts/tombstones are retained at least the declared **idempotency horizon**
   (default 24h, space-configurable) AND longer than the maximum submission-log retention
   plus recovery/redelivery lag — otherwise a rebuilt canonicalizer could re-accept an old
   submission still sitting in the log as new work. The horizon is **realized by decision
   retention, not by a clock**: the create-only CAS returns the recorded decision for exactly
   as long as the fact exists, and a reused id becomes new work only once retention has
   evicted the old fact and freed its subject — there is no separate time rule for the CAS
   to disagree with. The canonical subjects are the authority (D12) for anything
   auditable, metered, compensated, effected, or replayed. Ordering is per-subject;
   consumers never assume cross-subject order.

**Events are not facts.** Cluster events and per-goal progress (`epe`) are direct,
epoch-fenced, instance-published notifications on a durable, ordered, replayable stream —
that is the sense in which they ride the journal contract. They do NOT pass through the
canonicalizer, carry no acceptance semantics, and MUST NOT drive effects that require
canonical acceptance; anything auditable/metered/compensated goes through submissions and
facts.

### 13.5 Verbs

- **call** — bounded request/reply (`replyExpected: true`, `deadlineMs` mandatory). On the
  `one` rail it is queue-group anycast; on `inst` it addresses one stable instance. No
  responder → `unavailable`.
- **cast** — the same subjects and grants (`replyExpected: false`): fire-and-forget,
  at-most-once, the responder MUST NOT reply and the caller never reads the rail (the nonce
  is present but unused). A cast to a journaled command is `class-mismatch`; journaled work
  goes through submissions.
- **watch** — observe a record (KV watch; fell-behind ⇒ re-read, §13.4) or an event topic
  (live subscription within the read grant plus filtered replay from the event stream).
  Per-key and per-goal subjects carry read containment; a watch grant names the exact subtree.
- **claim** — competitive at-most-one-winner acquisition from a durable work pool (`epw`),
  **owner-mediated**: the pool's owning endpoint holds the pool's single `AckExplicit` pull
  consumer (§13.12); workers hold **no** JetStream grant on the pool and acquire, renew, and
  settle work exclusively through the owning endpoint's reserved **`lease`** and **`commit`**
  commands on the ordinary `ep` rails. This is the only shape that satisfies both claim
  invariants at once: the delivery's ack token never leaves the party allowed to use it, and
  the attempt binding is **owner-recorded at assignment** rather than asserted by the worker
  (a worker-carried "sequence + attempt" proves nothing about delivery; an owner assignment
  does). The stored pool message is **work identity and input only — never the authoritative
  lease**: broker redelivery re-delivers the same stored bytes, so a token in the payload
  cannot fence, and the consumer's `ack_wait` is the broker's redelivery-to-owner timer only,
  never the lease. `lease` (call): the owner fetches the next stored item and records the
  lease `{item, sourceSeq, attempt: the delivery count, worker: the broker-authenticated
  caller (principal + lifecycle UID, plus epoch for endpoint workers), fencingToken,
  leaseDeadline}` in its `lease` record (key grammar §13.7, writer table §13.9) by
  **first-wins idempotent CAS per (item, attempt)** — a duplicate or
  delayed `lease` call for a still-current attempt returns the SAME lease; an attempt is
  superseded once redelivery advances the delivery count; `fencingToken` is CAS-incremented
  per attempt and `leaseDeadline` comes from the owner's own clock. Expiry revokes the claim
  at that deadline even before reassignment. Every Cotal-owned commit from claimed work is
  submitted through the reserved **`commit` command** carrying the exact lease tuple; the
  handler validates token currency AND unexpired lease against its own clock AND that the
  caller is the lease's bound worker, then performs an **atomic, idempotent per-item CAS to
  a cached terminal result** — the per-item terminal fact
  `epf.<endpoint>.wrk.<pool>.<acceptance identity>` (§13.2), create-only CAS per item —
  under its mediated writer credential (§13.9): a committed item
  can never be leased again, a duplicate commit returns the cached terminal outcome, and a
  raced commit loses loudly. Only after observing the committed terminal state does the
  owner ack the WorkQueue message — it holds the delivery natively, so the deletion
  capability is never transferred, and no worker-side ack can destroy an item whose commit
  was rejected. A lost owner ack merely redelivers the item to the owner, which observes the
  committed terminal state and acks again: **settled work is never re-enqueued as new** (the
  durable bridge is the acceptance fact plus the per-item terminal CAS; an accepted item
  with no terminal result and no live pool entry is the only re-enqueueable state, §13.6). A
  stale token, expired lease, or superseded worker is `expired`/`conflict`; workers hold no
  bypass write.
- **scatter** — a request on the `all` rail. The caller freezes a **request-scoped expected
  set** — the live instances of the class from the service registry, each as
  `(instanceId, registrationRevision, epoch)`, where `registrationRevision` is the store
  revision of the instance's `svc….spec` record key (§13.7: it advances only on mediated
  registration writes, and the record read/watch grant that freezes it is a §13.9 matrix
  row) — at send time. Gather accepts at most one
  terminal reply per expected `instanceId`, attributed from the reply subject **including its
  epoch** (§13.2): a second reply from the same `(instanceId, epoch)` is classified
  `duplicate` and **reported, never silently dropped** (first reply wins); a reply from a
  frozen `instanceId` at a different epoch — or an observed registration-revision advance —
  is classified `churn` (the instance restarted mid-scatter and may never have seen the
  request) and does not count toward completion; replies from outside the frozen set are
  classified `unexpected` and never count toward completion. Completion is
  all-expected-replied or deadline, in which case the result is explicitly partial with
  `missing` / `churn` / `unexpected` / `duplicate` / `late` classifications (a churned slot
  reports as `churn`, not `missing`). An empty or unreadable registry is
  `failed-precondition`, not an empty success. Deadline mandatory.

### 13.6 Composites

Patterns over the verbs and contracts; zero new transport.

**Action** — a long-running command. `action` is a command **marker**, never a class: an
action command's submissions are `class: journal` (§13.3).

1. The caller submits with a client-generated `goalId` and the request fingerprint (§13.4).
   Accept/reject is the durable decision fact (§13.4), expected within the submission's
   decision deadline — there is no reply-rail answer to recover.
   **Authorization linearizes at acceptance**: the acceptance fact persists the caller and
   target lifecycle tuples, command + contract digests, and the authorization decision
   revision/epoch it was made under. A scope narrowing before acceptance rejects the goal;
   after acceptance it blocks *new* goals but an accepted goal continues — unless the
   command's contract declares **continuous reauthorization**, in which case each declared
   checkpoint re-validates and deterministically transitions to `cancelling`/`failed`
   (`permission-denied`) on narrowing. Handle expiry/revocation mid-goal follows the same
   declared policy.
2. States: `accepted → running ⇄ waiting → succeeded | failed | cancelled | expired |
   uncertain`, with
   `cancelling` between a cancel and its terminal state. This is the **single status
   vocabulary** for every long-running surface. All five of `succeeded`, `failed`,
   `cancelled`, `expired`, and `uncertain` (item 6) are **terminal**, and first-terminal-fact-wins
   applies uniformly: `uncertain` is not an absence of an outcome, it is the outcome
   "this action's success signal did not arrive within its readiness deadline".
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
   arrive within its readiness bound declares a **readiness deadline** — a distinct,
   acceptance-relative bound persisted in the acceptance fact/goal state, NOT the
   submission's `deadlineMs` (which bounds only the decision, §13.3). Spawn readiness is
   the reference case: its readiness deadline is **30 s** — the migrated presence-or-exit
   backstop, D29; every legacy spawn-timeout consumer converges on this single bound. When
   the deadline passes without the signal, the owner records the goal's terminal **result
   fact** (`goal….result`, §13.2) with the outcome
   `uncertain` — and the goal IS terminal: `uncertain` is a terminal outcome like
   `succeeded`/`failed`, immutable, first-terminal-fact-wins as for any goal (there is no
   call and no reply rail here: an action is a journal submission, and the result fact IS
   the caller-visible outcome, item 5). The underlying ENTITY's later convergence
   (ready/exited) is observable on that entity's own status record (`svc….status`, the
   lifecycle mapping) — a caller that needs the eventual answer watches the entity, never
   the goal; the goal is not rewritten and its status does not linger non-terminal.
7. Goals bind the target's `(principal, lifecycleUid)` (§13.1): a goal accepted against a
   lifecycle is not redeemable, cancellable, or effectful against a same-name successor. A
   restarted instance (same `instanceId`/UID, advanced epoch) recovers its goals from journal
   + records; a superseded epoch cannot commit transitions.

**Awaitable checkpoint** — one durable pause primitive (approvals, guard holds, payment
authorization). A waiting action mints a checkpoint: a durable token persisted with the goal,
a `waiting` status carrying the checkpoint id and its **deadline generation**, and a durable
timer (§13.12). Deadlines are mandatory. Heartbeat/extension CAS-advances the generation in
status, then replaces the timer (a new `.schedule` request; the mediated timer writer's
same-subject `.armed` publish is the server rollup, §13.2/§13.12 — the 2.14 atomic
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
instanceId?, commands: [{ name, authz?, targetOwner?, targetActor?, targetLifecycleUid? }],
reads?: [<record-key or event-topic subtree>] }], iat, nbf?, exp, parentDigest?, sturdy,
epoch?, sig }`

A grant entry carries **every subject-level dimension** a capability has (§13.9): a targeted
command names its authorization mode and target components; read scopes name exact
record-key / event-topic subtrees. The per-command target tuple is a **closed set of three
legal shapes** — no target components; `targetOwner` alone; or the full triple
`{targetOwner, targetActor, targetLifecycleUid}` — and **every other combination is
schema-invalid** (`contract-invalid`): in particular `targetActor` without
`targetLifecycleUid` (a handle that pins a recyclable alias component MUST pin the lifecycle
it means) and `targetLifecycleUid` without `targetActor` (a lifecycle restriction with no
compile target would otherwise be silently DROPPED into an owner-wide grant — a partial
tuple never weakens into a broader one). The normative compiler maps a grant entry to
exactly the subjects the equivalent minted capability would receive — never wider — it MUST
consume every present signed component (a component the compile target cannot express is
schema-invalid, never ignored), and every legal entry HAS a compile target:

- a **no-target** entry compiles to the untargeted or `self` form per the command's
  contract; an `authz` field on it is schema-invalid.
- an **owner-domain** entry (`targetOwner` alone) compiles to the mode its `authz` field
  names — `owner` (the default), `child`, or `ledger`, and NOTHING else: each pins the
  signed `targetOwner` in that mode's own subject form (§13.2), **never collapsing `child`
  or `ledger` to `owner`** (the modes are distinct validator-primary rails and rewriting
  one into another widens authority), and **`authz: "any"` is schema-invalid in a handle
  grant entry** (`contract-invalid`): the `any` rail is operator-ceiling authority, minted
  only as a standing capability under an operator-scoped anchor (§13.10), never conferred
  or attenuated through a handle — a compiler therefore has no `any` case, and no
  implementation choice exists between rejecting, literalizing, or widening it.
- an **actor-pinned** entry (the full triple) compiles to the `handle`-mode form pinning the
  full signed triple `<targetOwner>.<targetActor>.<targetLifecycleUid>` (§13.2); an `authz`
  field on it is schema-invalid (the triple IS the mode).
- an **instance** entry compiles to
  the exact `ep.inst` rails — complete, because `(endpoint, instanceId)` is the whole instance
  address and instance ids are never reused (§13.1).

A capability that cannot be represented in this shape MUST
NOT be carried by a handle.

- **Two uses, both fail-closed.** *Attenuation:* presented in the `auth` slot, a handle only
  narrows — the handler enforces `effective = presenter-cred ∩ handle.grants ∩
  issuer-authority`, and additionally requires any signed target triple to match the
  request's target and the current mapping (`expired` on mismatch); it never confers broker
  reach. *Conferral:* a handle grants reach only by **redemption through the trusted auth
  path** (the exchange/callout of §9/§10), which verifies the signed target triple against
  the current mapping **at redemption time** (`expired` on mismatch) and mints a short-lived
  credential whose grants are the intersection of issuer authority, handle grants, and the
  redeeming holder's current lifecycle + credential — actor-pinned grants compile to
  `handle`-mode subjects carrying the verified triple (§13.2), so a target lifecycle that
  rotates after mint is caught by the endpoint's currency check; no handler-side widening
  exists. The minted credential is **ledgered before release** in the credential ledger
  (§13.1), keyed under the redeeming holder's lifecycle with the FULL presented handle
  chain as its `sourceChain` (plus the per-ancestor `bysrc.` index keys), so
  takeover/retirement barriers revoke it with the family and revoking ANY handle in its
  lineage — parent or leaf — cascades to it. Chain verification itself checks the
  revocation status of EVERY sturdy link in the chain, not only the presented leaf,
  failing closed on any revoked ancestor.
- **Holder-bound:** `holder` names the one `(principal, lifecycleUid)` that may present or
  redeem it; bearer transfer exists only as an explicit issuer-signed re-issue. `space` binds
  it to one space. A recycled alias cannot present its predecessor's handles (UID mismatch).
- **Attenuation chain:** `parentDigest` references the parent handle; a child MUST be ⊆ its
  parent under the **normative containment order** — per grant entry: endpoint within the
  parent's endpoint/domain pattern; `instanceId` equal or newly pinned (never widened to
  absent); commands a name-subset with per-command mode never higher in `self < owner < any`
  (`child`/`ledger`/`handle` are grantable only where the parent names the same mode); target
  components equal or newly pinned; read subtrees subject-prefix-contained — and per
  envelope: same `space`, validity window within the parent's, `sturdy` only if the parent is
  sturdy. The issuer of a child is the parent's holder, anchor-registered with a `handles`
  role whose scope covers the child (§13.10); the same containment order defines issuer-scope
  coverage. Presentation carries the full chain inline (`parentDigest`-linked artifacts
  presented together — no ambient fetch); verification walks every link to a registered
  anchor, failing closed on widening, unknown/revoked keys, or expiry.
- **Sturdy vs live:** live handles (`sturdy: false`) bind the current process `epoch`, are
  never persisted, `exp ≤ 24h`, and die on restart. Sturdy handles bind the lifecycle UID
  (surviving supervised restart), persist as issuer-namespaced `handle.<issuerKeyId>.<id>`
  records (spec create-only; status = revocation state, monotonic; §13.9 writer table), and
  verifiers MUST check revocation (fail closed if unreadable). Max sturdy TTL is
  space-configured (default 30d).
- Handles are reusable within TTL unless a composite declares one-use (checkpoint resume);
  the replay matrix of §13.10 governs every signed artifact.

**Session (bidirectional stream)** — the generic composite for interactive byte/frame
streams (terminal attach is its first consumer; nothing terminal-specific is normative). It
is exactly D26's cast-ingress + watch-egress composed over dedicated per-session subjects —
no new verb and no new transport: the `in` subject is a cast-only rail (caller publishes,
endpoint subscribes) and the `out` subject is a watch rail (endpoint publishes, caller
subscribes). A session is established by an ordinary command whose answer is a **session
grant**: a one-use,
holder-bound handle (live: bound to the caller's lifecycle AND current process epoch —
live authority dies on restart, §13.1, so redemption fresh-checks the holder epoch and an
unredeemed grant does not survive the caller's restart — plus the serving instance epoch) naming a fresh
unguessable `sessionId` and the epoch-pinned session subjects
`eps.<endpoint>.<sessionId>.<epoch>.in` (caller → endpoint) and `….out` (endpoint → caller).
Session subjects are **core-only** — never stream-captured; the bounded flow window lives in
memory and a dropped frame is the composite's problem, not retention's. Redemption mints
exact asymmetric per-session credentials: the caller publishes `in` and subscribes `out`;
the serving instance the reverse; no third party holds either, and no standing wildcard EPS
grant exists. Frames are opaque; flow control is bounded (window declared in the grant;
overflow is `resource-exhausted`, never unbounded buffering). Close is explicit, and
revocation has a **durable** named authority that survives the
serving endpoint: the trusted auth path (the exchange/callout of §9/§10) persists a **session
ledger row** at redemption — key `session.<sessionId>` in the auth store (§13.12), value
`{sessionId, serving instance + epoch, holder (principal + lifecycleUid), both minted
credential ids, state, exp}`, create-only CAS per `sessionId` (this CAS IS the one-use
redemption), state monotonic
(`active → closed | expired | superseded | retired`, all terminal) — and each per-session
credential is simultaneously a credential-ledger row under its holder's lifecycle (§13.1),
which is the index the §13.1 barriers enumerate — and a barrier that revokes a
session-sourced credential MUST resolve its `session.<sessionId>` row, transition it
terminal, and revoke BOTH per-session credentials, so either side's takeover or retirement
tears down the whole pair, not its own half. Redemption's writes are ordered and
crash-recoverable: session row first (the create-CAS IS the one-use), then both credential
rows (gate-checked, §13.1), then release — a crash mid-sequence leaves either a session row
whose `exp` the auth path's expiry sweep collects (revoking whatever credential subset
exists) or unreleased credentials that the gate-abort rule already revoked; no interleaving
releases a live pair the ledger cannot see. The auth path revokes BOTH per-session
credentials with eviction (bounded
propagation) on any of: an **authenticated close input** on the trusted auth path itself —
a defined operation of the SAME exchange/callout surface that redemption already uses
(§9/§10, off-broker, so no broker grant row applies): the caller authenticates as one of
the session's two parties (its lifecycle or per-session credential) or as the operator and
names the `sessionId`; the auth path verifies party membership against the ledger row
before transitioning it. The in-band close frame
is an advisory peer signal, never the revocation authority, because EPS subjects are
core-only and captured by nothing — expiry per the handle rules (`exp` is enforced by the
auth path's own timer, not by the endpoint), or the serving
epoch's supersession / lifecycle retirement via the §13.1 barriers (either side's lifecycle:
holder and serving rows both index the family). Neither side can keep a
half-closed session alive, and a crashed serving endpoint cannot orphan one — the ledger, not
the endpoint, remembers what to revoke. Ledger rows are retained at least the maximum
session `exp` plus a recovery margin. The session dies with the serving instance's epoch
(the epoch is in the subject, so a restarted instance cannot resume it — a durable session is
a new establishment). Routing is authenticated broker routing end to end; there is no loopback URL
or out-of-band transport in the contract, and cross-machine reachability is exactly broker
reachability.

**Virtual endpoints.** An endpoint MAY be virtual: registered (`spec.activation = on-demand`)
with no live instance. A virtual endpoint's commands MUST be journal-class: the buffered
ingress path is the ordinary submission plane (`epj` is durable and needs no live
subscriber), and the canonicalizer — which for a virtual endpoint runs wherever its
activator/owning authority runs — checks pool admission BEFORE deciding (an over-capacity
submission is rejected `resource-exhausted` as its durable decision fact, never accepted and
stranded), then accepts and enqueues the work into the endpoint's `epw` pool. Acceptance and
enqueue span two streams with no atomic bridge, so the enqueue is **idempotent, keyed by the
acceptance identity, and reconciled against a decidable predicate**: the pool subject carries
the acceptance identity and the enqueue is a create (expected-last-sequence-for-subject 0),
so a duplicate enqueue loses its CAS harmlessly; because the pool owner acks only after the
committed terminal state (§13.5), an acceptance fact **with** a terminal result is settled
and never re-enqueued, and an acceptance fact with **no** terminal result and **no** live
pool entry (direct get by the item's subject) is unambiguously never-enqueued-or-lost — the
only re-enqueueable state. A crash after the acceptance CAS but before the enqueue is
repaired by exactly that predicate; an enqueue without an acceptance fact cannot occur
because only the canonicalizer holds the pool-write grant and it enqueues only from its own
accepted decisions. An ephemeral
call to a virtual endpoint with no live instance is an honest `unavailable`; nothing
silently buffers it. An **activator** (holder of its activation capability) watches the pool
and starts an instance; single-writer per identity is fenced by instance-record CAS +
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
MUST NOT occur. Contract identity is the **closure digest** (above): the digest of the
manifest naming the complete resolved closure, not of the root document alone. Registration-time bounds (loud `contract-invalid`, distinct from
invocation-time `bad-request`): document ≤ 256 KiB, closure ≤ 1 MiB, nesting ≤ 32, ref chain
≤ 32, bounded pattern complexity, compile/validation time budgets, and a bounded compiled-schema cache (reference: 256-entry LRU) (§13.8). Runtime
validation at the serving boundary is mandatory: args before any effect, replies against the
output schema. Authoring tooling is free (the reference implementation authors in Zod); the
wire artifact and validation semantics are the JSON Schema documents themselves.
**Every command declares BOTH an input and an output schema**: a side with no payload
declares the **canonical void schema** — the artifact `{"type":"null"}`, whose RFC 8785
digest is therefore one fixed value — so both `op` digests exist for every command (§13.3)
and no shape in this section is conditional on a missing side. Validation against the void
schema means the side's payload is absent or `null`.

**Content addressing.** A contract artifact (cluster document, schema bundle member, trait
definition or attachment) is identified by the SHA-256 digest of its RFC 8785 canonical JSON
(strict RFC 8785 over I-JSON; the reference implementation pins `json-canonicalize`'s strict
path and gates on the RFC's published test vectors, including number-serialization and
surrogate edges). **Two digests, never conflated.** An **artifact digest** identifies ONE
document's bytes and is the value that keys its subject and every by-digest reference. A
**closure digest** identifies a whole resolved bundle — a cluster document or a schema
closure — and is the artifact digest of that bundle's **manifest**: the artifact
`{ v: 1, root: <artifact digest>, members: [<artifact digest>, …] }`, `members` being every
artifact transitively reachable through by-digest references from `root`, sorted
lexicographically and deduplicated. The manifest is itself an ordinary artifact on its own
digest subject, so a closure digest is an artifact digest — nothing dispatches on which kind
a digest is. Contract identity (§13.7 `contractDigest`, `clusterDigests[]`, and the
`op.inputDigest`/`outputDigest` a caller pins) is always a CLOSURE digest; a `$ref`-by-digest
inside a schema is always an ARTIFACT digest.

**Every `*Digest` field in this section is one scalar shape** — `sha256:<hex>`, lowercase
hex — and each names exactly one input, so no field's digest is implementation-defined:
`inputDigest`/`outputDigest`, `contractDigest`, `clusterDigests[]` = the CLOSURE digest of
the named bundle (above); a schema's by-digest `$ref` = an ARTIFACT digest;
`argsDigest`/`outcomeDigest`/`resultDigest` = over the strict RFC 8785 canonical JSON of
that value (absent iff the value is absent); `authDigest` = over the raw UTF-8 bytes of the
`auth` slot as carried (§13.3); `submissionDigest` = over the raw stored submission bytes
(§13.4). Integer fields on the wire (`sourceSeq`, `revision`, `epoch`, `ts`,
`deadlineMs`, `readinessDeadlineMs`) are non-negative integers ≤ 2^53 − 1 — the I-JSON
interoperable range, so at most 16 decimal digits — which is what makes the §13.12
maximum-fact fixture a computable worst case rather than an estimate.

Artifacts live in the per-space **contract stream**: one artifact per
digest-keyed subject `cotal.<space>.epc.<digest-hex>` (§13.2), published as a single
message — possible because a document is bounded at 256 KiB (below) and the operator floor
asserts `max_payload` covers it (§13.12); a closure is fetched artifact-by-artifact through
its digest references, never as one blob. Reads are the subject-scoped last-by-subject
Direct Get on the exact digest subject — no consumer, no replay machinery, and nothing
body-selected (§13.9). Readers MUST verify fetched bytes against the digest and fail loud
on mismatch. Publication is mediated and create-only (§13.9): artifacts are immutable once
published. (This replaces the earlier Object Store binding: chunked objects cannot be read
subject-confined — chunk replay needs a consumer whose delivery target is body-selected,
§13.9 — and single-message digest subjects need none of it.)

**Record kinds and key grammar.** Every record kind is registered: core kinds are defined
by this section (writer table, §13.9), and each kind's registry entry pins its **key
grammar** (the qualifier tokens between the kind token and the `.spec`/`.status` suffix),
its writer roles, and its mediation class — grants and merged watches are derived from that
grammar, so two implementations always agree on which key carries what. The core kinds'
key grammars, pinned here (each key then splits `.spec`/`.status` per §13.4):

| Kind | Key grammar |
| --- | --- |
| `svc` | `svc.<endpoint>.<instanceId>` |
| `signer` | `signer.<keyId>` |
| `handle` | `handle.<issuerKeyId>.<id>` |
| `contracts` | `contracts.<endpoint>` |
| `goal` | `goal.<endpoint>.<cOwner>.<cActor>.<cUid>.<goalId>` |
| `cp` | `cp.<endpoint>.<token>` |
| `lease` | `lease.<endpoint>.<pool>.<cOwner>.<cActor>.<cUid>.<id>` (the item's acceptance identity, §13.2) |
| `lifecycle` | `lifecycle.<owner>.<actor>.<lifecycleUid>` (the §13.1 mapping detail) |
| `lifecycle` head | `lifecycle.<owner>.<actor>` (the alias's CAS head: the single authoritative pointer to the current active `lifecycleUid`, or none — mint CASes it from none/retired-predecessor to the new UID, so two concurrent mints for one alias CANNOT both activate: per-key CAS on separate UID-suffixed keys could never serialize them; terminal retirement CASes it back after the §13.1 barrier) |

Third-party kinds
register under reverse-DNS kind names.

**Descriptor and describe.** Each instance registers a **service record** (kind `svc`, key
`svc.<endpoint>.<instanceId>`; the owner is determined by the name and recorded in the
value): spec = `{ endpoint, owner, endpointType?,
clusterDigests[], protocol: { v: 1 }, activation? }`, status = `{ epoch, state,
observedSpecRevision, … }` (writer table §13.9). The spec key's **store revision is the
instance's `registrationRevision`** — the value scatter freezes (§13.5): it advances only
when the mediated registration path writes the spec key, so an advance during a scatter is
exactly a re-registration. `describe` is a reserved untargeted
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

**Invocation binding.** The digests are not caller courtesy but a two-sided requirement
(§13.3): a caller MUST pin `op.inputDigest`/`op.outputDigest` on every command except
`describe` (the discovery bootstrap), and a serving member MUST reject their absence
(`contract-mismatch`) before any effect — an unpinned invocation cannot silently bypass the
describe→invoke binding — and MUST honor pinned digests or reject `contract-mismatch`. Rolling updates keep classes contract-homogeneous: an incompatible
generation registers a distinct routable identity (new endpoint name or explicit version
label) until homogeneous.

**Traits.** A trait attaches governed metadata to a cluster, command, attribute, or event.
A **trait definition** `{ urn, valueSchema (digest), selector, breakingChanges, authority }`
is content-addressed and signed: `ai.cotal.*` definitions by the space-operator authority;
third-party definitions by their defining owner's registered key. **Attachment authority is
distinct from definition authority**: every *required/governed* attachment (this revision governs
exactly `ai.cotal.guarded` and `ai.cotal.priced`) is separately signed by the definition's
named authority over `{ endpoint, command, contractDigest (the cluster document's complete
closure digest), traitUrn, value }`, so a self-published descriptor cannot strip, forge, or downgrade a governed
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
- **Retention floors.** Submissions ≥ recovery/redelivery lag (§13.12; native dedupe is not
  relied upon, §13.4); facts/tombstones ≥ idempotency horizon;
  results ≥ result retention; receipts ≥ receipt retention; timers ≥ max deadline + recovery
  margin. **Pool coupling:** EPW MUST set a max age — unbounded item residence is
  non-conformant — and a pool item's decision and `wrk` terminal facts are retained ≥ that
  max age + recovery margin, so a live (or crash-recovering) item can never outlive the
  facts that identify it as accepted or settled: a decision that expired under a still-live
  item would let a reused id collide with the old enqueue, and an expired `wrk` under a
  lost owner ack would make settled work unrecognizable on redelivery.
  An endpoint MUST refuse to start against a store below its declared floors.
- **Backpressure and budgets.** Bounded consumer pending (default 1024), bounded
  virtual-endpoint pools and session windows, flow control on watches; overload is
  `resource-exhausted`. Schema compile/validate budgets (reference: 100 ms / 10 ms) and
  bounded regex; over budget is `contract-invalid`/`bad-request`.
- **Timers.** Broker message schedules at the 2.12 floor; same-subject replacement only (at
  the mediated `.armed` subject, §13.12); generation- and scheduler-origin-validated firing
  (stale or foreign-origin ⇒ no-op); durable reconciliation repairs
  status↔schedule divergence; replication and offline-assets downgrade fail loud at the
  broker floor gate.

### 13.9 Authority boundary

The credential is the coarse boundary; every subject in §13.2 is default-deny. Every
**statically expressible** authorization dimension — caller identity + lifecycle, endpoint,
command, the target components each mode pins statically (§13.2: the full triple for `self`,
the caller's own, and for `handle`, redemption-pinned; the owner for
`owner`/`any`/`child`/`ledger`), serve identity, reply
**attribution**, plane writer ownership — is broker-enforced through the subject grammar.
Reply **addressing** is the one deliberate exception: it is capability-by-secret (the
per-request nonce, §13.2), not a broker grant — and it is sound precisely because serve
credentials cannot plain-subscribe the class rail (queue-qualified grants, §13.2), so nonces
are visible only to the instance the queue selected (plus every instance on a scatter, which
is scatter's definition). Target enforcement is stated per mode, never as a blanket claim:
`self` is broker-confined end to end including the lifecycle UID; `handle` is broker-confined
on the full redemption-pinned target triple, with the validator re-checking only mapping
currency; `owner`/`any` are broker-confined on the target owner and validator-primary on the
actor and UID currency; `child`/`ledger` are validator-primary within their distinct broker
rails. The **named dynamic relations** — static-mesh
own-child, fresh-ledger escalation, target-mapping currency, authorization epochs after
acceptance — are trusted-validator-primary by design, fail-closed, and operate only within
the broker ceiling. Handlers only narrow. **The process epoch fences only the five planes
whose subjects carry it** (reply, `epe`, `ept`, `eps`, `epr`). Request-ingress subjects and durable record
keys cannot carry it — the caller cannot know it, and a restart-stable key must not change —
so those two classes are fenced by the mechanism each admits: records by mediation (writer
table below), ingress by credential revocation with verified eviction (§13.1), never by
subject.

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
endpoints; a space MAY narrow it. Because the subject shape is verb-invariant (§13.2), one
publish row covers call and cast of a command. Minted credentials MUST stay within the
deployment's JWT size envelope, and the envelope is validated against a **normative
maximum-capability fixture**, not an adjective: the reference fixture is an agent holding
every baseline grant plus capabilities on 3 endpoints x 12 commands each, each targeted
command in both `self` and `owner` modes, plus journaled submissions and per-goal read
scopes for all of them. Minting MUST fail loud before emitting a credential that exceeds the
policy gate (reference: 16 KiB); the transport bound is the CONNECT control line
(`max_control_line`, §13.12) and the policy gate MUST be the tighter of the two. The fixture
set additionally includes a **maximum-command serve credential** (a 12-command endpoint's
per-command rows, below); the §13.12 operator assertion uses the largest encoded CONNECT
line in the set.

**Serve grants.** Serving is granted authority, dual to calling. On the **subscribe side**
an instance's credential binds its registered service name, stable instance id, and
**registered command set** — one queue-qualified subscribe row per registered command
(matrix below), never a bare `>` tail spanning commands the instance did not register. The
per-command enumeration is affordable precisely where the caller-side equivalent is not:
serve credentials are one per instance, a handful per space, with no capability-count
scaling pressure. The subscribe side deliberately does NOT bind the epoch — a caller cannot
name the serving epoch, so no request subject carries it and **ingress cannot be
epoch-fenced by subject**; the fence for a superseded subscriber is the §13.1 takeover
barrier (revoke + cluster-verified eviction), not a grant shape. On the **publish side** the
credential binds the epoch everywhere it is real: the epoch-pinned reply prefix, the
epoch-pinned `epe` event plane, its `ept` timer schedule requests, and its `epr`
record-write ingress. Session subjects are
deliberately absent from the standing serve grant: both sides of a session hold only
redemption-minted per-session credentials (§13.6) — no standing EPS grant exists on either
side. The credential also carries the record keys the writer table assigns it and, where
the endpoint owns a work pool, the pool's consumer + ack grants (§13.5; matrix below).
Nothing else. Every "binds X" in this paragraph has a matrix row below that actually binds
X. Serve
credentials are re-minted on takeover (new epoch, §13.1 barrier); a superseded credential's
replies and commits are rejectable by epoch. Core names require operator provisioning
authority; reverse-DNS names bind to their registered owner. The registry is discovery; the
serve grant is the authority: a foreign credential cannot subscribe a class rail, answer as
an instance, or enter a frozen scatter set.

**The ownership matrix (normative).** Every profile × resource × transition is classified
**mediated** or **direct**, in an independently reviewed matrix from which grants are
generated (never the reverse). Each row names the writer PROFILE, the exact subject/API
namespace (including the queue qualifier where one applies — the grant grammar has a queue
dimension, §13.2), the operation, and the enforcement class; **read, consume, ack, and
delete authority are rows in the same table**, never prose that "follows" it. Every
credential and every audit probe is generated from these rows.

**Consumer-name grammar (normative).** Every consumer a row names has a pinned name grammar
(dash-form, §2; `<e>` is the endpoint-name token, `<uid>` the holder's lifecycleUid or
instanceId): `canonD = canon_<e>` (the canonicalizer durable), `poolD = pool_<e>_<pool>`
(the pool durable, **pre-created by the provisioner** with exact filter
`cotal.<space>.epw.<e>.<pool>.>` — the §8 item-3 pattern: the bare create form is
body-filter-selectable and is granted to NO ONE on control-surface streams), `timerD =
timerw_<space>` (the timer writer durable), `effD = eff_<e>` (the endpoint's ONE shared
effects durable — below), `goalD = goal_<uid>-<e>` (the caller's own goal-result durable).
Every composite name is **collision-free by construction**, and
each derivation states why: `pool_<e>_<pool>` parses uniquely from its LAST `_` because a
pool token contains no `_` (`[a-z0-9-]`) while `<e>` may (a dash separator would be
ambiguous — both tokens admit `-`); `dec_<uid>-<e>` parses from its FIRST `-` because
`<uid>` is `[a-z0-9]` and contains none, and `goal_<uid>-<e>` likewise; `eve_<uid>-<e>-<n>` and
`rec_<uid>-<n>` end in a numeric index, and a numeric-last suffix on distinct `(e, n)`
pairs cannot collide. A derivation that cannot state its collision-freedom argument is
non-conformant. Reader consumers use **mint-time-enumerated LITERAL names**, and every one
is **pre-created by the provisioner at capability mint as a PULL durable with its exact
filter; the holder receives BIND-ONLY grants** (INFO/MSG.NEXT/ACK — never CREATE or
DELETE): `decD = dec_<uid>-<e>` (one per journal capability), `goalD = goal_<uid>-<e>`
(one per action capability),
`eveD = eve_<uid>-<e>-<n>` and `recD = rec_<uid>-<n>` (one per granted subtree, `<n>` the
subtree's index in the minted capability — deterministic at mint time). Two reasons, both
load-bearing. A NATS wildcard replaces a
WHOLE dot-separated token and never matches inside one, so an embedded `*` in a name token
(e.g. `dec_<uid>-*`) is a literal character, not a glob — every name token in a grant is
fully literal. And holder-issued creates are forbidden outright because **a consumer
create's `deliver_subject` is body-set and NOT confined by the creator's publish
permissions** (the server's push delivery acts with stream authority — known upstream
nats-server behavior): a holder allowed ANY consumer create, however filter-pinned, could
configure a push consumer that re-publishes stored bytes onto arbitrary account subjects —
a confused deputy no filter tail prevents. Pull durables minted by trusted provisioning
are therefore the only reader shape on control-surface streams. **Subject convention:**
application subjects in rows are written relative and are prefixed `cotal.<space>.` on the
wire; **JetStream API tails — extended-create filter tails and `DIRECT.GET` subject
tails — are always spelled in FULL** (`cotal.<space>.…`/`$KV.…`/`$O.…`), because the API
subject embeds the stored subject verbatim and a relative tail matches nothing (the
streams capture `cotal.<space>.ep*.>`, §13.12).
The grep tests the matrix MUST pass: the only `CONSUMER.CREATE` grants below belong to
trusted provisioning/infra profiles and each carries a full literal filter tail; every
consumer-name token in a grant is a LITERAL (no embedded `*`); every filter or Direct-Get
tail is fully qualified; and no
`STREAM.MSG.GET` (body-selected) grant exists on any control-surface resource (the
pre-v0.4 messaging-surface CHKV/DLVKV reads in Appendix B are outside this matrix) —
subject-scoped reads use the
last-by-subject `DIRECT.GET.<stream>.<subject>` form, which the broker confines by subject
tokens.

| Transition | Writer profile | Exact namespace (per space/endpoint) | Class |
| --- | --- | --- | --- |
| Request publish | capability holder (agent, per capability) | per §13.2 form: `ep.{one,all}.<endpoint>.<command>[.<mode>[.<target tokens per mode>]].<cO>.<cA>.<cUid>.*` and `ep.inst.<endpoint>.<instanceId>.<command>[.<mode>[.<target tokens per mode>]].<cO>.<cA>.<cUid>.*` — mode/target tokens literal per the minted capability (`handle`: the full redemption-pinned triple) | direct — untrusted input, broker-confined |
| Reply subscribe (caller) | capability holder | `ep.reply.*.*.*.<cO>.<cA>.<cUid>.*` (exact arity) | direct read — own rail only |
| Serve subscribe | the endpoint's serve credential | per registered command: `"ep.one.<endpoint>.<command>.> <endpoint>"` (queue-qualified ONLY), `ep.all.<endpoint>.<command>.>` plain, `ep.inst.<endpoint>.<instanceId>.<command>.>` exact — never a cross-command `>` | direct — name/instance/command-pinned; epoch deliberately absent (§13.1 barrier is the fence) |
| Reply publish | the endpoint's serve credential | `ep.reply.<endpoint>.<instanceId>.<epoch>.*.*.*.*` | direct — attribution-pinned; addressing by nonce |
| Journal submission append | capability holder | `epj.<endpoint>.<command>[.<mode>[.<target tokens per mode>]].<cO>.<cA>.<cUid>` | direct — explicitly untrusted input |
| Canonicalizer consume | the endpoint's canonicalizer principal (singleton, §13.4) | its durable on `EPJ_<space>`: `$JS.API.CONSUMER.CREATE.EPJ_<space>.<canonD>.cotal.<space>.epj.<endpoint>.>` (full-tail single filter), `$JS.API.CONSUMER.INFO.EPJ_<space>.<canonD>`, `$JS.API.CONSUMER.MSG.NEXT.EPJ_<space>.<canonD>`, plus `$JS.ACK.EPJ_<space>.<canonD>.>` (ack/term after durable decision only — and, for pool-admitted acceptances, after the enqueue, §13.4) | mediated |
| Canonical decisions + quarantine | the endpoint's canonicalizer principal | publish `epf.<endpoint>.dec.>` and `epf.<endpoint>.quar.>` (create-only CAS per subject) | mediated |
| Canonicalizer CAS-winner + terminal read | the endpoint's canonicalizer principal | `$JS.API.DIRECT.GET.EPF_<space>.cotal.<space>.epf.<endpoint>.dec.>` + `$JS.API.DIRECT.GET.EPF_<space>.cotal.<space>.epf.<endpoint>.quar.>` (last-by-subject, subject-confined; observes the winning fact on redelivery, §13.4) + `$JS.API.DIRECT.GET.EPF_<space>.cotal.<space>.epf.<endpoint>.wrk.>` (READ-ONLY: the reconciliation predicate's terminal probe, §13.6 — `wrk` writes stay with the commit principal, row below) | mediated |
| Decision / goal-result / receipt read (caller) | capability holder (with every journal capability) | **bind-only** on the provisioner-pre-created pull durable `decD = dec_<cUid>-<e>` (exact filter `cotal.<space>.epf.<endpoint>.dec.<cO>.<cA>.<cUid>.>`): `$JS.API.CONSUMER.INFO.EPF_<space>.<decD>`, `$JS.API.CONSUMER.MSG.NEXT.EPF_<space>.<decD>`, `$JS.ACK.EPF_<space>.<decD>.>`; **plus, for every action capability, the caller-scoped goal-result durable** `goalD = goal_<cUid>-<e>` (exact filter `cotal.<space>.epf.<endpoint>.goal.<cO>.<cA>.<cUid>.>`, same bind-only INFO/MSG.NEXT/ACK shape) so the caller can watch its own terminal `goal….result` fact — the action contract's caller-visible outcome (§13.6), which has no reply rail; plus last-by-subject lookups `$JS.API.DIRECT.GET.EPF_<space>.cotal.<space>.epf.<endpoint>.goal.<cO>.<cA>.<cUid>.>` and `….receipt.<cO>.<cA>.<cUid>.>` on its own caller-scoped subtrees (§13.2) | direct read — caller-scoped subtrees, literal names pinned to the caller UID |
| Accepted-fact consume (effects) | every instance's serve credential, on the endpoint's ONE shared durable | **bind-only** on the provisioner-pre-created pull durable `effD = eff_<e>` (exact filter `cotal.<space>.epf.<endpoint>.dec.>`, `AckExplicit`): `$JS.API.CONSUMER.INFO.EPF_<space>.<effD>`, `$JS.API.CONSUMER.MSG.NEXT.EPF_<space>.<effD>`, `$JS.ACK.EPF_<space>.<effD>.>` — instances **pull-compete on the shared durable** so each accepted decision is delivered to exactly one live instance (at-least-once): a per-instance consumer over the class-wide decision subtree would be broadcast, and every instance would duplicate the external effect. Effects consume canonical facts, never raw submissions (§13.4); a rejected/quarantined decision is ack-skipped | direct read — endpoint-scoped, work-shared |
| Result/receipt/terminal/resume facts | the endpoint's commit principal | enumerated fact families, no subtraction and **never `dec.>`/`quar.>`** (canonicalizer-only): publish `epf.<endpoint>.goal.>`, `epf.<endpoint>.receipt.>` (caller-scoped subjects, §13.2), `epf.<endpoint>.wrk.>` (per-item terminal, create-only CAS), `epf.<endpoint>.cp.>` (one-use resume CAS); read-back via `$JS.API.DIRECT.GET.EPF_<space>.cotal.<space>.epf.<endpoint>.<goal\|receipt\|wrk\|cp>.>` (last-by-subject, one grant per family) | mediated |
| Event/progress read (caller) | capability holder (per read capability) | live subscribe on the granted `epe` subtrees (fully-qualified `cotal.<space>.epe.…` subjects in `sub.allow`, mirrored in Appendix B), incl. per-goal `epe.<endpoint>.*.*.goal.<cO>.<cA>.<cUid>.>`; filtered replay **bind-only** on the provisioner-pre-created pull durables `eveD-n = eve_<cUid>-<e>-<n>` (one per granted subtree, exact full-tail filter): `$JS.API.CONSUMER.INFO.EPE_<space>.<eveD-n>`, `$JS.API.CONSUMER.MSG.NEXT.EPE_<space>.<eveD-n>`, `$JS.ACK.EPE_<space>.<eveD-n>.>` | direct read — mint-time containment, filter = the granted subtree |
| Record read/watch | capability holder / serve credential (per read capability: attribute reads, scatter registry freeze, goal status watch) | per granted key subtree (§13.7 grammars): `$JS.API.DIRECT.GET.KV_cotal_records_<space>.$KV.cotal_records_<space>.<granted subtree>` (last-by-subject read) + watch **bind-only** on the provisioner-pre-created pull durables `recD-n = rec_<uid>-<n>` (one per granted subtree, exact `$KV.…` filter): `$JS.API.CONSUMER.INFO.KV_cotal_records_<space>.<recD-n>`, `$JS.API.CONSUMER.MSG.NEXT.KV_cotal_records_<space>.<recD-n>`, `$JS.ACK.KV_cotal_records_<space>.<recD-n>.>` (pull-based level-triggered watch; fell-behind ⇒ re-read, §13.4) | direct read — subtree pinned per capability |
| Claim / action / checkpoint commits | the owning endpoint's commit path | its own record keys (`goal`/`cp`/`lease` grammars, §13.7, per the writer table) + the enumerated commit fact families of the Result row above — never `dec.>`/`quar.>` | mediated (validates fencing, lease clock, lifecycle, epoch) |
| Contract-artifact publication | the contract publisher principal | publish `epc.<digest-hex>` (`epc.*`), create-only per subject (`Nats-Expected-Last-Subject-Sequence: 0` — a digest subject is written at most once); read-back via the reader row below | mediated — immutable once published |
| Contract-artifact read | **every** profile that may receive a digest reference (agents, endpoints, operators) | `$JS.API.DIRECT.GET.EPC_<space>.cotal.<space>.epc.>` — the subject-scoped last-by-subject Direct Get on the exact digest subject; one message IS the artifact (§13.7), so no consumer exists to confine; verify-on-read (§13.7) is the tamper boundary, not the ACL | direct read |
| Record write ingress (`epr`) | the owning instance | publish `epr.<endpoint>.<instanceId>.<epoch>.<kind>.<qualifier...>` — the instance's ONLY path to `svc`/`goal`/`cp` status writes; the epoch token is pinned by the serve credential, so the record writer reads the writing epoch from the broker-authenticated subject, never from payload | direct — epoch-pinned ingress to the mediated writer |
| Record writer consume + `spec`/`status` writes | the kind's separately scoped spec/status writer principal (writer table) | consume: `$JS.API.CONSUMER.CREATE.EPR_<space>.<recwD>.cotal.<space>.epr.>` (full-tail single filter; `recwD = recw_<space>`) + `$JS.API.CONSUMER.INFO.EPR_<space>.<recwD>` + `$JS.API.CONSUMER.MSG.NEXT.EPR_<space>.<recwD>` + `$JS.ACK.EPR_<space>.<recwD>.>`; write: `$KV.cotal_records_<space>.<key per the §13.7 kind grammars>.{spec,status}` | mediated per kind below — no row left open |
| Reader/pool/effects consumer provisioning (one-shot, at capability mint / endpoint setup) | the provisioner | exact full-tail extended creates for every pre-created durable this matrix names: `$JS.API.CONSUMER.CREATE.EPW_<space>.<poolD>.cotal.<space>.epw.<e>.<pool>.>`, `$JS.API.CONSUMER.CREATE.EPF_<space>.<effD>.cotal.<space>.epf.<e>.dec.>`, `$JS.API.CONSUMER.CREATE.EPF_<space>.<decD>.cotal.<space>.epf.<e>.dec.<cO>.<cA>.<cUid>.>`, `$JS.API.CONSUMER.CREATE.EPF_<space>.<goalD>.cotal.<space>.epf.<e>.goal.<cO>.<cA>.<cUid>.>` (per action capability), `$JS.API.CONSUMER.CREATE.EPE_<space>.<eveD-n>.<granted full-tail subtree>`, `$JS.API.CONSUMER.CREATE.KV_cotal_records_<space>.<recD-n>.$KV.cotal_records_<space>.<granted subtree>` — every create PULL, every filter a full literal tail; plus matching `CONSUMER.DELETE` for deprovisioning (lifecycle-keyed names, §13.1) | mediated — trusted provisioning only |
| Events | the owning instance | `epe.<endpoint>.<instanceId>.<epoch>.>` | direct — subject-confined, epoch-pinned |
| Timer schedule request | the owning instance | publish `ept.<endpoint>.<instanceId>.<epoch>.*.schedule` (never `.armed`/`.fire`); a request carrying any scheduling header is rejected by the timer writer (§13.2) | direct — epoch-pinned; captured by the schedules-DISABLED request stream |
| Timer request consume + arm | the space's timer writer principal (singleton infra, like the delivery daemon) | consume: `$JS.API.CONSUMER.CREATE.EPT_REQ_<space>.<timerD>.cotal.<space>.ept.*.*.*.*.schedule` (full-tail single filter) + `$JS.API.CONSUMER.INFO.EPT_REQ_<space>.<timerD>` + `$JS.API.CONSUMER.MSG.NEXT.EPT_REQ_<space>.<timerD>` + `$JS.ACK.EPT_REQ_<space>.<timerD>.>`; arm: publish `ept.*.*.*.*.armed`, deriving `Nats-Schedule-Target` = the sibling `.fire` from the authenticated request subject tokens ONLY, stripping/rejecting every client scheduling header, and **fresh-checking the authoritative timer generation/deadline before arming** — a redelivered or delayed stale-generation request is discarded, never armed, so it cannot overwrite the current schedule and silently lose the live deadline (§13.2, §13.6, §13.12) | mediated |
| Timer fire consume | the owning instance | its own `ept.<endpoint>.<instanceId>.<epoch>.*.fire` (fired messages validated against its authoritative schedule state AND the broker-authored scheduler-origin header = its exact sibling `.armed`, §13.12); no client credential holds `.armed` or `.fire` publish | direct read |
| Session `.in` publish | the session's caller (per-session credential) | `eps.<endpoint>.<sessionId>.<epoch>.in` exact | direct |
| Session `.in` subscribe | the serving instance (per-session credential) | `eps.<endpoint>.<sessionId>.<epoch>.in` exact | direct read |
| Session `.out` publish | the serving instance (per-session credential) | `eps.<endpoint>.<sessionId>.<epoch>.out` exact | direct |
| Session `.out` subscribe | the session's caller (per-session credential) | `eps.<endpoint>.<sessionId>.<epoch>.out` exact | direct read |
| Session ledger (one-use redemption, credential ids, revocation state, authenticated close) | the trusted auth path (§9/§10) | `$KV.cotal_auth_<space>.session.<sessionId>` — create-only CAS per `sessionId`, monotonic state (§13.6) | mediated |
| Credential ledger (issuance gate, descendant enumeration, lineage index, revocation) | the trusted auth path (§9/§10) | writes: `$KV.cotal_auth_<space>.cred.<lifecycleUid>.<credentialId>` + `….gate.<lifecycleUid>` (the issuance gate, §13.1) + `….bysrc.<issuerKeyId>.<id>.<lifecycleUid>.<credentialId>` (the per-ancestor lineage index) + `….session.<sessionId>`; reads: `$JS.API.DIRECT.GET.KV_cotal_auth_<space>.$KV.cotal_auth_<space>.>` (last-by-subject: gate checks, session lookups, per-row state) and prefix enumeration via its own full-tail pull durable `$JS.API.CONSUMER.CREATE.KV_cotal_auth_<space>.<authD>.$KV.cotal_auth_<space>.>` (`authD = authr_<space>`) + `$JS.API.CONSUMER.INFO.KV_cotal_auth_<space>.<authD>` + `$JS.API.CONSUMER.MSG.NEXT.KV_cotal_auth_<space>.<authD>` + `$JS.ACK.KV_cotal_auth_<space>.<authD>.>` — the barrier's family enumeration and the expiry sweep are executable reads, not prose. No other profile holds ANY grant on `cotal_auth_<space>` | mediated |
| Work-pool enqueue | the endpoint's canonicalizer (from accepted decisions only) | `epw.<endpoint>.>` publish, create-per-subject (`Nats-Expected-Last-Subject-Sequence: 0`; the acceptance identity is the subject, §13.2) | mediated |
| Work-pool reconciliation probe | the endpoint's canonicalizer | `$JS.API.DIRECT.GET.EPW_<space>.cotal.<space>.epw.<endpoint>.>` (last-by-subject on the exact item subject — never the body-selected `STREAM.MSG.GET` form) + the CAS-winner read row above (`dec` + `wrk` last-by-subject) — together they decide the §13.6 predicate: accepted, no terminal, no live entry ⇒ re-enqueue | mediated |
| Work-pool consume + ack | the pool's owning endpoint ONLY (workers hold NO pool grant, §13.5) | **bind-only** on the provisioner-pre-created exact-filter `poolD` (grammar above): `$JS.API.CONSUMER.INFO.EPW_<space>.<poolD>`, `$JS.API.CONSUMER.MSG.NEXT.EPW_<space>.<poolD>`, `$JS.ACK.EPW_<space>.<poolD>.>` (ack only after committed terminal state) — NO consumer create, NO stream-wide read | mediated |
| Lease issue / fencing advance | the pool's owning endpoint (`lease` command) | its `lease` record keys (§13.7 grammar), via the record-writer seam | mediated |
| Lifecycle mapping / teardown | minting manager's commit path; lifecycle-pinned deprovisioner | `lifecycle.<owner>.<actor>.<lifecycleUid>` record keys (§13.7); exact lifecycle-keyed names | mediated / broker-pinned delete |

Deletes beyond these rows: only the lifecycle-keyed deprovisioner (exact names, §13.1) and
stream retention.

A **mediated** row means the raw storage grant is held only by a narrowly scoped writer
principal (per endpoint, never a universal writer), with authenticated caller binding,
idempotent request semantics, and bounded failure/backpressure; CAS headers, fingerprint
rules, schema validity, and digest-correct bytes are *enforced* there. A **direct** row means
the broker guarantees writer/key containment only, and the row **explicitly downgrades**
CAS/schema/header/byte correctness to a conforming-client guarantee; readers of direct-row
state fail loud on invalid content. No profile — agent, observer, admin, host — holds generic
`$JS.API.>`/`$KV.>`/`$O.>` authority over control-surface state — for the contract store that
means the REAL subjects and APIs: **write** on `cotal.<space>.epc.>` belongs
to the contract publisher alone (create-only per digest subject); **read** is the
subject-scoped last-by-subject Direct Get of the reader row above — never a body-selected
form and never a consumer, because there is nothing to replay: one message per digest
subject IS the store — with verify-on-read as the tamper
boundary; and the **stream-management surface** of `EPC_<space>`
(`$JS.API.STREAM.{UPDATE,DELETE,PURGE,MSG.DELETE}.…`) is held by NO profile, publisher
included — stream lifecycle belongs to space setup under operator provisioning authority
only, which is what "immutable once published" rests on (a `$OBJ.>` deny matches no NATS
subject and audits nothing).
The matrix is re-audited mechanically (decoded-credential fixture + live positive/negative
probes, with predicates over the real `$O.`/`$JS.API` subject forms) at every phase that
adds a resource or changes ownership.

**Writer table (core kinds, mediation decided — D7: authoritative CAS/schema record writes
are mediated by separately scoped spec/status writer principals; an endpoint holds no raw
overwrite grant on its own record keys).** `svc` — spec: the provisioner/registration path,
**mediated** (CAS + schema enforced at registration); status: the owning instance's commit
path, **mediated** with **epoch currency enforced at the writer**: the writing epoch is
read from the broker-authenticated `epr` ingress subject (§13.2 — the instance's serve
credential pins the epoch token there, so a stale process CANNOT claim the successor's
epoch: the value is attested by the grant, never by payload), and the writer validates it
against a FRESH read of the authoritative lifecycle mapping's `processEpoch`,
rejecting a non-current epoch (`expired`) — monotonicity against the stored status epoch
alone is NOT sufficient, because between the takeover CAS (mapping N→N+1) and the completed
revoke/evict barrier the superseded N would still equal the stored status epoch and pass a
below-stored check — and additionally rejects a below-stored epoch (`conflict`). The record
key is restart-stable and
cannot carry the epoch (§13.1), so this epoch-pinned-ingress-plus-fresh-equality mediation
is the record's only stale-writer fence.
`signer` — spec+status: the space operator's registry tooling as the scoped writer
principal, **mediated**. `handle` — keys are **issuer-namespaced**,
`handle.<issuerKeyId>.<id>`, so two issuers can never collide or cross-revoke; spec: the
issuer through the record-writer seam, create-only; status/revocation: issuer or space
operator, **mediated and monotonic** (revoked never un-revokes; the signature stays the
content authority; mediation enforces key grammar, CAS, and schema). `contracts` index — the instance, **direct** (explicitly advisory and
non-authoritative; `describe` is authoritative; readers fail loud on invalid state).
`goal`/`cp` projections — status: the owning instance's commit path, **mediated**. Lifecycle
mapping records (§13.1) — the minting manager's commit path, **mediated**, CAS-only.
Canonical acceptance, work-pool enqueue, lease state, and contract-artifact publication —
**mediated** per the matrix above.

**Trait seam.** Core owns the fail-closed pre-effect verification interfaces (guard call,
priced-proof verification, governed-attachment verification); policy engines, token formats,
and payment rails remain extensions behind those seams.

### 13.10 Receipts and signing trust anchors

**Receipts.** A receipt binds a request to its outcome, signed and non-repudiable, for
metering, disputes, and pipeline causality; payment semantics stay opaque to core.

`Receipt` = `{ v: 1, requestId, space, endpoint, command, instance: { id, instanceId, epoch },
caller: { id, lifecycleUid }, schemaDigests: { input, output }, argsDigest, outcome: { ok,
code? }, resultDigest?, ts, signer: { keyId }, sig }` — canonical JSON, Ed25519-signed
(`space` per the unconditional artifact rule below).
Lifecycle and epoch are recorded as **evidence**, never redemption authority. A command
carrying `ai.cotal.priced` MUST verify an independently verifiable payment proof in the
`auth` slot before effect (never a bare "settled" assertion) and emit a receipt fact
(`epf….receipt.<cOwner>.<cActor>.<cUid>.<id>`, the caller-scoped subject of §13.2). Receipt retention: default 90 d, ≥ the idempotency horizon.
Verification: signature against the anchor registry + digest recomputation; forged or
request-mismatched receipts fail loud. Receipts MAY be emitted for unpriced commands.

**Trust anchors.** One per-space registry covers every signed artifact of this section —
authorization slots, capability handles, checkpoint resumes, trait definitions and
attachments, session grants, receipts. Anchors are `signer.<keyId>` records: spec =
`{ keyId, publicKey (Ed25519), owner (the principal or reverse-DNS domain the key belongs
to), roles ⊆ [handles, traits, receipts, resume, sessions, authz-slots, obligations,
payments], scope: per-role structured ceilings — for a `handles`-role key the **full grant
dimensions**, in the handle-grant shape itself: the endpoints/domains, and per entry the
maximal commands, authorization modes, target patterns, instance ids, and read subtrees the
key may issue for (a handles- or receipts-role key without a dimension ceiling has that
dimension closed, not open); for other roles the endpoints/domains it may attest for —
validFrom, validTo }`, status = revocation. `issuer-authority` is defined by exactly this
record: a verifier resolves the artifact's keyId FRESH at verification and enforces the role
AND its scope under the §13.6 containment order (`handle.grants ⊆ anchor.scope`) — a
handles-role key scoped to `com.acme.>` cannot issue for `manager`, a receipts-role key
scoped to one endpoint cannot attest as another, and a handles-role key whose scope names no
`handle`-mode targets cannot issue actor-pinned grants. Verification (fail closed): resolve the key,
reject unknown keys, out-of-window use, role mismatch, or revocation (immediate for new
verifications; effected work is not retroactively unwound). Rotation registers a successor
and closes the predecessor's window; overlap is permitted for handoff. Third-party trait
authorities register under their reverse-DNS domain claim. Trust roots never merge across
spaces.

**Signature encoding (normative, D28).** For every signed artifact: the signature input is
the UTF-8 bytes of the RFC 8785 canonical JSON of the artifact **with its `sig` field
absent**; the signature is Ed25519 (nkeys); `sig` carries it base64url-encoded (unpadded).
Verification recomputes the canonical form, resolves `signer.keyId`/`issuer.keyId` in the
anchor registry, and fails closed on any mismatch.

**Replay and claims matrix (normative, per artifact type).** Every row below additionally
and unconditionally requires `space`, the signing `keyId` (`issuer`/`signer` per shape), and
`sig` (the §13.10 encoding): an artifact missing any of the three is invalid before its
replay rule is ever consulted, and each artifact type is a discriminated schema — a verifier
dispatches on the type, never duck-types the claims.

| Artifact | Required claims | Replay rule |
| --- | --- | --- |
| Capability handle | id, space, issuer, holder (principal+UID), structured grants, iat, exp (nbf, parentDigest, epoch as applicable) | reusable within TTL, holder-bound; revocable if sturdy |
| Checkpoint resume | checkpoint token, goal id, holder (principal+UID), iat, exp, nonce | **one-use** (journaled by create-only CAS); duplicate = `conflict` |
| Session grant | sessionId, subjects, holder (principal+UID+processEpoch), serving instance+epoch, window, iat, exp, nonce | **one-use** redemption (holder epoch fresh-checked), then live; dies with either side's epoch |
| Guard obligation | goal/request id, attenuations, iat, exp | bound to its goal/request; reusable within it |
| Payment proof | per the priced contract's declared policy | default one-use per request id |
| Trait attachment | endpoint, command, contractDigest, traitUrn, value, signer, ts | revision-bound evidence; replaced only by an authorized contract revision |
| Receipt | per §13.10 shape (ts, signer; no exp/nonce) | evidence, never authority; replay-irrelevant |

Every verifier rejects out-of-window use (where `exp` applies), wrong-holder presentation,
and unknown/revoked keys.

### 13.11 The hard cut

This section is an intentional hard cut on the pre-1.0 line per §11. The version marker is
the grammar itself: the `ep`/`epe`/`epf`/`epj`/`ept`/`epw`/`eps` subject kinds and the
versioned envelope are disjoint from every v0.3 control subject and shape, and the old rails
are removed — subjects, envelopes,
handlers, credential grants, minting paths. No compatibility adapter, dual serving, or
translation window exists. A credential minted before the cut can publish only into dead v0
subjects: nothing subscribes them, no post-cut handler is reachable from them, no trusted
reply can be elicited (a pre-cut grant matches no endpoint-surface subject by construction —
verified adversarially with captured pre-cut credentials from every old profile). The one
structural exception is the pre-cut `admin` profile, whose space-wide `P.>` subscribe
predates and therefore MATCHES the new rails: **admin credentials MUST be re-minted at the
cutover** to the post-cut admin shape (Appendix B: messaging-plane subjects only, no
`ep*`/`eps`/`epc` subscribe), and the pre-cut admin credential is revoked with the cut —
the hard-cut guarantee is not honest without it. The wire
`protocolVersion` (§6, §11) targets `0.4` at the completion of this revision's migration, per
the §11 convention that the advertised version is the migration's normative target, and a
v0.4-conformant participant MUST advertise it (the optional-field era ends at the marker
boundary); `1.0` is a separate, later stability declaration (§11).

### 13.12 NATS + JetStream binding

**Broker floor.** The control surface REQUIRES NATS server ≥ 2.12 (message schedules, atomic
create-CAS, counters) AND a `max_control_line` large enough for the deployment's
maximum-capability CONNECT line. The two floors are checked at the tier that can see them:

- **Clients** check the server version from the pre-auth INFO and fail loud below 2.12 or
  when schedules are unavailable (including the offline-assets downgrade mode). The
  control-line limit is NOT discoverable pre-auth — an oversized CONNECT is silently dropped
  and looks like a network fault — so a client's obligation is bounded reconnect attempts
  plus the named diagnostic on a repeated pre-auth drop ("CONNECT may exceed the broker's
  max_control_line — have the operator verify it"), never an infinite retry loop.
- **Operator tooling** (doctor/setup) asserts the cause before any credential is minted:
  read `max_control_line` over the system account (`$SYS.REQ.SERVER.PING.VARZ`) from
  **every server of the cluster the credential may connect to** — the ping is fanned out,
  the response set is checked complete against the expected server count, and a partial
  response set is a FAILED assertion, never a pass — and require, on each server,
  `max_control_line ≥ (largest encoded CONNECT line of the §13.9 fixture set) + margin`.
  The fixtures are **byte-reproducible** (concrete maximum-length identities, the full
  grant set at the policy ceiling — the maximum-capability agent credential and the
  maximum-command serve credential — the encoded credentials, the resulting CONNECT
  lengths), so the floor is a measured quantity; the reference deployment's configured value
  is 65536 — a derived number, not an assertion. The 16 KiB policy gate remains a distinct
  mint-time cap on credential authority, refused loudly at minting. The same assertion pass
  checks `max_payload ≥` the largest serialized **bounded decision fact** fixture (the
  maximum `RejectionFact`/`QuarantineFact` under the token and detail bounds, §13.4) AND
  `max_payload ≥` the 256 KiB contract-artifact document bound plus envelope margin
  (§13.7 — a contract artifact is one message on its digest subject), so
  "the rejection fact always fits by construction" and "an artifact is a single message"
  are measured floors, not assumptions.

No sweeper fallback exists. Only 2.12 schedule semantics are assumed (same-subject
replacement; NOT the 2.14 stop-plus-publish path).

Per-space resources, created at space setup (`STREAM.CREATE` remains denied to agents):

| Resource | Captures / holds | Retention notes |
| --- | --- | --- |
| `EPJ_<space>` stream | `cotal.<space>.epj.>` (submissions, untrusted) | Limits; **native dedupe not relied upon** — submitters never set `Nats-Msg-Id` (§13.4; stream-wide header dedupe is a cross-caller suppression vector on a shared untrusted stream). A zero duplicate window is NOT server-accepted (`0` normalizes to the 120 s default; the minimum is 100 ms), so the config sets the server minimum and the guarantee is the header rule: a hostile header suppresses only another non-conformant header-bearing write; retention ≥ recovery/redelivery lag |
| `EPF_<space>` stream | `cotal.<space>.epf.>` (canonical facts) | Limits; acceptance via create-only CAS (`Nats-Expected-Last-Subject-Sequence: 0`); `allow_direct=true` (the last-by-subject fact reads of the §13.9 matrix); retention ≥ horizons |
| `EPE_<space>` stream | `cotal.<space>.epe.>` (events, progress) | Limits; space policy |
| `EPT_REQ_<space>` stream | `cotal.<space>.ept.*.*.*.*.schedule` (instance schedule REQUESTS, §13.2) | Limits; message schedules **DISABLED** — client-set scheduling headers are inert bytes here; retention ≥ writer recovery lag |
| `EPR_<space>` stream | `cotal.<space>.epr.>` (record-write ingress, §13.2) | Limits; epoch-pinned publish grants (§13.9); consumed only by the record writer; retention ≥ writer recovery lag |
| `EPT_<space>` stream | `cotal.<space>.ept.*.*.*.*.armed` + `….fire` (authoritative schedules + fires, §13.2) | `AllowMsgSchedules`; only the timer writer publishes `.armed` (§13.9); each schedule targets its sibling `.fire` subject (ADR-51 forbids target = publish subject); retention ≥ max deadline + margin |
| `EPW_<space>` stream | `cotal.<space>.epw.>` (work pools; one item per subject, §13.2) | WorkQueue; provisioner-pre-created non-overlapping exact-filter per-pool consumers (§13.9); `allow_direct=true` (the subject-confined reconciliation probe — an acked item leaves the WorkQueue, an in-flight one remains readable, which is exactly the §13.6 predicate) |
| (sessions: core-only, no stream) | `cotal.<space>.eps.>` | never captured; bounded in-memory window |
| `cotal_records_<space>` KV | records: the §13.7 core-kind key grammars (`svc`, `signer`, `handle`, `contracts`, `goal`, `cp`, `lease`, `lifecycle`) | per-key CAS; split `.spec`/`.status` keys; `allow_direct=true` (KV) |
| `cotal_auth_<space>` KV | the credential ledger (`cred.<lifecycleUid>.<credentialId>` + issuance gates `gate.<lifecycleUid>` + lineage index `bysrc.…`, §13.1) + session ledger (`session.<sessionId>`, §13.6) | trusted auth path ONLY — no agent, endpoint, observer, admin, or host profile holds any grant (§13.9 matrix); create-only CAS + monotonic states; **one bucket = one stream = one total order**, which the §13.1 issuance-gate race closure depends on; retention ≥ max credential/session TTL + recovery margin |
| `EPC_<space>` stream | `cotal.<space>.epc.>` (content-addressed contract artifacts, one per digest subject, §13.7) | Limits, no age eviction (artifacts are permanent); create-only mediated publication (`Nats-Expected-Last-Subject-Sequence: 0`); `allow_direct=true` (the subject-scoped last-by-subject read IS the fetch path); stream management held by no profile (§13.9) |

Claim pools are pull consumers on `EPW` with `AckExplicit`, held **only by the pool's owning
endpoint** (§13.5): `ack_wait` is the broker's redelivery-to-owner timer and nothing more —
the authoritative lease token and deadline live in the owner's lease record, never in the
item value (stored bytes are work identity and input only), and the owner acks only after
the committed terminal state. Filtered replay of events/facts uses pinned single-filter
consumer creates (the CHAT-history containment mechanism, §8/§9). Timer scheduling is
**mediated** (§13.2, §13.9): instances publish only `.schedule` REQUESTS into the
schedules-disabled `EPT_REQ` stream, where a client-set `Nats-Schedule-Target` (or any
scheduling header) is inert bytes and the timer writer rejects a request carrying one — this
closes the ADR-51 confused deputy, in which a direct publisher confined only to "some
subject the schedules stream captures" could target ANOTHER instance's `.schedule` (installing
or replacing its schedule state, since schedule headers are copied to the target verbatim) or
its `.fire`. The timer writer alone publishes the authoritative schedule on `.armed`, with
`Nats-Schedule-Target` = the sibling `….fire` subject derived from the authenticated request
subject's own tokens; and **fire handling is the trusted seam** behind it — a `.fire`
consumer acts only on a fired message matching a current authoritative
schedule it owns (`timerId` + generation + deadline, §13.2) AND whose broker-authored
scheduler-origin header (`Nats-Scheduler`, the schedule's subject, set by the server on
fire) equals its own exact sibling `.armed` subject, discarding anything else as
forged. Replacement is the writer's same-subject publish on `.armed` (server rollup); fired
messages appear on `.fire` carrying `(timerId, generation)`.

### 13.13 Conformance (control surface)

A conformant endpoint (v0.4) MUST:

1. Serve only under a credential whose serve grants match its registered name, stable
   instance id, and registered command set (publish-side grants pinned to the current
   epoch); register its service record before serving; advance the epoch by CAS on takeover
   and stop serving when superseded — a takeover is complete only after the §13.1 barrier
   (revoke + cluster-verified eviction of the superseded credential).
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
   linearized at acceptance, one-use resumes, generation- and scheduler-origin-validated
   timers (a fire counts only against its own sibling `.armed`, §13.12) with durable
   reconciliation, fail-closed governed traits, bounded sessions.
9. Fail loud below the broker version floor (from the pre-auth INFO), with bounded
   reconnects and the named pre-auth-drop diagnostic (§13.12); the `max_control_line` floor
   is asserted by operator tooling (§13.12), never by the client, which cannot inspect it.
10. Connect successfully while presenting the normative maximum-capability credential
    fixture for its profile (§13.9) — the only test that exercises the control-line bound.

A conformant caller (v0.4) MUST: hold a lifecycle-pinned credential and never present another
lifecycle's artifacts; choose ids/goalIds/nonces within the token grammar and the 1024-byte
subject bound and reuse ids only per the idempotency rules; declare `class` and
`replyExpected` and honor `contract-mismatch`/`conflict`; freeze scatter expectations from the
registry and classify partial results; verify digests of fetched artifacts and signed
artifacts against the anchor registry, failing closed.

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
- `DLV = <Plane-3 per-member delivery stream>`; `INBOX = <mixed pre-auth fan-out stream>` (the durable-backstop handoff, §8): fan-out writes `INBOX` (`dinbox.<owner>.<actor>.<uid>` — lifecycle-bound from v0.4, so an inactive-gap or predecessor entry can never migrate to a same-name successor), the trusted reader re-authorizes and transfers to `DLV` (`dlv.<owner>.<actor>.<uid>`, same binding), and the agent binds its own `DLV` DELIVER consumer (filter pinned to its own triple). An agent gets **no** grant on `INBOX` (the mixed pre-auth store).
- `KV = KV_cotal_presence_<space>`
- `CHKV = KV_cotal_channels_<space>`; `DLVKV = <delivery lease/readiness KV>`
- `<owner>.<actor> = the authenticated principal` (§2): `<owner>` and `<actor>` are its two tokens; the dot-form is the wire/KV form, the dash-form `<owner>-<actor>` is the durable-name form
- `connId = the authenticated connection id` (the connection nkey in static mode; the client-chosen nonce in user mode); distinct from the principal, and keys ONLY the reply inbox
- `role = authenticated agent role`
- `chatHistD = chathist_<owner>-<actor>-<uid>`, `dmD = dm_<owner>-<actor>-<uid>`, `dlvD = dlv_<owner>-<actor>-<uid>`, `svcD = svc_<role>` (per-instance durables are lifecycle-scoped from v0.4: keyed on the dash-form + lifecycle UID, §8/§13.1; `svcD` stays role-scoped)
- `inbox = _INBOX_<connId>.>`

Grouped placeholders such as `<CHAT|DM|TASK>` mean one concrete subject per listed token.

### Agent

`sub.allow`:

- `inbox`
- `P.ep.reply.*.*.*.<owner>.<actor>.<uid>.*` (exact arity — the agent's own endpoint reply rail: every endpoint's replies to THIS caller triple + nonce, §13.2; replies never ride the per-connection `inbox`)
- `P.epe.…` — the exact fully-qualified event subtrees of every minted read capability
  (§13.9 event-read row), incl. the caller's own per-goal subtree
  `P.epe.*.*.*.goal.<owner>.<actor>.<uid>.>`; the live tail of watch, granted per
  capability, none by default
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
- contract-artifact read per the §13.9 reader row:
  `$JS.API.DIRECT.GET.EPC_<space>.cotal.<space>.epc.>` — the subject-scoped
  last-by-subject Direct Get on the exact digest subject; one message is the artifact, no
  consumer exists (verify-on-read is the tamper boundary, §13.7)
- decision/goal-result/event/record read grants per minted capability: **bind-only** on the
  provisioner-pre-created PULL durables of the §13.9 matrix reader rows
  (`dec_<uid>-<e>`, `goal_<uid>-<e>`, `eve_<uid>-<e>-<n>`, `rec_<uid>-<n>` — mint-time literal names, never
  an embedded `*`, which NATS treats as a literal character inside a token):
  `CONSUMER.INFO`/`CONSUMER.MSG.NEXT`/`$JS.ACK` per durable, and NO consumer create — a
  holder-issued create's `deliver_subject` is body-set and unconfined by the creator's
  publish permissions (§13.9), so dynamic reader creates exist for no one
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

Admin has observer grants, with `sub.allow = [P.chat.>, P.inst.>, P.svc.>, inbox]` — the
god-view is the **messaging plane only**, enumerated: it deliberately excludes `P.ep.>`,
`P.epe.>`, `P.epf.>`, `P.epj.>`, `P.ept.>`, `P.epr.>`, `P.epw.>`, `P.eps.>`, and `P.epc.>`
(a space-wide `P.>` would plain-subscribe every `ep.one` request rail — collecting reply
nonces the queue-qualified-only rule exists to protect — and every core-only session
frame; §13.2, §13.11). Plus DM history read grants:

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

- `provisioner`: pre-creates the per-instance lifecycle-scoped durables (`dm_…-<uid>`,
  `svc_…`, the per-member `dlv_…-<uid>` handoff) AND every control-surface pre-created
  consumer of the §13.9 matrix — `poolD`, `effD`, and the per-capability reader durables
  `decD`/`goalD`/`eveD-n`/`recD-n` (all PULL, all exact full-tail filters, per the one-shot
  provisioning row) — and mints scoped credentials; ephemeral
  onboarding authority.
- `deprovisioner`: target-pinned teardown of ONE retired lifecycle's footprint, minted per
  teardown with the target's `(principal, lifecycleUid)` in every exact-name grant — it can
  delete only lifecycle-keyed names, so it structurally cannot reach a same-name successor
  (§13.1).
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
  only the `supervisor` profile is minted; agents are broker-denied. `evictPrincipal` is the
  eviction step of the §13.1 takeover and terminal-retirement barriers — wired into both, not
  a standalone admin convenience. The former
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
require a privileged host. None of these profiles is ever issued to ordinary agents. On the v0.4
endpoint surface, every host profile's grant rows are **generated from the §13.9 ownership matrix**
(matrix → grants, never the reverse): a profile with no matrix row holds no `ep*`, `$O.`, or
control-surface `$JS.API` authority, and `provision.ts` (`permissionsFor`) is the generated artifact
this appendix summarizes, not an independent authority. This appendix spells out the `agent`,
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
| 2026-07-10 | **v0.4 binding revision: endpoint control surface (§13).** One standardized typed surface for every endpoint (manager, delivery, wrapped third-party servers): class/instance/scatter rails with per-command broker enforcement and an authorization-mode gradient, lifecycle identity (recyclable alias + never-reused lifecycle UID + fenced process epoch, §13.1, §2/§6/§8 extensions), versioned envelope with structured errors and signed slots, three delivery contracts (ephemeral, split-key records, untrusted submissions → mediated canonical facts), verbs call/cast/watch/claim/scatter (claim owner-mediated: workers hold no pool grant), composites (action, checkpoint, guard, capability handle with redemption-pinned `handle`-mode targets, session, virtual endpoints), content-addressed cluster contracts + governed traits + describe, the ownership matrix (incl. exact reader/consumer/ack rows and pinned consumer-name grammars), takeover/retirement revoke-and-evict barriers over the full ledgered credential family (credential ledger, §13.1), mediated timer arming (request/armed/fire split with a scheduler-origin fire check), poison quarantine facts, an epoch-pinned record-write ingress plane (`epr`), a single-message digest-subject contract store (`epc`, replacing the Object Store binding), pre-created pull-only reader consumers (no dynamic reader creates: a create's delivery target is body-set and unconfined), an alias CAS head for lifecycle activation, and receipts and trust anchors. **Hard cut:** deletes the v0 `ctl` rail, `ControlRequest`/`ControlReply`, the `self`/`manager`/`admin`/`delivery-admin` tiers, and the reserved `control.<instance>` subject. `protocolVersion` targets `0.4` at migration completion; `1.0` stays reserved as a later stability declaration. |
| 2026-07-07 | Documentation revision, no wire change: layered authority statement (schema authoritative for shapes, prose for semantics), document-snapshot policy and this change log (§11), reciprocal links to the informative docs. |
| 2026-07-03 | **v0.3 binding revision: owner+actor identity.** The wire identity becomes the two-token principal `(owner, actor)`: subjects carry the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id` re-key onto the pair (§2, §3, §6, §8, §9). The connection nkey remains only the transport credential (the per-connection reply inbox). Adds the per-user-auth authorization grammar and the owner-token format (§2, §9). Supersedes the single-id grammar. |
| 2026-06-21 | **v0.3 binding revision: channel live delivery.** Channel live delivery moves from the mediated per-instance live-tail durable to native `sub.allow`-bounded core subscriptions, with an explicit per-channel `live`/`durable` delivery class and the per-member durable backstop (§4, §7, §8); membership moves to a privileged-written registry (§7). Supersedes the v0.2 single-durable live-tail. |
| earlier | v0.2 and before predate change control: the v0.2 contract (single mediated live-tail durable binding) is superseded by v0.3 and kept only in history. |
