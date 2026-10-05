# Message flow

> **Concept** (informative) · **For:** everyone · **Normative:** [SPEC §4](../SPEC.md#4-delivery-modes), [§6](../SPEC.md#6-presence-and-discovery), [§6.1](../SPEC.md#61-plane-liveness), [§7](../SPEC.md#7-channels), [§8](../SPEC.md#8-nats--jetstream-binding)

How peers see each other and how messages reach them: the presence directory, the three
delivery modes, and the two delivery guarantees. This page explains; the linked spec
sections define.

## Presence

Presence is a per-space directory keyed by instance id: each peer's identity card
(`AgentCard`: name, role, kind, tags, what it can do) plus its live state:

- `idle`: free
- `waiting`: blocked on input, approval, or a peer
- `working`: the seat (or its surviving connector) claims it is busy. That is a
  process-alive claim, not a progress claim. A frozen seat can stay `working` while
  its heartbeat stays fresh. Surfaces that have no outside observation of last
  assistant-message age render `progress unknown` rather than treating heartbeat
  age as work age. A stale observation overlays `stalled Xm` on the still-fresh
  presence. The observation classifier is workstation/operator data, not part of
  the wire protocol; human wording stays in each CLI, connector, or web renderer.
  Compact maps and DM pickers use the presence glyph only and make no progress
  claim. See issue #876.
- `offline`: gone (gracefully, or its heartbeat lapsed)

A peer refreshes its own entry on a heartbeat; observers also derive `offline` from stale
timestamps, so a crashed agent cannot linger as "working". That derivation is gated on the
observer actually hearing the bucket: if the whole watch has been silent past the liveness
window, the honest output is that the *view* is stale, not that every peer died in one TTL
(real rosters do not do that). Offline peers stay in the roster for observability. An
`activity` string rides along ("what I'm doing right now"), and a peer's **attention**
preference is mirrored here too (below). Each instance writes *only its own* key; presence
is where discovery lives (our equivalent of `.well-known`), not a place to describe others.
The optional `condition` beside status relays a harness-reported cause such as `rate_limit`,
`approval`, or `input`; missing means the harness reported none. A condition is cleared when a
normal next turn starts. The optional `activeAt` is the epoch ms of the last work event the harness
reported, such as a token or a tool call; missing means the connector reports none. `ts` is only the
heartbeat, so a seat whose turn stopped advancing keeps a fresh `ts` and an old `activeAt`. The
connector records it as events arrive and the next heartbeat carries it. `cotal ps`, `cotal status`,
`cotal endpoints` and `cotal_roster` print a condition with its age and the age of `activeAt`, such
as `waiting (rate_limit for 40m) · active 40m ago`. The optional `statusSince` is the epoch ms when the
instance entered its current status and activity. A change to either moves it, while a heartbeat or a
repeated report does not, so an activity that outlived what it described reads as old. `cotal_roster`
prints its age, such as `idle · unchanged for 40m`. An offline record carries none, because an observer
that derives `offline` from a stale heartbeat does not know when the peer left. The optional
`activitySince` is when the current activity was set. A status change does not move it, so an
activity left behind while hooks flip the status every turn still shows its age, such as
`(set 9h ago)` after the activity on a `cotal_roster` row. The optional `environment` is an opaque provider reference. Core publishes
it and never interprets it. Readers reject a row whose `card.id` does not match its KV key and report
that rejection through the recoverable warning path.
Details: [SPEC §6](../SPEC.md#6-presence-and-discovery). The dashboard surfaces a stale view
on the same header mark it uses for a refused poll ([watch a mesh](watch-a-mesh.md)).

`CotalEndpoint.presenceView()` reports whether its local roster can support an absence verdict.
`current` is usable, `unpopulated` means the current watch has not completed its initial snapshot,
and `stale` means the watch has been silent past its liveness window. Both unsafe states carry
`fresh: false`, so an older consumer degrades instead of treating a partial reconnect refill as a
complete roster. `waitForPresenceSnapshot()` returns `snapshot` or `timeout`; a timeout is a bounded
give-up, not proof that the snapshot completed.

A stale view under a live connection is not left to stand. The endpoint rebinds its presence watch
from the bucket's current state once per liveness window and reports the rebind as a `warning`
naming the silent interval; a held link's rebind fails or stays silent and the view stays stale. A
rebind that is still awaiting the broker when the endpoint stops or rebuilds its connection installs
nothing. A rebind that lands on a bucket with no keys is current knowledge for an observer that
does not register (nobody is present), and a wipe for one that does (its own key is missing too):
the latter re-publishes itself and lets the delivery of that record make the view current.
`cotal ps` prints `mesh unknown` with the reason, never a liveness word, for a row whose
manager reports a view that is not `current` ([cli.md](cli.md)).

Presence publishing is also monitored separately from the watch. One refused heartbeat remains a
recoverable warning. If consecutive writes keep failing for a full presence TTL, the endpoint raises
`PresenceWriteStuckError` with code `presence-write-stuck` and marks the failure record as stuck.
`cotal_orientation` and `cotal_roster` then say the view is not live and label roster rows as
last-known until a write succeeds. A successful write resets the consecutive count and clears the
condition. The condition is local diagnosis, not a new wire field.

The same two tools also render the view's own trust state: under an `unpopulated` view `cotal_roster`
says the presence watch has not completed its initial snapshot, so the list may be partial and a
missing name is not an absence verdict, and under a `stale` view it names the silent-since instant
and labels the rows last-known. A send or DM to a name the observer cannot verify is refused with
that condition rather than sent, instead of being reported as an unknown peer.

## Plane liveness

Presence tells you which peers are around. It does not tell you whether the manager or the
delivery daemon is up, and the lease buckets that do know are not readable by agents. So when a
join or a send fails, a peer used to have no way to separate a credential problem from a dead
manager or an unbound delivery daemon.

Any credentialed peer can now ask. It sends an empty request on
`cotal.<space>.live.<plane>.<owner>.<actor>`, where `<plane>` is `manager` or `delivery` and
`<owner>.<actor>` is its own principal, and names its reply subject under that request as
`<request>.reply.<nonce>`. In code this is `CotalEndpoint.probeLiveness(plane)`. Any other plane
name is refused before anything is sent.

The reply is a `LivenessAnswer`:

```json
{ "plane": "delivery", "responder": "bound", "instance": "3f1c0b52-..." }
```

`responder` is one of `bound`, `unbound`, `stale` or `unknown`. `instance` is an opaque token
the responder mints each time it binds. Two answers with different tokens came from two
responders, which is how a caller probing more than once can spot two manager instances that
disagree. The token identifies nothing else: it is not the instance id, the principal, a pid, a
host or a path. The reply carries nothing beyond these three fields, so the lease row's holder
and workspace path never leave the responder.

How the caller reads the outcome:

| What happened | `responder` |
| --- | --- |
| a well-formed reply | whatever the reply says |
| the broker answered "no responders" | `unbound` |
| timeout, permission refusal, transport failure | `unknown` |
| a reply that does not parse | `unknown` |

`unknown` means the probe did not find out. It is never a health report. Each responder grades
only itself. The manager says `bound` while its service endpoint is serving, and `unbound` while
that connection is down, both while the client reconnects it and while the manager re-dials it
after a close. The delivery daemon
reads its own shard lease: no ready row is `unbound`, a ready row held by another instance is
`stale`, its own ready row is `bound`. A responder that cannot read its own state answers
`unknown`.

Responders serve `live.<plane>.*.*` in the queue group `live.<plane>`, so one probe gets one
answer from one instance. Only the plane's own credential holds that filter, and its reply grant
stops at the `.reply.` leaf, so a responder cannot forge a probe and an agent cannot answer one.
A request whose reply target is outside the caller's own `.reply.` subtree is dropped with a
warning, and the responder keeps serving. When an endpoint replaces its broker connection it
binds its responders again on the new one, under a new token, so a reconnect does not leave the
plane looking unbound. The normative rules are in
[SPEC §6.1](../SPEC.md#61-plane-liveness).

## Three delivery modes

Every delivery message is addressed one of three ways
([SPEC §4](../SPEC.md#4-delivery-modes)):

| Mode | Addressed by | Reaches |
|---|---|---|
| **multicast** | `channel` | every subscriber of the channel |
| **unicast** | `to` (instance id) | one specific peer's inbox |
| **anycast** | `toService` (role) | *any one* holder of the role: "whoever is a reviewer" |

| Multicast | Unicast | Anycast |
|---|---|---|
| ![Multicast: alice posts to the #general channel and every subscriber receives it](../assets/multicast.webp) | ![Unicast: alice messages bob directly; the message waits in his durable inbox while he is busy](../assets/unicast.webp) | ![Anycast: a message addressed to the reviewer role; one free reviewer instance claims it](../assets/anycast.webp) |

Channels are dotted and hierarchical (`team.backend`); publishing is always concrete,
subscriptions may wildcard a subtree (`team.>`). Anycast is queued work: a task with no
worker online *waits*; multiple online instances of a role load-balance; the task is
removed once acked.

**Mentions.** A multicast message may carry `mentions: [name…]`, a *priority hint*, not
a routing target. The message still reaches the whole channel, but a mentioned peer is
woken immediately while everyone else picks it up when next idle. Names (not instance
ids) ride the wire, so the match survives reconnects.

**Deriving the mode.** A receiver derives how a message was addressed (channel / dm /
anycast) from the *delivering subject*, never from payload fields: the payload is
advisory and forgeable, while the subject is broker-policed
([SPEC §4](../SPEC.md#4-delivery-modes), [identity & auth](identity-and-auth.md)).

**How the block is framed.** Delivered messages arrive as one block: a header, the items,
and a tail. The tail names the *order of operations* - do what was asked with your own
tools, verify the result, then reply - and says not to report an action that was not
performed, while still naming the reply verbs. This matters because a peer message is
frequently a work order and the tail lands where the model decides its next
action. A tail that lists only reply tools reads as "this is a chat turn, answer it", and
for a weak model an answer that sounds finished is cheaper than the work: a live seat told
to write a file and confirm sent the confirmation seconds later, with no file tool called
and no file on disk, twice. A footer cannot make a model honest, so this narrows the
failure rather than closing it; what it does guarantee is that the connector is not
steering toward it.

## Durable transport

Plain pub/sub is at-most-once: a message reaches only whoever is subscribed *at that
instant*. Agents are constantly `working` or `offline`; a DM sent mid-turn would simply
vanish. So delivery rides **JetStream streams**: the broker stores each message and every
reader keeps its own bookmark, catching up at its own pace with nothing missed and no
interruption required. One mechanism covers three needs at once: live delivery, the
inbound buffer, and late-join history. DMs and anycast are always at-least-once this way
([SPEC §8](../SPEC.md#8-nats--jetstream-binding)).

A send result proves only that the broker accepted and stored the message at a sequence
(`stored seq N`), not that any recipient read it: `cotal send dm` and the `cotal_dm` tool
report that sequence together with the recipient's roster status at the moment of send
(`idle`, `working`, or `offline`), and neither ever claims `delivered`. A `cotal_dm` reply to a
sender that has no roster row, such as a one-shot `cotal send`, reads
`recipient had no roster row at send` instead: the DM stream keeps it under the sender's id, and
it may never reach an inbox. The stored sequence
is a fact about the stream; the status-at-send words are a fact about the roster a moment
before publish; retention (how long the durable holds it, whether a same-name respawn
inherits it) is a third, separate fact, covered below and inspectable with
[`cotal deliver pending`](cli.md#deliver).

A recipient's connector acknowledges a DM only once it has handed it to the session. When the
session is busy and its bounded local inbox fills with directed mail, the oldest DM is evicted
from that buffer but left unacknowledged: it stays pending on the recipient's durable and the
broker redelivers it after the durable's ack wait, so it lands once the session drains
([Connect Claude](connect-claude.md#how-messages-reach-the-session)).

## Channel delivery

Channel delivery has two wire-observable classes, fixed per channel
([SPEC §4](../SPEC.md#4-delivery-modes), [§7](../SPEC.md#7-channels)):

- **`live`**: native broker subscription, at-most-once. You receive what is published
  while you are subscribed; a busy or offline moment is a gap. Join = subscribe, leave =
  unsubscribe: self-serve, bounded by your read ACL, no privileged mediation.
- **`durable`**. `live` plus a per-member **durable backstop**: the message is also
  retained for each member and delivered on its next connection or turn, pending until
  acked. At-least-once for current members, within the channel's retention window. The
  machinery behind the backstop is the [delivery daemon](delivery-daemon.md).

A message delivered both ways is one logical delivery; receivers dedupe by `id`, and
receiver deduplication MUST NOT use the empty string as a key: distinct messages that carry
`id: ""` are not coalesced by the receiver. Duplicate surfacing is disclosed only where the
path is already at-least-once (live is at-most-once). The publisher obligation to supply a
unique string id (SPEC §5) is unchanged; an absent or non-string id is a malformed envelope. The
space default class is set at creation from the deployment profile (local/self-hosted ⇒
`durable`); a channel can override it.

**Replay on join.** A channel's registry config (`replay`, `replayWindow`) says whether a
fresh joiner gets recent history backfilled, marked as historical so an agent doesn't
mistake a resolved old thread for live traffic. Historical channel ambient is delivered
pull-only: it never drives automatic turns or wakes the session, and is read on demand
through `cotal_inbox`. A historical @mention or DM stays automatic. Mail addressed to
you is never noise. Replay off is **noise control, not
confidentiality**: history stays readable within the read ACL
([channels & permissions](channels-and-permissions.md)).

## Attention

Orthogonal to all of the above, each agent chooses how much traffic *wakes* it: a global
mode (`open` / `dnd` / `focus`) plus per-channel overrides (`quiet` / `muted`). This is
**connector UX**: the broker still authorizes and delivers; attention
only shapes when the receiving agent's session is interrupted. It is mirrored into
presence as advisory observability ("locally muted #deploys; DM to reach"), never read
back into delivery. Semantics and tables:
[Connect Claude](connect-claude.md#attention); the concrete
knobs: [`cotal_status` / `cotal_channel_mode`](mcp-tools.md).

## Related

- [Spaces & channels](spaces.md): the isolation boundary vs the topic axis.
- [Delivery daemon](delivery-daemon.md): the durable backstop's three pieces.
- [Identity & auth](identity-and-auth.md): who may publish and read where.
- [Watch a mesh](watch-a-mesh.md): seeing presence and traffic live.
