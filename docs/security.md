# Security model

> Cotal v0 provides containment and sender authenticity for peers sharing one trusted NATS
> broker. It is not an end-to-end encrypted or untrusted-relay protocol. This is the threat
> model referenced by [SPEC.md](../SPEC.md) §9; where the two disagree, the spec wins.

## Trust boundary

- One Cotal space maps to one NATS account.
- The broker, operator, account signing key holder, and any `admin` credential are trusted.
- Agents are not trusted to self-report sender identity, channel permissions, or DM access.

## Adversaries

Each adversary, what it can attempt, and what stops it (or why it is out of scope).

- **Compromised or malicious peer agent** (authenticated, in-space): the primary adversary.
  It cannot forge another agent's `from.id` (the subject sender is bound to its nkey by NATS
  permissions), cannot publish to channels outside its declared allow-list, and cannot read
  another agent's DMs or another role's work queue (per-identity inbox prefixes plus bind-only
  durables, §9). It still can send well-formed hostile content to channels it is allowed on
  (see *Prompt-facing data*) and flood within its limits (see *availability* under *What v0
  does not protect*).
- **Buggy or lazy receiver:** sender authenticity depends on the receiver enforcing the
  `from.id`-equals-subject-sender check; a client that skips it accepts spoofed senders. The
  check is therefore normative: receivers MUST reject on mismatch (SPEC §5, §12).
- **On-path network attacker** (between an agent and the broker): defeated only when the join
  link uses `cotals://` (TLS required). Plain `cotal://` is cleartext on the wire, for trusted
  networks and dev only.
- **Content author targeting a reading model:** any writer of channel `description` /
  `instructions`, presence `activity`, message bodies, or free-form metadata can attempt
  prompt injection against an agent that reads it. See *Prompt-facing data*.
- **Untrusted broker, relay, operator, or admin:** out of scope by definition. The broker and
  any `admin` credential can read, drop, replay, or alter all plaintext traffic. v0 makes no
  claim against a hostile broker; signed envelopes and untrusted-relay bindings are reserved
  for a later version.

## What v0 protects

- **Sender authenticity:** the sender id is encoded in the subject and enforced by NATS
  permissions. Receivers MUST reject payloads whose `from.id` does not match the subject sender
  (SPEC §5).
- **Space containment:** account boundaries keep one space's subjects, streams, and KV buckets
  isolated from another; a client in one account cannot reach another's subjects unless
  explicitly exported and imported.
- **Channel publish scope:** agent credentials allow chat publish only as self and only to its
  declared `allowPublish` channel patterns — a default-deny allow-list (no channel is granted
  unless declared).
- **Channel read scope:** agent reads are bounded to the `allowSubscribe` ACL. The multi-channel
  live-tail durable is bind-only (the agent can't widen its own filter; runtime join/leave is
  mediated and validated against `allowSubscribe`), and history reads ride single-filter consumer
  creates with one grant per `allowSubscribe` channel — the server pins each create's filter to the
  request body, so no other channel is reachable. There is no unfiltered Direct Get grant.
  - **Known metadata leak (not content):** agents hold `STREAM.INFO` on the CHAT stream (needed for
    the join watermark, the focus-recall drop-marker, and channel-list counts). A `subjects_filter`
    query over it enumerates retained chat *subjects* — channel names, sender ids, and per-subject
    message counts — across the whole stream, including channels outside `allowSubscribe`. This is
    **metadata, never message content**, and channel *names* are already public (the channel
    registry is world-readable). Hiding even the existence/volume of other channels requires the
    channel-major / per-channel-stream model and is part of the deferred strict-containment work.
- **DM/TASK peer confidentiality:** delivery uses per-identity inbox prefixes, and DM/TASK
  consumers are provisioner-created bind-only durables, so an agent cannot create a consumer
  filtered to someone else's inbox or another role's work queue.
- **Transport secrecy (optional):** `cotals://` enforces TLS for the hop to the broker. It
  protects that hop, not the broker itself.

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
  band.
- **Manager compromise:** the operator side is split into narrow, single-purpose profiles (there
  is **no allow-all cred**) — the long-lived **supervisor** serves control and touches
  presence/its lease but cannot read a DM, create a consumer, or delete a stream; the destructive
  verbs (`STREAM.DELETE`/`PURGE`, cross-agent stop, per-agent provisioning) ride ephemeral
  per-command creds (teardown / control-caller-admin / deployer / provisioner). What stays hot is
  the account **signing key** on the mint/manager box — a compromise there can still mint fresh
  creds — and confining it is the auth-callout stage.

## Prompt-facing data

Channel `description` and `instructions`, presence `activity`, message bodies, and free-form
metadata may reach models. Writers that can set channel registry text are privileged, and
registry text is length-bounded, but clients MUST still render all of it as attributed,
advisory data, never as trusted system instruction. This is the indirect-prompt-injection
surface common to agent protocols (MCP tool descriptions, A2A agent cards): Cotal's position is
that the reading client, not the wire, is the trust boundary for model-facing text.

## Reporting

Report a suspected vulnerability privately to the maintainers rather than in a public issue.
