# Cotal Wire Specification

> **Status:** Draft, v0.2. This document is the normative wire contract. Libraries
> (including the reference TypeScript implementation) are thin clients over it; where a
> client disagrees with this document, this document wins.
>
> **Editors:** Cotal maintainers. **Last updated:** 2026-06-14.

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

**Authenticated delivery class.** A receiver MUST derive "how was this addressed to me"
from the delivering subject kind (`chat` -> `channel`, `inst` -> `dm`, `svc` ->
`anycast`), not from payload routing fields, which are advisory. A peer can put your id in
payload `to`, but cannot publish on your private unicast subject. Reference:
`MessageMeta.kind`.

**Delivery guarantee.** The NATS binding is at-least-once. A message remains pending for a
consumer until it is acked. A crash or `ack_wait` expiry redelivers it. Receivers MUST
tolerate duplicates and SHOULD deduplicate by `id` when acting on non-idempotent work.
Malformed JSON, spoofed sender payloads, and unparseable delivery subjects are permanent
anomalies and MUST be terminated, not retried.

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
| `mentions` | string[] | MAY | lowercased peer names; wake hint on a `channel` message, not routing |
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
| `meta` | object | MAY | free-form metadata |
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
| `description` | string | one-line purpose; max 200 chars |
| `instructions` | string | advisory usage text; max 2000 chars |

Space-wide defaults (`ChannelDefaults`: `replay?`, `replayWindow?`) live under the reserved
key `=defaults`. Effective replay is `channel.replay ?? defaults.replay ?? true`.

Join adds the channel to the instance's multicast subscription; leave removes it. A join
target MUST be within the instance's read ACL (`allowSubscribe`, §9); a join outside it MUST
be refused. A client MUST NOT publish to wildcard channels. The active read set MUST NOT
become an empty filter that would accidentally subscribe to all chat subjects; a leave of the
last channel MUST be refused. In auth mode an agent has no grant to create or update its own
chat durable, so a join/leave is a mediated control op: a privileged service validates the
target set against `allowSubscribe` and moves the durable's `filter_subjects`. In open mode
the client updates its own durable directly.

Replay on join is channel-global, not per-subscriber:

1. Capture the CHAT stream frontier before enabling the new channel filter.
2. Move the chat durable's `filter_subjects` to include the channel subject (mediated in auth
   mode; self-served in open mode).
3. If effective replay is on, read retained messages for that channel up to the frontier —
   through a consumer scoped to a single channel filter, optionally bounded by `replayWindow`.
4. Surface backfilled messages with `MessageMeta.historical = true`.
5. Ack-drop live-tail messages at or below the join watermark so backfill and tail do not
   double-deliver.

`replay=false` is noise control, not confidentiality. CHAT history is readable only within an
instance's read ACL (`allowSubscribe`, §9); confidential content MUST use DM or anycast.

Channel membership is broker-known, not self-reported. In the NATS binding, membership is
the set of `chat_<id>` live-tail consumers and their `filter_subjects`, joined with presence
for liveness; the transient `chathist_<id>` history consumers are NOT membership. Membership
is observability data and MUST NOT be used as a send authorization gate.

---

## 8. NATS + JetStream binding

Backing streams are created once at space setup. `STREAM.CREATE` is denied to agents in auth
mode.

| Stream | Captures | Retention | Required config |
| --- | --- | --- | --- |
| `CHAT_<space>` | `cotal.<space>.chat.>` | Limits | file storage, `max_msgs_per_subject=1000`, `discard=Old`, `allow_direct=true` |
| `DM_<space>` | `cotal.<space>.inst.>` | Limits | file storage, no Direct Get |
| `TASK_<space>` | `cotal.<space>.svc.>` | WorkQueue | file storage, no Direct Get |

Durable consumers:

