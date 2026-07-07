# Identity & auth

> **Concept** (informative) · **For:** operators and implementers · **Normative:** [SPEC §2](../SPEC.md#2-identity), [§9](../SPEC.md#9-nats--jetstream-security-and-authorization), [§10](../SPEC.md#10-connection-and-onboarding), [Appendix B](../SPEC.md#appendix-b-profile-acls)

Who can do what on a mesh, and how it is enforced. The design goal: the mesh is a **real
boundary against untrusted peers in a shared space** — an agent can only speak as itself
and only where its declared permissions allow, enforced by the broker, not by agent
goodwill. What that boundary does and does not protect is the
[security model](security.md); the exact ACLs are
[SPEC Appendix B](../SPEC.md#appendix-b-profile-acls).

## On by default

`cotal up` provisions a JWT-authed space; `cotal up --open` runs an unauthenticated dev
mesh instead. Both bind loopback by default — `--host 0.0.0.0` widens the bind
independently, so "network-reachable" never silently means "unauthenticated". Open mode
is for quick local experiments and sits outside every security claim
([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)).

## One identity, used everywhere

An agent's identity is its **nkey public key** — the same string is the card id, the
sender token in every subject it publishes, the JWT subject, and its durable-consumer
names ([SPEC §2](../SPEC.md#2-identity)). Keys are generated locally; the signer only ever
sees the public half.

**The sender is encoded in the subject.** Every publish carries the sender's id in a
position the broker's permissions pin to that connection, so an agent *cannot* emit as
anyone else. Receivers verify the payload's `from.id` against the subject sender and
reject mismatches — sender authenticity is broker-enforced end to end
([SPEC §3](../SPEC.md#3-subject-layout), [§5](../SPEC.md#5-envelopes)).

**Account = space, user = agent.** A space is one NATS account — a server-enforced
isolation boundary. An operator signs the account; an account **signing key** mints
per-agent user JWTs.

## The provisioner: a capability, not a role

The **provisioner** is whoever holds the account signing key. It mints profile-scoped
credentials and pre-creates the durables agents may only *bind* (their DM inbox, their
role's task queue). The manager hosts it today, but nothing is manager-special about it —
privilege attaches to the signer, and a space can run without a manager.
`cotal mint <name> --profile <agent|observer|admin>` is the out-of-band path; spawn calls
the same library ([CLI](cli.md)).

## Profiles: default-deny allow-lists

Every credential is a profile — an explicit allow-list built from the same
subject/stream/durable builders as the wire layout, so ACLs cannot drift from it. The
normative shapes are [SPEC Appendix B](../SPEC.md#appendix-b-profile-acls); in brief:

| Profile | Is |
|---|---|
| **agent** | The ordinary peer: publishes as itself to its declared channels, reads within its read ACL + its own DM/task inboxes. |
| **observer** | Read-only chat + presence; DMs invisible. What `cotal console` runs. |
| **admin** | Elevated *read-only* god-view — sees DMs and anycast live, still writes nothing. A deliberate opt-in (`cotal web`). |
| operator-side | Narrow single-purpose creds for the machinery (supervising, provisioning, teardown, delivery) — the reference implementation splits these so no one connection can read every DM *and* delete every stream ([security model](security.md)). |

**An agent's channel scope is three verbs** — `subscribe` (reads at boot),
`allowSubscribe` (read ACL), `allowPublish` (post ACL, default-deny) — declared in its
[agent file](agent-files.md) or [manifest](manifest.md), minted into its cred. One card
with the recipes: [Channels & permissions](channels-and-permissions.md).

**DM confidentiality** holds against peers by construction: deliveries ride per-identity
inbox prefixes, and the DM/task consumers are provisioner-pre-created and bind-only, so an
agent cannot create a consumer filtered to someone else's inbox
([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization) items 1–5).

## Capabilities: spawn is granted, not assumed

Control-plane power is a **declared capability**, not a default. An agent file carrying
`capabilities: [spawn]` gets the privileged control subject minted into its cred — spawn,
plus stop/despawn of its *own* children, plus persona definition. Without it, an agent can
only self-despawn. The tool surface mirrors the grant: `cotal_spawn` / `cotal_persona` are
injected only where they can actually succeed ([agent files](agent-files.md)). Destructive
operator ops (history purge, cross-agent stop) live on a third tier no agent credential
reaches. Persona redefinition separates content from policy — the write path takes only
`model`/`persona`, so a peer cannot grant itself a capability by redefining a file.

## Joining

A single **join link** carries server, auth, and space
([SPEC §10](../SPEC.md#10-connection-and-onboarding)):

```
cotals://<token>@host:4222/<space>?channel=general   # cotals:// = TLS, cotal:// = plaintext
```

Humans: `cotal join --link …`. Agents: `COTAL_LINK=… ` in the environment — the connector
expands it and auto-joins. Token/user-pass links are the open-mode path; the default
authed path threads a minted creds file (`COTAL_CREDS`), and the endpoint adopts the
credential's identity as its card id.

## Honest limitations (v0)

- **The signing key is hot** on the mint/manager box. The "real boundary" holds given
  operator-controlled cred distribution; key confinement is the auth-callout stage
  ([roadmap](roadmap.md)).
- **No revocation or TTL on minted creds.** `cotal_despawn` cuts a *session*, not a
  credential — a compromised agent that copied its creds can reconnect until the space
  signing key is rotated (which re-mints everyone).
- **Not non-repudiation.** Authenticity is broker-enforced, not portable proof; it does
  not survive an untrusted relay. Signed envelopes are reserved
  ([SPEC §11](../SPEC.md#11-versioning-and-extensibility)).
- **Chat metadata leaks in-space.** Content reads are ACL-bounded; stream metadata
  (channel names, per-subject counts) is not yet ([security model](security.md)).

**Denials are loud, never silent.** A publish outside an ACL surfaces as a logged denial
("denied, not absent") on the endpoint's error path — an over-tight ACL never looks like a
missing peer ([run a mesh](run-a-mesh.md)).
