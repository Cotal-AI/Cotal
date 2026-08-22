# Identity & auth

> **Concept** (informative) · **For:** operators and implementers · **Normative:** [SPEC §2](../SPEC.md#2-identity), [§9](../SPEC.md#9-nats--jetstream-security-and-authorization), [§10](../SPEC.md#10-connection-and-onboarding), [Appendix B](../SPEC.md#appendix-b-profile-acls)

Who can do what on a mesh, and how it is enforced. The design goal: the mesh is a **real
boundary against untrusted peers in a shared space**; an agent can only speak as itself
and only where its declared permissions allow, enforced by the broker, not by agent
goodwill. What that boundary does and does not protect is the
[security model](security.md); the exact ACLs are
[SPEC Appendix B](../SPEC.md#appendix-b-profile-acls).

## On by default

`cotal up` provisions a JWT-authed space; `cotal up --open` runs an unauthenticated dev
mesh instead. Both bind loopback by default. `--host 0.0.0.0` widens the bind
independently, so "network-reachable" never silently means "unauthenticated". Open mode
is for quick local experiments and sits outside every security claim
([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)).

## One identity, used everywhere

An agent's wire identity is a **principal**: an `owner.actor` pair, where the owner is
the account (a human, or an organization) the agent acts on behalf of, and the actor is
the agent's own handle under that owner ([SPEC §2](../SPEC.md#2-identity)). The same pair
is the card id, the sender tokens in every subject it publishes, the presence key, and
its durable-consumer names. On an open dev mesh the owner is the literal `local`; on a
per-user-auth mesh it is a derived token (`u_` plus 26 characters, so no PII rides the
wire). The connection still authenticates with an **nkey**, generated locally (the signer
only ever sees the public half), but the nkey is the transport credential, not the
identity: it scopes only the per-connection reply inbox.

**The sender is encoded in the subject.** Every publish carries the sender's owner and
actor in positions the broker's permissions pin to that connection, so an agent *cannot*
emit as anyone else: not as another owner, and not as a sibling actor under its own
owner. Receivers verify the payload's `from.id` against the subject sender and reject
mismatches; sender authenticity is broker-enforced end to end
([SPEC §3](../SPEC.md#3-subject-layout), [§5](../SPEC.md#5-envelopes)).

**Account = space, user = agent.** A space is one NATS account, a server-enforced
isolation boundary. An operator signs the account; an account **signing key** mints
per-agent user JWTs.

## The provisioner: a capability, not a role

The **provisioner** is whoever holds the account signing key. It mints profile-scoped
credentials and pre-creates the durables agents may only *bind* (their DM inbox, their
role's task queue). The manager hosts it today, but nothing is manager-special about it;
privilege attaches to the signer, and a space can run without a manager.
`cotal mint <name> --profile <agent|observer|admin>` is the out-of-band path; spawn calls
the same library ([CLI](cli.md)). Minting static creds is a **static-auth** surface: a
per-user-auth space refuses it, because agents there join under a logged-in user, never
via a handed-out file (see *Per-user auth* below).

## Profiles: default-deny allow-lists

Every credential is a profile: an explicit allow-list built from the same
subject/stream/durable builders as the wire layout, so ACLs cannot drift from it. The
normative shapes are [SPEC Appendix B](../SPEC.md#appendix-b-profile-acls); in brief:

| Profile | Is |
|---|---|
| **agent** | The ordinary peer: publishes as itself to its declared channels, reads within its read ACL + its own DM/task inboxes. |
| **observer** | Read-only chat + presence; DMs invisible. What `cotal console` runs. |
| **admin** | Elevated *read-only* god-view: sees DMs and anycast live, still writes nothing. A deliberate opt-in (`cotal web`). |
| operator-side | Narrow single-purpose creds for the machinery (supervising, provisioning, teardown, delivery); the reference implementation splits these so no one connection can read every DM *and* delete every stream ([security model](security.md)). |

**An agent's channel scope is three verbs**: `subscribe` (reads at boot),
`allowSubscribe` (read ACL), `allowPublish` (post ACL, default-deny), declared in its
[agent file](agent-files.md) or [manifest](manifest.md), minted into its cred. One card
with the recipes: [Channels & permissions](channels-and-permissions.md).

**DM confidentiality** holds against peers by construction: deliveries ride per-identity
inbox prefixes, and the DM/task consumers are provisioner-pre-created and bind-only, so an
agent cannot create a consumer filtered to someone else's inbox
([SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization) items 1–5).

## Capabilities: spawn is granted, not assumed

Control-plane power is a **declared capability**, not a default. An agent file carrying
`capabilities: [spawn]` gets the privileged control subject minted into its cred: spawn,
plus stop/despawn of its *own* children, plus persona definition. Without it, an agent can
only self-despawn. The tool surface mirrors the grant: `cotal_spawn` / `cotal_persona` are
injected only where they can actually succeed ([agent files](agent-files.md)). Destructive
operator ops (history purge, cross-agent stop) live on a third tier no agent credential
reaches. Persona redefinition separates content from policy; the write path takes only
`model`/`persona`, so a peer cannot grant itself a capability by redefining a file.

## Per-user auth: people sign in

`cotal up --user-auth --idp <auth base URL>` (or manifest `broker.auth: "user"`) puts a
**human identity plane** above the per-agent one: people sign in to an external IdP once,
and every connect is authorized live against the operator's **actor ledger**. No creds
files to hand out, and revoking a grant actually bites.

**The flow.** Each person runs `cotal login --idp <url>` once per machine. After that,
any command works: cached IdP session → fresh IdP proof per connect (so IdP-side
revocation bites here too) → the configured exchange turns it into a short-lived Cotal bearer →
the broker's **auth callout** checks the bearer and the ledger at connect time and mints
a scoped credential on the spot. Every bearer also names a **root credential** row in the
space's credential ledger, proved live at each connect, so revoking that one credential
bites at the very next connect. The operator grants access with
`cotal actor grant <actor> --sub <their id>`; a bare grant is the full envelope (all
channels, may spawn), and `--allow-subscribe` / `--allow-publish` / `--scope` narrow it.
No ledger row, no access; there is no allow-by-default.

**One auth service per space** hosts both halves: the NATS auth callout and the token
exchange. Its default HTTP listener remains loopback-only and requires the per-start capability
stored in the owner-only `auth-service.json` file. An operator may add a second listener with
`cotal up --user-auth ... --exchange-public-port <port> --exchange-public-url https://auth.example`.
That listener still binds `127.0.0.1`; put a reverse proxy in front of it and terminate TLS there.
In-process TLS is deliberately not another deployment mode: it would duplicate certificate renewal
and fork proxy-based deployments.

The public listener has a closed surface: `GET /health`, `GET /jwks`, `POST /exchange`, and
`GET /.well-known/cotal-mesh`; every other path is 404. It does **not** require the loopback
capability. That capability proves same-uid access to a 0600 local file and has no remote meaning;
on the public face the credential is the proof. A human presents an EdDSA IdP JWT checked against
the pinned JWKS, issuer, and audience. An agent presents its spawn-time actor token, whose hash must
match a fresh managed-ledger row. Elevated `view` exchanges stay loopback-only.

The well-known response contains the IdP pins and the actual deny-all sentinel credential remote
agents need before the bearer-driven auth callout. Treat it as bootstrap material: the sentinel
cannot publish or subscribe, but consumers must still take the bundle only from the intended HTTPS
origin and must verify TLS. `--exchange-trusted-proxy` opts into peer attribution by the **last**
`X-Forwarded-For` hop; use it only when the listener is reachable solely through a proxy you control.
Without it, forwarded headers are ignored and the socket address is the peer key. Public failure
buckets are per-source and separate from loopback exchange budgets. The in-process LRU retains at
most 1024 peer buckets: that bounds memory and isolates ordinary sources, but an attacker cycling
more than 1024 trusted-proxy last hops can evict earlier 429 state. It is not a mint bypass—a valid
credential is still required—so use upstream reverse-proxy rate limiting when that throttle-escape
matters to the deployment.

The service starts with the broker, is torn down by `cotal down`, and holds the
data-account signing key for the callout (a running manager is the other standing holder, for
the creds it mints); the operator seed never enters it. It also owns the space's two authority
stores (lifecycle records and the credential ledger), provisions them at boot, and refuses
connects it cannot credential-check against them; there is no fallback path. If it
dies while the broker lives, re-running `cotal up` heals it, and a boot whose auth
service never became ready exits non-zero, so automation never reads a dead identity
plane as success. Changing any public-listener flag requires `cotal down` followed by `cotal up`
with the new values; a refresh adopts an already-running auth service rather than silently replacing
its listener policy. "One per space" is enforced, not assumed (SPEC §13.13): at boot the
service takes a broker-backed ownership claim, so a second same-space auth process refuses
with instructions instead of silently splitting the plane, and a crashed one's claim is
reclaimed only once the broker confirms its connections are gone — a verdict trusted only
on a standalone broker (a clustered one refuses the reclaim, since a partitioned member
could still hold them). If the claim's connections die mid-run, the service downs itself
loudly instead of serving from a half-dead plane.

**Your agents are yours.** `cotal spawn` on a user mesh grants a managed actor under the
*spawning operator's* owner and launches the agent with a bearer command instead of a
creds file. The agent exchanges its spawn-time secret for short bearers (five minutes or
less) and refreshes ahead of each expiry. Rows are runtime grants: every start rotates
the secret, every stop or despawn revokes the row, so a non-running agent holds no
standing authority. Manifest deploys (`up -f`) stamp the logged-in owner into the launch,
so those agents are yours too.

**Despawn tears the lifecycle down, then frees the name.** When you despawn an agent, the manager
drives the *full* teardown of that lifecycle: it shreds the local credential files, revokes the
agent's standing mint authority (its ledger row, so a copied token can no longer mint a fresh
credential), deletes its broker footprint (the lifecycle-keyed durables + read-ACL row), and asks
the auth service to *retire* the lifecycle (settle in-flight work, evict the departed credentials,
record it retired). The name is held *reserved pending retirement* until **all** of that completes —
the broker-footprint cleanup, the standing-authority revoke, **and** the lifecycle retirement, not the
retirement alone — so a same-name respawn in the gap is refused with
a plain reason and a retry hint rather than quietly handing the alias to a new agent while
the old lifecycle's teardown is still running. Only once the broker footprint is gone, the standing
authority is revoked, and the retirement is confirmed does the name free, and `cotal spawn <same-name>`
gives you a fresh agent cleanly. This is what makes reusing an agent's name safe: the old lifecycle is
fully torn down before the new one takes the alias. If a step cannot complete — the auth service is
unreachable, or the standing-authority revoke fails — the despawn still stops the agent and *holds* the
name; **a same-name `cotal spawn` re-drives the whole teardown** and finishes it (retrying the despawn
does not — the agent is already stopped), and the operator copy tells you to recover the stack
(`cotal supervise`) rather than reusing the name over an unretired predecessor.

**Delegation only narrows (the envelope rule).** A user's grant is their envelope:
everything under their owner (their CLI, every agent they spawn, every agent those
spawn) stays within its channel lists and its capability scope. Handing a role to a
spawned agent needs the matching `role:<r>` capability in the spawner's scope. The whole
delegation chain is checked, not just the last link, and re-checked at every bearer
exchange, so narrowing a user's grant reaches their agents within minutes, and revoking
the user revokes everything under them, grandchildren included. A spawn beyond the
envelope is refused with the exact widening re-grant to ask the operator for.

**Control ops ride your own login**, gated by ledger scope. `spawn` covers launching,
`ps`, and stop/attach of the agents under **your own owner**: the owner is the
administrative boundary of its own subtree, so you (and your agents) manage what you own
without any extra grant. `admin` is the explicit opt-in for touching **other owners'**
agents; it is never part of a default grant and never accepted from a manifest.

**Elevated operator surfaces ride the same login** through a short-lived *view*: the
exchange stamps a server-authored view claim into the bearer, and the callout mints that
connection as the matching non-agent profile instead of `agent`. `cotal web` and
`cotal console` ask for the read-only admin view, `clean history` for the purger,
`channels set/default` for the channel-writer (all gated on ledger scope `admin`);
`up -f` deploys over the deployer view, gated on `spawn`, because deploying your own team
is spawn-grade (the manager still refuses a manifest claiming another owner). Views exist
only on a signed-in human exchange (an agent's managed exchange never mints one), are
authorized against the fresh ledger row at every connect, and expire with the bearer, so
narrowing or revoking a grant bites within minutes here too.

**A hard branch, not a fallback.** On a user-auth space, commands never fall back to
static minting or credless connects: a missing login or a down auth service is one
sentence naming the exact recovery, and static agent/observer/admin minting is refused
outright. The refusal is deny-new: a static cred signed before the space flipped stays
broker-valid until the signing key is rotated ([security model](security.md)).

## The IdP callout contract

Any OIDC identity provider that issues **EdDSA/Ed25519** JWTs plugs in here directly; a provider that
issues RS256 or ES256 tokens (many managed OIDC services do) needs a host-side normalization or
re-issuance adapter first, because the reference bridge pins the token algorithm to EdDSA. The
reference implementation ships **Better Auth** as a
dev and test fixture only (it is a `devDependency` of `@cotal-ai/auth`; the only code that imports
it is the `dev-idp.ts` harness and the smoke tests, never the runtime `src`). The one runtime
coupling to an IdP is the `idp.ts` bridge plus the `auth-provider` extension. The bridge core
(`createIdpBridge`) is IdP-generic for **EdDSA** tokens (issuer, audience, JWKS as configuration).
The stock end-to-end flow around it, though, is **Better-Auth-shaped**: `cotalAuthProvider` pins
`<base>/jwks` and issuer/audience to the IdP origin, and the login client speaks Better Auth's
device-code endpoints (`/device/code`, `/device/token`, `/token`) with an opaque revocable session.
So a Better-Auth-shaped EdDSA IdP uses the stock flow directly; **any other production IdP is a
hosted-composability gap, not a configuration change**. A host integrates it by building its own
login and provider wiring on the low-level primitives (`createIdpBridge`, `createUserTokenIssuer`),
not by reusing the stock provider. Note that importing `@cotal-ai/auth` self-registers
`cotalAuthProvider`, and `resolveAuthProvider()` throws when two providers are registered, so a host
on the registry-resolution path must not also register its own. Whatever the path, never loosen the
issuer/audience/JWKS pins to force-fit an IdP.

The bridge (`createIdpBridge`) exchanges a verified IdP token for a Cotal bearer in three steps:

1. **Bearer validation.** Verify the IdP's JWT offline against its **pinned JWKS**, with the token
   algorithm pinned to EdDSA. Keys resolve only through the pinned JWKS: a token carrying embedded
   key material (`jku`/`jwk`/`x5u`/`x5c`) is rejected, so the token can never influence key
   resolution. Issuer and audience are checked, and the minted Cotal bearer is capped to the
   upstream proof's remaining lifetime.
2. **Owner derivation.** The opaque per-space owner derives deterministically from the JSON-array
   encoding of `[idp issuer, sub]`, namespaced by issuer so no issuer/sub pair can straddle a
   delimiter, and re-login re-lands the same person in the same lanes. The owner-token *format*
   (`u_` followed by 26 base32-lower characters) is normative
   ([SPEC section 2](../SPEC.md#2-identity)). At the contract level the *derivation* from an
   identity is a pluggable edge, but the reference `createIdpBridge` fixes it
   (`deriveOwnerForIdpSubject`) and takes no derivation callback, so what a host configures is the
   IdP, not the derivation. **The encoding is frozen:** changing it, or changing the IdP issuer
   string, re-keys every owner in the space, which is a migration on the order of rotating the space
   secret.
3. **Actor authorization and mint.** The operator's ledger hook authorizes the `(owner, actor)` pair
   and is the only source of the bearer's `scope`/`parent`; the issuer then mints the Cotal bearer,
   re-asserting every claim shape.

A host wires this with the IdP's own coordinates and nothing from `@cotal-ai/auth` changes:

```ts
import { createIdpBridge, pinnedJwksResolver, createUserTokenIssuer } from "@cotal-ai/auth";
const bridge = createIdpBridge({
  idp: { issuer: idpIssuer, audience, key: pinnedJwksResolver(jwksUri) }, // your production IdP
  space,
  spaceSecret,                 // identity-plane owner-derivation secret (>=32 bytes), held by the auth service at runtime
  issuer: createUserTokenIssuer({ issuer: cotalIssuer, key: signingKey }), // mints the Cotal bearer
  authorizeActor: (owner, actor) => grantFromLedger(owner, actor), // your ledger, returns an ActorGrant
});
```

## Joining

A single **join link** carries server, auth, and space
([SPEC §10](../SPEC.md#10-connection-and-onboarding)):

```
cotals://<token>@host:4222/<space>?channel=general   # cotals:// = TLS required; cotal:// = TLS not required (downgrade-tolerant)
```

Humans: `cotal join --link …`. Agents: `COTAL_LINK=… ` in the environment. The connector
expands it and auto-joins. Token/user-pass links are the open-mode path; the default
authed path threads a minted creds file, and the endpoint adopts the credential's identity
as its card id. A seat the manager spawned reaches that file through its **launch
material** rather than through `COTAL_CREDS` in an environment every descendant process
inherits (see [Configuration](config.md#launch-material)); a session you drive by hand
still sets `COTAL_CREDS` itself.

## Honest limitations (v0)

- **The signing key is hot** on the mint/manager box of a static-auth mesh; the "real
  boundary" holds given operator-controlled cred distribution. On a per-user-auth mesh
  the data-account signing key is held by the auth service (the callout stage) and by any
  running manager, which loads the trust bundle and self-mints its supervisor cred and
  renewals from it; a copied signing *seed* still stays valid for its identity until the
  signing key is rotated. Rotation remains the revocation lever for trust material.
- **The two `$SYS` creds are renewed by rotation, not in place.** `membership-observer` and
  `connection-evictor` are signed by the system-account seed, which is never persisted, so no
  running process re-signs them: they carry a 30-day expiry and are renewed by issuing a new
  system account (`cotal down` then `cotal up --rotate-sys`), which leaves the data account,
  every agent cred and the store untouched but does invalidate earlier full backups (they bind to
  the operator JWT and system account they were taken under, so re-run `cotal backup` after). Past that horizon the mesh keeps delivering, but the
  membership feed and live eviction stop; `cotal doctor auth` and the manager warn from the 75%
  point onward.
- **Static agent creds are long-lived; the machinery's are not.** One-shot command creds
  expire in minutes and the standing daemon creds in 24h with the manager renewing them
  (`cotal doctor auth` is the one diagnosis and repair surface). But a static *agent*
  cred has no TTL yet: `cotal_despawn` cuts a session, not a credential, and a
  compromised agent that copied its creds can reconnect until the signing key is
  rotated. Per-user-auth spaces close this: bearers live minutes, `cotal actor revoke`
  denies the next exchange and the next connect and evicts the principal's live
  connections immediately.
- **Not non-repudiation.** Authenticity is broker-enforced, not portable proof; it does
  not survive an untrusted relay. Signed envelopes are reserved
  ([SPEC §11](../SPEC.md#11-versioning-and-extensibility)).
- **Chat metadata leaks in-space.** Content reads are ACL-bounded; stream metadata
  (channel names, per-subject counts) is not yet ([security model](security.md)).

**Denials are loud, never silent.** A publish outside an ACL surfaces as a logged denial
("denied, not absent") on the endpoint's error path; an over-tight ACL never looks like a
missing peer ([run a mesh](run-a-mesh.md)).