| Durable | Stream | Filter | Policy |
| --- | --- | --- | --- |
| `chat_<id>` | CHAT | active read set as `cotal.<space>.chat.*.<channel>` (⊆ `allowSubscribe`) | provisioner-created bind-only in auth mode (filter moved only by the mediated join/leave op); self-created in open mode; `DeliverPolicy.New`; `AckExplicit`; `ack_wait=60000ms`; `inactive_threshold=600000ms` (open mode only) |
| `chathist_<id>` | CHAT | one `cotal.<space>.chat.*.<channel>` per read | transient single-filter consumer for history reads (join-backfill / focus-recall); created per read scoped to one channel in `allowSubscribe`, then deleted; `AckNone` |
| `dm_<id>` | DM | `cotal.<space>.inst.<id>.*` | provisioner-created in auth mode; bind only; `DeliverPolicy.All`; `AckExplicit`; `ack_wait=60000ms` |
| `svc_<role>` | TASK | `cotal.<space>.svc.<role>.*` | provisioner-created in auth mode; bind only; `AckExplicit`; `ack_wait=60000ms` |

Durable names use sanitized tokens. For authenticated ids this does not change the nkey.

Publishers MUST publish delivery messages through JetStream and set the JetStream message id
to `CotalMessage.id` (`Nats-Msg-Id` on the wire). Receivers MUST ack only after the message
has actually been surfaced or handled. Receivers MAY nak transient failures. Receivers MUST
term permanently invalid messages.

History on join uses Direct Get on CHAT only. DM and TASK MUST NOT enable Direct Get because
it would bypass the consumer-create deny that is part of the confidentiality boundary.

KV buckets are also streams and are pre-created:

| Bucket | Holds | TTL |
| --- | --- | --- |
| `cotal_presence_<space>` | presence (§6) | 6000 ms |
| `cotal_channels_<space>` | channel registry (§7) | none |

---

## 9. NATS + JetStream security and authorization

**On by default.** A space is provisioned with decentralized JWT auth. Open unauthenticated
dev mode is available but out of scope for the security claims here.

- **Account = space, user = agent.** A space is one NATS account. A per-space operator signs
  the account; an account signing key mints per-agent user JWTs.
- **Profiles are default-deny allow-lists.** Subject, stream, durable, and KV names are built
  from the same builders as §3 and §8. Exact profile shapes are in Appendix B.
- **An agent's channel scope is three concepts**, each a list of channel names or wildcard
  subtrees (`team.>`): `subscribe` — the active read set, the channels it actually subscribes
  to at boot (the `chat_<id>` filter; mutable at runtime via the mediated join/leave); it MUST
  be a subset of `allowSubscribe`. `allowSubscribe` — the read **ACL**, the channels it MAY read
  (default = `subscribe`), enforced as the per-channel history-consumer create grants above.
  `allowPublish` — the post **ACL**, the channels it may publish to; **default-deny** (a chat
  publish grant is minted only for a declared channel).

| Profile | Application publish | Read surface | Notes |
| --- | --- | --- | --- |
| `agent` | own `chat.<id>.<ch>` for each `allowPublish` channel (post ACL, default-deny), `inst.*.<id>`, `svc.*.<id>`, `ctl.<manager>.<id>`; own presence key | own `_INBOX_<id>.>`; CHAT live tail via bind-only `chat_<id>` (no create/update); CHAT history via single-filter `chathist_<id>` creates, one per `allowSubscribe` channel; own `dm_<id>` and `svc_<role>` bind-only | read bounded by `allowSubscribe`; no Direct Get; DM/TASK create denied |
| `observer` | none | chat, CHAT history, presence, channel registry | DMs invisible |
| `admin` | none | whole space live tap plus DM history | plaintext god-view, opt-in |
| `manager` | broad | broad | provisioner host; SHOULD be scoped in a future version |

DM and TASK confidentiality, and the CHAT read boundary, close the leak paths:

1. Delivery rides a per-identity inbox prefix, `_INBOX_<id>.>`, and `sub.allow` permits only
   that prefix.
2. A consumer create on the bare/multi-filter subject is not ACL-constrainable, so the
   provisioner pre-creates `dm_<id>`, `svc_<role>`, and the multi-channel `chat_<id>` live tail,
   and agents bind only. All such create forms on `DM_<space>`, `TASK_<space>`, and `CHAT_<space>`
   are denied to agents.
3. CHAT reads are bounded to `allowSubscribe`: a consumer create on the extended subject
   `$JS.API.CONSUMER.CREATE.<stream>.<name>.<filter>` carries a single filter the
   server pins to the request body, so an agent is granted exactly one such create-subject per
   `allowSubscribe` channel and can read history of no other channel. The unfiltered Direct Get
   grant is not given to agents.

