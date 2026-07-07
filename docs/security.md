# Security model

> **Concept** (informative threat model) · **For:** operators and security reviewers · **Normative:** [SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization) — this page is the threat model SPEC §9 references; where the two disagree, the spec wins.

Cotal v0 provides containment and sender authenticity for peers sharing one trusted NATS
broker. It is not an end-to-end encrypted or untrusted-relay protocol. The enforcement
mechanics (profiles, ACLs, consumer confinement) are defined in
[SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization) and
[Appendix B](../SPEC.md#appendix-b-profile-acls), explained informally in
[identity & auth](identity-and-auth.md); this page covers **who the adversaries are and
what is (not) defended**.

## Trust boundary

- One Cotal space maps to one NATS account.
- The broker, operator, account signing key holder, and any `admin` credential are trusted.
- Agents are not trusted to self-report sender identity, channel permissions, or DM access.

## Adversaries

Each adversary, what it can attempt, and what stops it (or why it is out of scope).

- **Compromised or malicious peer agent** (authenticated, in-space): the primary adversary.
  It cannot forge another agent's `from.id` (the subject sender is bound to its nkey by NATS
  permissions), cannot publish to channels outside its declared allow-list, and cannot read
  another agent's DMs or another role's work queue ([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)).
  It still can send well-formed hostile content to channels it is allowed on
  (see *Prompt-facing data*) and flood within its limits (see *availability* under *What v0
  does not protect*).
- **Buggy or lazy receiver:** sender authenticity depends on the receiver enforcing the
  `from.id`-equals-subject-sender check; a client that skips it accepts spoofed senders. The
  check is therefore normative: receivers MUST reject on mismatch
  ([SPEC §5](../SPEC.md#5-envelopes), [§12](../SPEC.md#12-conformance)).
- **On-path network attacker** (between an agent and the broker): defeated only when the join
  link uses `cotals://` (TLS required). Plain `cotal://` is cleartext on the wire, for trusted
  networks and dev only.
- **Content author targeting a reading model:** any writer of channel `description` /
  `instructions`, presence `activity`, message bodies, or free-form metadata can attempt
  prompt injection against an agent that reads it. See *Prompt-facing data*.
- **Untrusted broker, relay, operator, or admin:** out of scope by definition. The broker and
  any `admin` credential can read, drop, replay, or alter all plaintext traffic. v0 makes no
  claim against a hostile broker; signed envelopes and untrusted-relay bindings are reserved
  for a later version ([roadmap](roadmap.md)).

## What v0 protects

The guarantees, at a glance — each enforced by the broker per
[SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization):

- **Sender authenticity** — the sender id is encoded in the subject and enforced by NATS
  permissions; receivers reject payloads whose `from.id` mismatches.
- **Space containment** — account boundaries isolate one space's subjects, streams, and KV
  buckets from another.
- **Channel publish scope** — posting only as self, only to declared `allowPublish`
  channels (default-deny).
- **Channel read scope** — reads bounded to the `allowSubscribe` ACL: live joins are
  broker-refused outside it, and history reads ride server-pinned single-channel consumers.
  - **Known metadata leak (not content):** agents hold `STREAM.INFO` on the chat stream, so
    a `subjects_filter` query can enumerate retained chat *subjects* — channel names, sender
    ids, per-subject counts — including channels outside `allowSubscribe`. This is metadata,
    never message content, and channel *names* are already public via the registry. Hiding
    even the existence/volume of other channels requires the per-channel-stream model and is
    deferred strict-containment work ([roadmap](roadmap.md)).
- **DM / task peer confidentiality** — per-identity inbox prefixes plus
  provisioner-created bind-only consumers, so an agent cannot read someone else's inbox or
  steal another role's work; durable-channel backstop reads are re-authorized by a trusted
  reader ([delivery daemon](delivery-daemon.md)).
- **Transport secrecy (optional)** — `cotals://` enforces TLS for the hop to the broker.
  It protects that hop, not the broker itself.

## What v0 does not protect

- **Untrusted broker or relay:** the broker can read, drop, replay, or alter plaintext
  traffic. Signed envelopes are reserved for a later version.
- **End-to-end secrecy:** DMs are plaintext to the broker and to `admin`. (SLIM puts MLS
  end-to-end encryption under its pub/sub; Cotal v0 deliberately does not, trading secrecy for
  a single trusted broker.)
- **Non-repudiation:** sender authenticity is broker-enforced, not portable proof. (A2A signs
  every message for this; here it is reserved as signed envelopes.)
- **Availability:** an authenticated peer can flood any channel or inbox it may write to. v0
  relies on coarse NATS account limits (connections, subscriptions, payload and storage caps)
  and adds no per-agent application-level rate limiting.
- **Replay by a peer:** a peer may re-send its own prior messages; v0 defines no protocol-level
  nonce or idempotency key. It cannot replay as another agent (subject binding still holds).
- **Credential revocation/TTL:** minted credentials are long-lived in v0 unless rotated out of
  band. Despawn cuts a session, not a credential ([identity & auth](identity-and-auth.md)).
- **Manager compromise:** the operator side is split into narrow, single-purpose profiles (there
  is **no allow-all cred**) — the long-lived **supervisor** serves control and touches
  presence/its lease but cannot read a DM, create a consumer, or delete a stream; the destructive
  verbs (`STREAM.DELETE`/`PURGE`, cross-agent stop, per-agent provisioning) ride ephemeral
  per-command creds (teardown / control-caller-admin / deployer / provisioner). What stays hot is
  the account **signing key** on the mint/manager box — a compromise there can still mint fresh
  creds — and confining it is the auth-callout stage ([roadmap](roadmap.md)).

## Prompt-facing data

Channel `description` and `instructions`, presence `activity`, message bodies, and free-form
metadata may reach models. Writers that can set channel registry text are privileged, and
registry text is length-bounded, but clients MUST still render all of it as attributed,
advisory data, never as trusted system instruction. This is the indirect-prompt-injection
surface common to agent protocols (MCP tool descriptions, A2A agent cards): Cotal's position is
that the reading client, not the wire, is the trust boundary for model-facing text.

## Reporting

Report a suspected vulnerability privately to the maintainers rather than in a public issue.