This binding provides containment and authenticity under a single trusted broker: an agent
can emit only as itself and only to its declared `allowPublish` channels, and read only its own
DMs and chat *content* within `allowSubscribe`, enforced by the server. It does not provide
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
6. Derive delivery class from the subject, not payload routing fields (§4).
7. Ack only surfaced/handled messages and terminate permanent anomalies (§4, §8).
8. Write only its own presence key on the heartbeat interval (§6).
9. Set the per-instance inbox prefix before transport operations (§10).
10. Treat unknown fields as ignorable (§11).

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
- `CHAT = CHAT_<space>`, `DM = DM_<space>`, `TASK = TASK_<space>`
- `KV = KV_cotal_presence_<space>`
- `CHKV = KV_cotal_channels_<space>`
- `id = authenticated instance id`
- `role = authenticated agent role`
- `chatD = chat_<id>`, `chatHistD = chathist_<id>`, `dmD = dm_<id>`, `svcD = svc_<role>`
- `inbox = _INBOX_<id>.>`

Grouped placeholders such as `<CHAT|DM|TASK>` mean one concrete subject per listed token.

### Agent

`sub.allow`:

- `inbox`

`pub.allow`:

- `P.chat.<id>.<ch>` for every `allowPublish` channel (post ACL; none by default)
- `P.inst.*.<id>`
- `P.svc.*.<id>`
- `P.ctl.<manager>.<id>`
- `$JS.API.INFO`
- `$JS.API.STREAM.INFO.<CHAT|DM|TASK|KV|CHKV>`
- `$JS.API.CONSUMER.INFO.<CHAT>.<chatD>` (live tail; bind only — no create/update)
- `$JS.API.CONSUMER.MSG.NEXT.<CHAT>.<chatD>`
- `$JS.ACK.<CHAT>.<chatD>.>`
- `$JS.API.CONSUMER.CREATE.<CHAT>.<chatHistD>.<P.chat.*.<ch>>` for every `allowSubscribe` channel (history reads; the single filter the server pins to the body)
- `$JS.API.CONSUMER.INFO.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.MSG.NEXT.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.DELETE.<CHAT>.<chatHistD>`
- `$JS.API.CONSUMER.INFO.<DM>.<dmD>`
- `$JS.API.CONSUMER.MSG.NEXT.<DM>.<dmD>`
- `$JS.ACK.<DM>.<dmD>.>`
- `$JS.API.CONSUMER.CREATE.<KV>.>`
- `$JS.API.CONSUMER.INFO.<KV>.>`
- `$JS.FC.>`
- `$KV.cotal_presence_<space>.<id>`
- `$JS.API.STREAM.MSG.GET.<CHKV>`
- `$JS.API.CONSUMER.CREATE.<CHKV>.>`
- `$JS.API.CONSUMER.INFO.<CHKV>.>`
- if `role` is set: `$JS.API.CONSUMER.INFO.<TASK>.<svcD>`,
  `$JS.API.CONSUMER.MSG.NEXT.<TASK>.<svcD>`, `$JS.ACK.<TASK>.<svcD>.>`

`pub.deny`:

- `$JS.API.CONSUMER.CREATE.<DM>`
- `$JS.API.CONSUMER.CREATE.<DM>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<DM>.>`
- `$JS.API.CONSUMER.CREATE.<TASK>`
- `$JS.API.CONSUMER.CREATE.<TASK>.>`
- `$JS.API.CONSUMER.DURABLE.CREATE.<TASK>.>`

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
`dm_<id>` and `svc_<role>` durables and minting scoped credentials. It MUST NOT be issued to
ordinary agents.

## Appendix C: Normative references

| Reference | Used for |
| --- | --- |
| RFC 2119, RFC 8174 | requirement keywords |
| RFC 8259 | UTF-8 JSON envelopes (§5) |
| RFC 4648 | base32 instance-id encoding (§2) |
| RFC 8032 | Ed25519 keypairs behind nkeys (§2) |
| [NATS client protocol](https://docs.nats.io/reference/reference-protocols/nats-protocol) + [JetStream](https://docs.nats.io/nats-concepts/jetstream) | the v0 transport binding (§8) |
| [NATS decentralized JWT auth](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/jwt) + nkeys | identity and authorization (§2, §9) |
