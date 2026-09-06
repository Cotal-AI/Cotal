# Multi-space daemons: one process, N spaces

> **Design** (non-normative, not shipped) · Builds on [per-space lifecycle](per-space-lifecycle.md),
> [space segmentation](space-segmentation-p7-p1.md) and [U2](u2-resolver-cas.md); it does not restate
> them. Answers the hosted half of [embedding](../embedding.md) gap 3 and the
> [roadmap](../roadmap.md) "Multi-space brokers" row. **Wire contract unchanged** (§10).

## 1. The question this settles

A hosted embedding runs thousands of spaces on one broker. The trust layer already holds them. The
daemons do not: every server-side daemon takes `--space` and serves one, so the hosted shape today is
three processes per tenant, whether that tenant has a hundred agents or none.

| Daemon | Per space today | At 2,000 spaces |
|---|---|---|
| auth-service | 1 process, 1 callout connection, 6 standing authority-plane connections plus a conditional admin listener, 1 or 2 HTTP listeners | 2,000 processes, upwards of 14,000 connections, up to 4,000 listeners |
| delivery | 1 process, its Plane-3 and membership connections, 1 delivery lease | 2,000 processes, 2,000 leases |
| manager | 1 process per space, supervising that tenant's agents | 2,000 supervisor processes on platform machines |

The cost is per tenant, not per unit of load, and an idle tenant costs the same as a busy one. This
document specifies the multi-space mode of each daemon, the broker-account mechanism that survives
the tenant count, and the migration into it.

**The broker this design assumes is one nats-server process.** That is not a simplification for
brevity. SPEC 13.13 makes a plane-reclaim `gone` verdict valid only under the single-nats-server-process
boundary, and says a clustered deployment needs an authoritative server incarnation/roster authority
in place of that proof (`SPEC.md:3554`, `:3568`). This design supplies no such authority, so it does
not claim the clustered case. Everything below holds for N spaces on one broker process; the cluster
waits on prerequisite P9. The resolver mechanism in §6 is worth having either way, because what it
replaces is a config rewrite, not a cluster feature.

## 2. What exists today

Read in this tree at the cited line. §6.2's rows about nats-server are marked there and were read in
`nats-server` v2.14.6, not in this tree.

| Fact | Where |
|---|---|
| `runAuthService` refuses to start without `--space` | `implementations/auth/src/service.ts:611`, `:614` |
| Each space owns a dedicated auth-callout account, minted with `authorization { auth_users, allowed_accounts, xkey }` | `implementations/auth/src/callout.ts:79`, `:95` |
| That callout account's `allowed_accounts` names the space's data account, so the two accounts are a pair | `implementations/auth/src/callout.ts:97` |
| The callout is one subject, served on a connection authenticated into that account | `implementations/auth/src/callout.ts:40`, `service.ts:691` |
| `startAuthCallout` already takes the account material, space, issuer and authorizer per call | `implementations/auth/src/service.ts:694` |
| The authority plane is 6 standing self-minted connections plus a conditional admin listener, gated by one plane claim; a mid-life scanner death FENCES it | `implementations/auth/src/service.ts:164`, `:148`, `:521` |
| The auth service already holds its space's data-account signing seed: the plane and the callout both mint from it | `implementations/auth/src/service.ts:684`, `:697` |
| The plane already speaks that space's delivery-admin rail, for the liveness oracle and the evictor | `implementations/auth/src/service.ts:253`, `:287` |
| A fenced plane exits the whole process | `implementations/auth/src/service.ts:805`, `:808` |
| Both HTTP faces resolve routes by exact-match lookup on the whole URL | `implementations/auth/src/service.ts:954`, `:1274` |
| The public face is loopback-bound behind the operator's reverse proxy | `implementations/auth/src/service.ts:745`, `:766` |
| Public admission budget is process-global | `implementations/auth/src/service.ts:124`, `:1261` |
| The discovery bundle is composed per space and its base URL is finalized after bind | `implementations/auth/src/service.ts:1165`, `:1199` |
| Clients derive `/exchange` and `manager-service-authority` from an opaque pinned base | `implementations/auth/src/service.ts:1202`, `provider.ts:389` |
| The non-seam state dir comes from an ambient root walk, in both daemons | `implementations/auth/src/service.ts:649`, `implementations/delivery/src/delivery.ts:204` |
| Auth store keys are already space-scoped through the guarded encoder | `implementations/auth/src/store.ts:58`, `auth-paths.ts:95`, `:125` |
| The encoder refuses `""`, `.` and `..` before any path exists | `packages/workspace/src/auth-paths.ts:46`, `:49`, `:56` |
| `runDelivery` is single-space, pins its account from its own creds, and refuses sharding | `implementations/delivery/src/delivery.ts:156`, `:205`, `:162` |
| Membership authority already takes the account id as a parameter | `implementations/delivery/src/delivery.ts:310`, `membership.ts:30` |
| The delivery daemon re-reads its cred from the store at 75% of the JWT lifetime; it holds no signer and mints nothing | `implementations/delivery/src/delivery.ts:83`, `:222` |
| The delivery lease is per space; the broker-gone watchdog exits the process | `delivery.ts:246`, `:392`, `:408` |
| The manager reads the space's signer from its store and self-mints its supervisor cred from it in static mode | `implementations/manager/src/manager.ts:1103`, `:1165` |
| The only scheduled re-signer of the two daemon creds is the manager; the only other caller is an operator repair command | `manager.ts:1239`, `:1240`, `:1274`, `:1285`, `renewal.ts:98`, `implementations/cli/src/commands/doctor.ts:99` |
| `remoteAuthority` exists so the host holds no participant seed | `implementations/manager/src/manager.ts:317` |
| A system-account user with no permissions block is broker admin, so every `$SYS` profile is an explicit allowlist | `packages/core/src/provision.ts:2338` |
| The two `$SYS` profiles that exist are an account-scoped CONNZ observer and a KICK-only evictor | `packages/core/src/provision.ts:2348`, `:2398` |
| Neither can reach `$SYS.REQ.CLAIMS.*`; the observer is asserted to be refused `CLAIMS.LIST` | `packages/core/src/provision.ts:2340`, `packages/core/smoke/membership-feed-confinement.smoke.ts:138` |
| The system-account signing seed is in memory only while a space is provisioned, so a `$SYS` cred cannot be re-minted later | `packages/core/src/provision.ts:2370`, `:2413` |
| `serverConfig` renders `resolver: MEMORY` with a preload map of every account | `packages/core/src/provision.ts:2493`, `:2553` |
| Data accounts are minted with unlimited JetStream storage | `packages/core/src/provision.ts:341`, `:345`, `:461` |
| Runtime records are already per space | `packages/workspace/src/local-process.ts:56`, `:72` |
| A plane-reclaim `gone` verdict is valid only under one nats-server process; a cluster needs an incarnation/roster authority | `SPEC.md:3554`, `:3568` |

Four of these decide the design. The callout is served *inside* each space's own account, so routing
by account is structural rather than something to add. Every per-space name already routes through one
encoder, so multiplexing renames nothing. Every process-fatal exit was written when a process meant a
space, so each one has to be re-read as a question about blast radius. And the auth service already
holds the per-space data-account signing seed, which is what makes §5.2 possible and what §5.1 has to
be honest about.

## 3. The auth service in multi-space mode

### 3.1 The unit of multiplexing is the account

Accounts do not share a subject space. A callout request can therefore only arrive on the
connection belonging to the account it came from, and `$SYS.REQ.USER.AUTH` means "this account's
connects" on each of them. Routing the callout by account needs no demultiplexer, no space field in
the request, and no subject change: it is one connection and one subscription per space, and
`startAuthCallout` is already parameterized per call (`service.ts:694`). N spaces is N calls to a
function that never assumed it was the only one.

| Element | Single-space today | Multi-space |
|---|---|---|
| callout connection and subscription | one | one per space, from that space's callout creds |
| authority plane (6 standing connections plus a conditional admin listener, one plane claim) | one | one per space |
| loopback face | one listener | one listener, space in the path |
| public face and discovery bundle | one listener, one bundle | one listener, one bundle per space |
| ledger and IdP pin dir | `userAuthStateDir(root, space)` | the same call, N dirs |
| store material | `auth/<segment>/*.json` | the same keys, N spaces |
| public admission budget | process-global | per space, under a process cap (R1) |
| broker address, TLS, listener ports | process-wide | unchanged, process-wide |
| the space's data-account signing seed | held in process | N held in one process (§5.1) |

### 3.2 The public face and the space in the path

Both faces look a route up by exact match on the whole URL (`service.ts:954`, `:1274`). Multi-space
mode splits the path once at the front, `/s/<space>/<route>`, and then performs the same closed-table
lookup with the same handlers. The table stays closed, so an unknown path is still a 404, and the
space segment is validated by the same guarded encoder that names its dirs and store keys
(`auth-paths.ts:46`, `:49`, `:56`), so an empty, `.` or `..` space is refused before any handler or
path exists.

No client changes, because no client knows the prefix exists. The bundle carries an opaque base URL:
`finalizeUserBundleEndpoint` sets `endpoints.url` after bind and derives `managerAuthorityUrl` from
it (`service.ts:1199`), and `pinnedExchangeUrl` appends `/exchange` to the pinned base and strips
search and hash (`provider.ts:389`). A bundle whose base is `https://<host>/s/<space>` produces the
prefixed exchange URL through code that was never told what a space prefix is.

Two consequences for the composer. It runs once per space rather than once at boot, which it is
already shaped for (`composeUserBundle` takes the space and that space's sentinel creds,
`service.ts:1165`). And the advertised public base becomes a function of the space, not one flag:
single-space mode advertises the base it is given and serves unprefixed paths, multi-space mode
advertises base + `/s/<space>` and serves prefixed ones. A process is one shape or the other,
decided at start. The invariant is that the base recorded for a space resolves, over the whole
request path a client actually traverses, to what the face serves for that space. During the
migration the reverse proxy is part of that path (§9), so a recorded base with no prefix and a
prefixed face are consistent as long as the proxy rewrite is what closes the gap.

### 3.3 Per-space state needs no new mechanism

P7/P1 already did this work. `userAuthStateDir(root, space)` (`auth-paths.ts:125`) and the store keys
`auth/<spaceSegment>/…` (`store.ts:58`) both route through the one guarded encoder
(`auth-paths.ts:95`). A multi-space process holds N of each, no layout changes, and no key is
renamed. That is what makes §9 a topology migration rather than a re-keying.

What does change is the root. `findCotalRoot()` is a cwd walk, and both daemons do it: the auth
service for its state dir (`service.ts:649`) and the delivery daemon for its `$SYS` scan root, on the
injected-store path as much as the workstation one (`delivery.ts:204`). A cwd walk is right for a
workstation and wrong for a process serving N tenants. The state base becomes an injected option in
both (prerequisite P2). This is the same ambient-dir gap the embedding page already records; the
multi-space mode makes it structural rather than a footnote.

### 3.4 Hot add and remove

`add(space)` requires the material in the store and both of the space's accounts already trusted by
the broker (§6.4): the callout connection cannot authenticate into an account the broker does not
know. Then, in order: open the authority plane (which takes the plane claim), open the callout
connection, flush so the subscription is on the broker, compose the bundle, register the path
prefix. The prefix is registered last because it is the readiness signal, for the same reason the
discovery file is written only once every plane is bound (`service.ts:774`). An add that fails at any
step registers no prefix, so a half-bound space is unreachable rather than half-serving.

`remove(space)` is the reverse: unregister the prefix, drain what is in flight, close the callout
connection, close the plane so the claim is released, drop the bundle. The account pair is retired at
the broker afterwards, never before (§6.8).

Neither restarts the process. Neither touches another space's connections, dirs, keys or budget.

## 4. The delivery daemon in multi-space mode

### 4.1 One unit per space, N units per process

Everything `runDelivery` holds is derived from one space's creds: the cred source and its
75%-of-lifetime reload, the endpoint, the Plane-3 fan-out writer, the timer writer, the delivery
lease. The account it may touch is pinned from the creds themselves and admission-checked
(`delivery.ts:205`). A multi-space daemon is N of those units in one process, each with its own cred
source and its own reload timer. Nothing in the unit is a singleton by nature; it is a singleton
today because the process is.

The unit reads creds and never signs them (`delivery.ts:83`, `:222`). That stays true at N spaces,
and it is why the re-signer lives elsewhere (§5.2). A multi-space delivery process must not acquire a
signer: it would put N tenants' signing seeds into a second address space for no gain.

### 4.2 Membership authority per account

`startMembership({ space, server, accountId }, store)` already takes the account as a parameter
(`delivery.ts:310`, `membership.ts:30`), and is given the id pinned from the delivery creds. Two
units in one process are two calls with different account ids.

What keeps one unit off the other's account is the broker, enforced per credential: the observer's
`$SYS` permission names its own data account, so the connection cannot read another account's
connections whatever the daemon asks for. The daemon-side tenancy check
(`membership.ts:89`) is a diagnostic, and the comment above it says so: it buys a line naming both
accounts rather than the guarantee (`membership.ts:85`). The distinction matters more at N tenants per
process than it did at one, because a daemon-side check is the kind of control a reader could mistake
for the isolation boundary. It is not one. Membership stays fail-soft per space: a membership arm
that will not start degrades that space, not its neighbours.

### 4.3 Leases, and why N is bounded

`ep.acquireDeliveryLease(shard)` (`delivery.ts:246`) is per space, in that space's own KV, so
single-flight is unchanged: two processes serving the same space still cannot both write, and the
handover during migration is serialized by the lease rather than by operator care. What changes is
that one process holds N leases, so losing it is an N-space failover rather than a one-space one.
That is the argument for bounding N and assigning spaces to processes, rather than one process for
the whole broker. It is also why lease renewal and cred reload for one space must never queue
behind another space's work (prerequisite P3): a renewal starved by a noisy neighbour is a failover
that nothing was wrong with. How N is chosen is R2.

### 4.4 What sharding still refuses

`delivery.ts:162` refuses `shards != 1`, and multi-space mode does not lift it. That refusal is
about splitting **one** space across processes, which stays unsupported. Multi-space is the
orthogonal axis: many spaces per process, one process per space at a time. Which process serves
which space is the embedding's own assignment concern (§14), and the lease is what makes a wrong
answer a refusal rather than a corruption.

### 4.5 What stays process-wide

The broker-gone watchdog (`delivery.ts:392`, `:408`) exits the process when the broker has been
unreachable past its window. That stays process-wide and stays correct: the broker is shared, so its
absence is every tenant's fault at once, and one supervised restart is a better answer than N
independent tenants each deciding. This is the one exit that survives the re-read in §8.

## 5. The manager, and the re-signer that goes with it

### 5.1 The platform runs no manager

The seed-concentration argument does not settle this, and stating it that way would be wrong. The
auth service already holds its space's data-account signing seed, because the authority plane
self-mints its connections from it and the callout mints user JWTs into that account
(`service.ts:684`, `:697`). A multi-space auth service therefore holds N of those seeds in one
address space by construction, and this design accepts that. The residual is the one the embedding
page already names: the seed is decrypted in process, and what narrows it is an OS sandbox or a
remote signer behind the store seam, not a different process count (R5). A multi-space manager would
add no seed the platform does not already hold.

What settles it is ownership. The manager is the tenant's supervisor: it spawns the tenant's agents,
holds their runtime records, and answers for their lifecycle. Running it on platform compute would
move a tenant's process supervision onto the platform for no protocol reason, and hand the platform a
control plane over agents it does not own. The path built so a host holds no participant seed is
`remoteAuthority`, where the participant owns every private seed and the host returns scoped JWTs
only (`manager.ts:317`).

So the hosted shape runs no manager. It serves `manager-service-authority` from the multi-space face,
and tenants run their own supervisor against it.

| Deployment | Manager process | Signing material | Authority path |
|---|---|---|---|
| local `cotal up` | one, on the user's machine | local and static | loopback discovery file plus per-start capability |
| hosted, tenant's own machine | the tenant's `cotal supervise` | seeds the tenant generated | the space's public `manager-service-authority` |
| hosted sandbox | one per sandbox, inside the sandbox | generated in the sandbox | the same public route |

The route already exists on the public table (`service.ts:1230`) and the remote arm of the provider
already resolves it from the pinned registry entry rather than a local file (`provider.ts:178`). The
hosted sandbox is not a special case: it is a participant that happens to run on the platform's
compute, it gets nothing a laptop does not get, and the platform holds no participant seed for it.
That is why the multi-space face needs no sandbox-specific route.

One property the multi-space face owes: `manager-service-authority` is issued by the plane of the
space in the path and no other (`plane.issueManagerServiceAuthority`, wired at `service.ts:726`).
That is why §3.2 parses the prefix before the table lookup instead of letting a handler read it.

### 5.2 The daemon-cred re-signer, without a manager

Dropping the manager drops a function nothing else performs. The delivery daemon re-reads its cred
from the store at 75% of the JWT lifetime and fails loud rather than riding to expiry
(`delivery.ts:83`), so something has to re-sign a fresh cred into that store. Today that is
`Manager.renewDaemonCreds` on a half-TTL timer (`manager.ts:1239`, `:1240`, `:1274`), calling
`remintDaemonCreds` (`manager.ts:1285`, `renewal.ts:98`); the only other caller is an operator repair
command (`doctor.ts:99`). Remove the manager and every space's delivery and membership creds ride to
expiry together, on one clock, which is the multi-tenant form of the failure the 75% reload exists to
prevent.

The re-signer is the space's own authority plane, inside the multi-space auth process. Three
properties make that the place rather than a new component:

- It holds the signer already (`service.ts:684`), so this moves no key into a process that did not
  have it. Any separate re-signer service would have to be given N signers, which is the concentration
  §5.1 refuses to add to.
- It is already one-per-space-at-a-time, held by the plane claim, so the single-writer property that
  a re-signer needs comes from a fence that already exists.
- It already speaks that space's delivery-admin rail, for the plane-liveness oracle and the evictor
  (`service.ts:253`, `:287`), so the adoption request rides a rail the plane opens anyway.

| Property | Rule |
|---|---|
| owner | that space's authority plane, in the multi-space auth process |
| trigger | a per-space timer at half the standing renewable TTL, the cadence the manager used (`manager.ts:1240`) |
| operation | `remintDaemonCreds(base, space, store, { preflight })`, unchanged (`renewal.ts:98`): same identity, same profile, written to the same store key the delivery unit reads |
| what it may produce | the two daemon-cred kinds for the nkey identity already in the store. Never a new identity, never a different profile. A re-sign is a clock extension, not a grant |
| single writer | the plane claim. A plane that lost or released its claim re-signs nothing, so a reassigned space has one re-signer at a time for the same reason it has one plane |
| proof before overwrite | the `preflight` the function already gates every candidate on, over the process's own broker connection |
| adoption | request `reloadCreds` on the delivery-admin rail; a missing responder is recorded and the daemon's own 75% read is the backstop |
| failure | per file, loud, never fatal to the process or to another space |

Two consequences worth stating. A tenant running `cotal supervise` against the public authority path
has no local signer for the platform's daemon creds and never re-signs them; the platform's plane
owns them, which keeps the tenant's supervisor and the platform's daemons on separate renewal
authorities. And the operator repair command stays what it is, a repair, run against one space by a
human, not a hosted schedule.

## 6. Broker accounts through the full resolver

### 6.1 Why the earlier rejection does not bind here

Per-space lifecycle rejected a directory or URL resolver: a second location for trust material, and
for the URL form a resolver service to run and secure, with the evidence it collected removing the
case that would have forced it. That holds at the scale it was written for, a handful of spaces on
one operator's machine. It does not survive thousands. `serverConfig` renders `resolver: MEMORY` with
a preload map of every account (`provision.ts:2553`), so the preload map **is** the config file:
adding one tenant, or changing one tenant's limits, rewrites the trust of every tenant and reloads
the whole. U2 exists because that rewrite is not atomic. The premise that changed is the tenant
count, not the earlier reasoning.

The full NATS-based resolver is also not the form that was rejected. The brokers serve trust
themselves out of a local dir, so there is no resolver service to run, secure, or keep available,
which was the specific cost the earlier rejection named.

### 6.2 What the server actually does with a pushed claim

These rows were read in `nats-server` v2.14.6, which is the floor this design pins (§6.9). They are
not this tree.

| Subject | What the server does |
|---|---|
| `$SYS.REQ.ACCOUNT.<id>.CLAIMS.UPDATE` | decodes the account claim, validates it structurally, refuses when the claim's subject is not `<id>`, stores it, and replies "jwt updated" carrying its own server identity |
| `$SYS.REQ.CLAIMS.UPDATE` | the same, with the target account read from the payload instead of the subject |
| `$SYS.REQ.ACCOUNT.<id>.CLAIMS.LOOKUP` | replies with the stored JWT itself, and with no server identity |
| `$SYS.REQ.CLAIMS.LIST` | replies with account ids only, no claim bodies |
| `$SYS.REQ.CLAIMS.DELETE` | requires a self-signed generic JWT whose issuer is a trusted operator key, and refuses the system account; `allow_delete` is one of its conditions, not its gate |

Three properties of that behavior shape everything below.

1. **An update touches the store, not the trust chain.** The validation at update time is structural.
   The operator-chain check happens when the server fetches the account, and a claim that fails it is
   refused there. So a pushed claim signed by an untrusted issuer is written to the resolver dir and
   then refused at every subsequent lookup: a durable denial of that account, not a forged mint. The
   distinction decides §6.3's compromise analysis.
2. **An ack is not a write.** The store skips the write and returns success when the stored claim has
   the same `jti`, or an `iat` newer than the pushed one, and the handler replies "jwt updated"
   either way. A retry after a lease handoff, or any two mutators, can therefore be acked and
   discarded.
3. **The account id is a subject token on the per-account update, and the server checks the claim
   against it.** That makes the mutation subject-addressable, which is what lets a credential be
   scoped to it. The account-blind `$SYS.REQ.CLAIMS.UPDATE` carries its target in the payload, and a
   subject ACL cannot constrain a payload. This is the reasoning SPEC 13.13 already applies to
   dynamic consumer creation, reached again here.

Changing the resolver stanza itself still needs a reload signal, which happens once at the migration
cut (§9) and never per tenant.

| Mutation | MEMORY plus preload | Full resolver |
|---|---|---|
| add a space | rewrite the whole config, reload, re-read every tenant's trust | two pushes, one account pair touched (§6.4) |
| change one tenant's JetStream limits | the same whole-file rewrite | one push |
| remove a space | the same | two expiry pushes on the tenant path, and a later delete under the operator key (§6.8) |
| blast radius of one bad mutation | every tenant's trust | one account |
| blast radius of the mutation credential | a host filesystem write | every account on the broker except the system account (§6.3) |
| proof it applied | infer from the running config or from behavior | the predicate in §6.5 |

### 6.3 The resolver-admin credential

The first draft of this design said the push credential is material the config-rewriting path already
holds, so it widens no privilege. That was wrong and is retracted here. Under MEMORY plus preload the
mutation authority is a local file write and a reload signal, which is a host authority reachable by
whoever can write that file. The full resolver replaces it with a standing credential reachable by
any client that can connect to the broker. That is a widening, and it is one the tree's own `$SYS`
posture was shaped to avoid: a system-account user with no permissions block is broker admin
(`provision.ts:2338`), the two profiles that exist are an account-scoped CONNZ observer and a
KICK-only evictor (`provision.ts:2348`, `:2398`), neither reaches `$SYS.REQ.CLAIMS.*`, and the
observer is asserted to be refused `CLAIMS.LIST` (`membership-feed-confinement.smoke.ts:138`). No
profile for this exists, so it has to be written (prerequisite P7).

**Profile.** An explicit allowlist, because the default is broker admin.

| Grant | Value | Why |
|---|---|---|
| pub allow | `$SYS.REQ.ACCOUNT.*.CLAIMS.UPDATE` | the subject-addressed push, where the server checks the claim against the subject token |
| pub allow | `$SYS.REQ.ACCOUNT.*.CLAIMS.LOOKUP` | the content read-back §6.5 turns on |
| pub allow | `$SYS.REQ.CLAIMS.LIST` | drift detection over the id set; it returns ids the mutator already holds |
| pub deny | `$SYS.REQ.ACCOUNT.<system account id>.CLAIMS.UPDATE` | deny beats allow, so this credential provably cannot strand the account the broker itself runs on |
| not granted | `$SYS.REQ.CLAIMS.UPDATE` | payload-addressed, so no subject ACL can scope it (§6.2, property 3) |
| not granted | `$SYS.REQ.CLAIMS.DELETE` | it could not use it (§6.8), and a credential should not carry a subject it cannot exercise |
| not granted | `$SYS.REQ.SERVER.*`, `$SYS.ACCOUNT.>` | no KICK, no reload, no cross-tenant event feed |
| sub allow | its own scoped reply-inbox prefix | the proof reads replies and serves nothing |

**Holder.** The U2 writer-lease holder, one process, and neither daemon. The auth service holds no
`$SYS` today and multi-space mode does not change that; the delivery daemon's `$SYS` creds stay the
observer and evictor it already has.

**It signs nothing.** The account JWTs it pushes are minted by the provisioning path under the
operator signing key, which stays where it is. Push authority and signing authority are separate
holders, so a compromised pusher cannot produce a claim the broker will trust. That separation is
what makes property 1 of §6.2 a bound rather than a hole.

**Lifecycle.**

| Question | Answer |
|---|---|
| issuer | the broker's system-account signing key |
| when minted | at hosted broker provisioning, and re-minted for each writer-lease term |
| where the signer lives | the platform's key store. Today the system signing seed is discarded once a space is provisioned, which is why a `$SYS` cred cannot be re-minted later (`provision.ts:2370`, `:2413`). That is right for a workstation and impossible for a control plane that must re-mint, so P7 retains it for the hosted broker and leaves `cotal up` as it is |
| lifetime | bounded, non-reconnecting, re-minted per lease term rather than standing indefinitely |
| revocation | system-account rotation, the same path the observer and evictor already have |
| compromise | the holder can push a structurally valid claim for any tenant account, and by §6.2 property 1 the effect is a durable denial: that account fails validation at every lookup and across restarts. It cannot mint anything the broker trusts, and it cannot touch the system account |
| recovery | another push, unless the hostile claim carried a future-dated `iat`, which the store's skip rule makes unpushable-over. That case is recoverable only by the operator-key delete, which is the second reason §6.8 keeps that ceremony rehearsed |
| detection | the periodic reconciliation in §6.6, which is what makes a strand visible within one interval instead of at a tenant's next connect |

### 6.4 A space is an account pair, and so is its saga

Every space has two accounts and both must be trusted before either is useful: the data account, and
that space's dedicated callout account whose `authorization.allowed_accounts` names the data account
(`callout.ts:95`, `:97`). The inventory unit is the pair. A saga written over a single claim cannot
describe its own topology.

| | Add | Remove |
|---|---|---|
| order | data account, then callout account | callout account, then data account, and only after the daemons dropped the space (§3.4, §4) |
| why that order | the callout account's claim names the data account. A trusted callout over an unknown data account authenticates a connect and then fails to bind it, which reads as a broker fault rather than as an unprovisioned space | the callout account is where connects authenticate, so retiring it first refuses at authenticate. Retiring the data account first leaves a callout that authenticates and cannot bind, which is the same wrong error later in the path |
| torn state | `pair-partial`, recording which half is proven | `pair-partial`, same |
| what a torn state serves | nothing. No daemon adds a space until both halves are proven (§3.4), so a partial pair is inert rather than half-serving | nothing. The daemons already dropped the space |
| resume | re-push the unproven half and leave the proven half alone. Forward-only, never a rollback of the first half | re-drive the remaining half |
| digest | the pair digests as a pair, so a torn pair is distinguishable from a complete one and from an absent space (§6.6) | the same |

Resume is idempotent by construction: a re-push of byte-identical content read-backs as proven, and
at the server it lands on the same-`jti` skip, so re-pushing a half that actually landed is a no-op
rather than a second mutation. This is the one place where §6.2's ack-is-not-a-write property helps
rather than hurts, and it only helps because the proof is a content read-back rather than the ack.

### 6.5 What counts as proof

A **PROVEN PUSH** is all three of the following. Any one of them missing is an **UNPROVEN PUSH**,
which is not a commit.

1. **Accepted.** At least one update reply for the target account carrying a success status. Necessary
   and not sufficient: the ack is returned for writes the store discarded (§6.2, property 2).
2. **Content read-back.** A `$SYS.REQ.ACCOUNT.<id>.CLAIMS.LOOKUP`, collected for the whole request
   window rather than stopping at the first reply, where at least one reply arrived and every reply
   body is byte-identical to the pushed JWT. An empty reply is absence and fails the predicate; a
   differing body is a server that has not converged and also fails it. `CLAIMS.LIST` cannot perform
   this step: it answers with ids, so a digest over the account set is blind to every content-only
   mutation, which is what a limits change and a re-key are.
3. **Roster coverage.** Every server on the mutator's declared inventory answered the update request
   inside the window. Server identity comes from the update reply's own server envelope. The roster
   does not.

The roster is declared configuration rather than inferred from who replied, and SPEC 13.13 gives the
reason in the neighbouring problem: a partition shows one responder, so a reply count can neither
prove completeness nor be flipped into requiring a named server's reply without wedging on a restart
(`SPEC.md:3554`, `:3568`). A server on the declared roster that did not answer leaves the push
unproven, and the saga fails closed rather than committing.

Three ordering rules make the predicate decidable:

- Every push carries a fresh `jti`. Without one, a content change to a claim that reuses its id is
  discarded at the same-`jti` skip and acked as applied.
- Every push carries an `iat` strictly greater than the stored claim's. The mutator reads the current
  claim first and, when the wall clock has not passed it, waits: `iat` is second-granularity, so two
  pushes inside one second are not ordered.
- An unproven push is re-driven with a fresh `jti` and `iat`, never retried byte-identically after a
  handoff, because a byte-identical retry cannot distinguish "landed" from "skipped" on its own. The
  content read-back is what resolves that, and it resolves it in both directions.

What this proves: the claim is stored, with the content pushed, on every server the mutator knows
about. What it does not prove: anything about a server the inventory does not name. A broker whose
membership can change without the inventory changing is outside this design (§14, P9).

### 6.6 Reconciling with the U2 CAS inventory

U2 guards a config-file rewrite with a writer lease and a CAS inventory. The full resolver keeps all
of that, changes the artifact, and changes two of the failure modes.

| U2 element | Under the full resolver |
|---|---|
| writer lease | unchanged: one mutator at a time, still TTL-leased |
| generation and the CAS points | unchanged in shape: intent, proof and commit are still bracketed |
| `configDigest` | becomes a digest over claim **content**: per account `(accountId, jti, sha256(jwt))`, and per space the pair of them (§6.4). Not the account set, which `CLAIMS.LIST` could serve and which no content-only mutation moves |
| abort-before-rename fence | becomes abort-before-push, at the same point and for the same reason |
| UNPROVEN RELOAD | becomes UNPROVEN PUSH, defined by §6.5. The ack is not the proof |
| forward-only once proven | holds harder, since undoing a pushed claim is another push and so is forward motion by construction |
| SILENT EVICTION and RESURRECTION | narrowed: no whole-file rewrite exists, so an unrelated tenant's mutation can no longer drop or restore this account |
| TORN READ | unchanged |
| TORN WRITE | changed, not unchanged. The new artifact has an ack that is not a commit and a stale-`iat` push that is discarded silently, neither of which the config file had. §6.5's `jti` and `iat` rules plus the content read-back are what keep it detectable, and they are load-bearing rather than hygiene |
| FAIL-CLOSED ON UNCERTAINTY | unchanged, and it is what an unproven push resolves to |

Two things the per-account artifact adds. U2's hardest cases came from one artifact carrying every
tenant, and per-account pushes remove the shared artifact, so the class where one tenant's mutation
resurrects or evicts another's credentials goes away. And a periodic reconciliation becomes possible
and becomes required: `CLAIMS.LIST` for ids the inventory does not know, and a content lookup for
every account in the inventory. That is what turns an out-of-band push, hostile or accidental, into a
fault detected within one interval rather than at a tenant's next connect (§6.3).

### 6.7 Limits ride in the account JWT

Data accounts are minted with `mem_storage: -1, disk_storage: -1` and no stream or consumer ceiling
(`provision.ts:341`, `:345`, applied at `:461`). One tenant can consume the broker's storage. At
thousands of tenants that is not a policy gap to defer; it is the reason the account JWT is the right
carrier. The limits ride in the claim, the broker enforces them per account with no daemon in the
path, and a plan change is one push (§6.2) that touches one tenant and reloads nothing. The hosted
embedding picks the numbers. This design adds no limits field to core: it uses the account-limits
shape that is already minted today.

### 6.8 Removal, and who holds the delete

Deleting an account JWT from a full resolver requires a self-signed generic JWT whose issuer is a
trusted operator key. `allow_delete` has to be on, but it is a condition rather than the gate: the
gate is the operator key, which dominates every account on the broker and is strictly more authority
than the per-space signers §5.1 discusses. That authority does not belong in a tenant-facing control
plane, and the resolver-admin credential does not carry it (§6.3).

So removal on the tenant path is not a delete.

| Step | What it is | Who can do it |
|---|---|---|
| 1 | The daemons drop the space (§3.4, §4) | the multi-space processes |
| 2 | Push the callout account's claim with an expiry in the past | the resolver-admin credential |
| 3 | Push the data account's claim the same way | the resolver-admin credential |
| 4 | Delete both from the resolver dir, after the retention window | an operator-key ceremony, offline, not on the tenant path |

An expired claim fails the fetch-time validation, and an already-loaded account fails its next
lookup, so step 2 stops new connects into the callout account and step 3 does the same for the data
account. Both are ordinary pushes, so both carry the §6.5 proof and stay on the same forward-only
path as every other mutation, and both are reversible by a further push while the material still
exists. Step 4 is garbage collection under human authority, and it is also the only recovery from the
future-dated `iat` strand in §6.3, which is the argument for rehearsing it rather than describing it.

Two limits stated rather than implied. Expiry stops new connects; it does not kill live ones, and
killing live connections is the eviction path that already exists (`provision.ts:2398`) and is not
part of this design (R7). And the order in the table is the inverse of the add order for the reason
§6.4 gives, not by symmetry.

### 6.9 The version floor

This design turns on five behaviors of an external component: the per-account update's subject-to-claim
check, the ack-without-write skip, `CLAIMS.LIST` returning ids, `CLAIMS.LOOKUP` returning content with
no server identity, and the operator-gated delete. Not all of them are documented, and §6.3 and §6.5
are built on top of them. They were read in `nats-server` v2.14.6. The hosted broker pins a minimum
version, and a smoke asserts all five so a server upgrade cannot move them without going red
(prerequisite P8).

## 7. The seam an embedding calls

| Today | Multi-space |
|---|---|
| `runAuthService(args, store?)` | `startAuthServiceMulti(opts)` returning a handle with `add(space)`, `remove(space)`, `spaces()`, `closed` |
| `runDelivery(args, store?)` | `startDeliveryMulti(opts)` returning the same shape |
| `Manager`, `ManagerOptions` | unchanged, and not run by the platform (§5.1) |
| `remintDaemonCreds(root, space, store, opts)` | unchanged, and called per space by the auth handle's own timer rather than by a manager (§5.2) |
| `serverConfig(broker, spaces, opts)` | unchanged for the local shape; the hosted shape renders the resolver stanza and pushes (§6) |
| `createBrokerAuth`, `createSpaceAccountAuth`, `SecretStore` | unchanged |
| no resolver-admin profile exists | a new `$SYS` profile minted alongside the observer and evictor (§6.3, P7) |

The multi-space entry points take an options object rather than `ParsedArgs`. `ParsedArgs` is the
CLI's shape, and a library caller should not have to build a flag bag to start a daemon. The
single-space `run*` functions stay, as thin wrappers that start a handle and `add` one space, so
`cotal up` and the hosted path share one code path instead of drifting apart.

Store keys need nothing new. They are already space-scoped: `auth/<segment>/callout.json`,
`issuer.json`, `owner-secret.json`, `service-keys.json` (`store.ts:58`), and
`deliveryCredsKey(space, composition)` / `membershipRwCredsKey(space, composition)` over
`segmentedKey` (`space-segmentation.ts:342`, `:362`, `:367`). One process reads N of them from one
injected store, and a hosted adapter resolves them under its own tenant scope as opaque ids. The
documented rule that the signer and the daemon creds come from one store (`manager.ts:1103`,
`renewal.ts:98`) is unchanged; §5.2 keeps it by keeping the re-signer on the same injected store the
delivery unit reads. At N tenants that means one store with tenant-scoped resolution, not N stores.

**What stays single-space.** Local `cotal up` and everything under it: one broker, one space, one of
each daemon, the ambient root for state, the MEMORY resolver with its preload map, unprefixed
loopback paths, the manager as the renewal owner, the system signing seed discarded after
provisioning, and the broker-wide verbs that `assertSingleSpaceBroker` (`auth-paths.ts:694`) already
refuses on a multi-tenant root. A user who never hosts sees no behavior change from this design, and
the local path does not acquire a prefix, a resolver dir, a `$SYS` push credential, or an assignment
plane.

## 8. Failure and isolation

Every process-fatal exit in these daemons was written when a process meant a space. Each has to be
re-read as a question about blast radius, and they do not all answer the same way.

| Failure | Today | Naive multi-space | Containment |
|---|---|---|---|
| sealed scanner mid-life disconnect (plane FENCED) | whole process exits (`service.ts:808`) | every tenant on the process goes down | per-space teardown, §8.1 |
| callout connection closed with an error | whole process exits (`service.ts:801`) | every tenant goes down | that space goes down and is re-added or reassigned |
| callout connection closed cleanly | whole process exits 0 (`service.ts:803`) | every tenant goes down | undecided, R4 |
| broker unreachable past the window | delivery exits (`delivery.ts:408`) | correct as written | stays process-wide: the broker is shared (§4.5) |
| plane claim lost to a successor | the open refuses | one space refuses | already per space |
| public face flooded | 64 in flight, process-global (`service.ts:124`) | one tenant starves the rest | per-space budget under a process cap, R1 |
| one tenant's JetStream growth | limits are unlimited | one tenant fills the broker | limits in the account JWT (§6.7) |
| store read fails for one space | start fails | that `add` fails | add is per space and fails alone |
| daemon cred renewal fails for one space | the manager records it, that space rides to expiry | unchanged per space | the re-signer is per space and per file (§5.2) |
| membership arm will not start | that space degrades, fail-soft | unchanged | already per space |
| resolver-admin credential compromised | no such credential exists | every tenant account can be stranded | scoped profile, separate holder, system account denied, reconciliation (§6.3, §6.6) |

### 8.1 A fenced plane must stop answering, not necessarily exit

SPEC 13.13's requirement is that a fenced plane answers nothing more. `process.exit(1)` is how the
daemon satisfies it today, and that is available because the process serves one space. The exit is
the implementation; "answers nothing more" is the invariant. In multi-space mode the invariant is
served by a per-space teardown, which has to be at least as total as the exit was:

1. Mark the space down first, before any I/O. The prefix stops routing and the callout stops
   answering. A fenced plane must not answer one more connect while its connections are closing.
2. Then close the callout subscription and connection, then everything the plane's own `close()`
   closes, in the order it closes them (`service.ts:521`), then the bundle and the prefix
   registration. The teardown is stated as that function's own closure rather than as a list of
   connections, because a list drifts: it is six standing connections plus a conditional admin
   listener today, and step 3 fails if the count is ever short by one.
3. Then verify the close. A successor's reclaim adjudicates on liveness alone over a complete
   connection sweep, so a connection this process stopped using but did not close is still live to
   that sweep and blocks the reclaim it was supposed to enable. The fence path confirms the
   connections are gone rather than assuming it, over the account-scoped connection sweep the plane
   already reaches through the delivery-admin liveness oracle (`service.ts:253`); prerequisite P5 is
   turning that from a successor's adjudication into a self-check the fencing process can run.
4. If any of that does not complete, escalate to the process exit. Fail-closed on uncertainty: a
   space that cannot be proven torn down means the process cannot say what it is still answering,
   and the old whole-process exit is the correct fallback. It is a worse outcome for the neighbours
   and a correct one. This design's job is to make it rare, not to remove it.

The identities a reclaim adjudicates on are per space, since each space's plane self-mints its own.
A multi-space process is therefore no obstacle to reclaim as long as step 3 holds, and step 3 holds
only on one broker process, which is the boundary §1 states and P9 lifts.

### 8.2 What one process cannot promise

Fault containment across tenants sharing an address space is bounded by what a process can promise.
An out-of-memory kill, an unhandled rejection that reaches the top, or a stalled event loop is
process-wide, and no arrangement of per-space objects changes that. What this design contains is the
expected faults in the table above, and the honest statement of the rest is: N is the blast radius of
a process crash, which is why N is bounded and assignment is a platform concern (§4.3, R2).
Per-space budgets keep one tenant's traffic off the shared event loop; per-space async paths keep one
tenant's slow store read out of another's lease renewal. Neither promises more than that.

## 9. Migration from the process-per-space shape

Zero re-keying is a requirement, and it is already satisfied by work that landed for other reasons:
every per-space name goes through one encoder (`auth-paths.ts:95`, `store.ts:58`,
`space-segmentation.ts:342`), and the runtime records are per space (`local-process.ts:56`, `:72`).
The migration changes process topology and the resolver. It renames nothing, re-mints nothing, and
invalidates no credential a tenant holds.

| Step | Action | Tenant impact | Reversible |
|---|---|---|---|
| 1 | Mint the resolver-admin credential (§6.3) and write the full-resolver stanza while keeping the preload map, one reload | none: preloaded accounts stay trusted, and the reload writes each preloaded claim into the resolver dir | yes, revert the stanza |
| 2 | For every account in the inventory, push a re-signed claim carrying a fresh `jti` and a newer `iat`, and prove it by content read-back (§6.5) | none: the same grants, a new claim id | yes, the pushed claims can be superseded |
| 3 | Drop the preload block, second and last reload | none for accounts proven in step 2 | yes, restore the block |
| 4 | Move the U2 inventory to the content digest at a generation boundary (§6.6) | none | forward-only from here |
| 5 | Start the multi-space processes; per space, stop the single-space daemons then `add` it | a short window where new connects are denied | yes, stop the add and restart the single-space pair |
| 6 | Repeat per cohort | as step 5 | as step 5 |

**Why step 2 is a re-signed claim and not the same bytes.** Under a writeable resolver the preload map
is not a parallel trust source: the reload in step 1 writes every preloaded claim into the resolver
dir. A read-back that only asks whether the account is present therefore passes before any push is
sent, and would prove nothing about the push path while step 3 is the step that removes the other
trust source. Pushing a claim with a **new** `jti` makes the read-back discriminating: a content
read-back that matches the new bytes could only have come from the push, because the preloaded copy
carries the old id. Step 3 is gated on that proof holding for every account in the inventory, plus a
`CLAIMS.LIST` that returns no id the inventory does not know.

Step 5 is stop-then-add, not add-then-stop, and the order is enforced rather than remembered: the
plane claim and the delivery lease both refuse a second holder, so an overlap is a refusal to start,
never two writers. The cost of that ordering is a brief window per space where new connects are
denied while existing connections keep working on already-minted JWTs, which is the same window a
restart of the single-space daemon costs today.

The two shapes coexist for as long as the migration takes. A single-space process and a multi-space
process holding different spaces on the same broker do not interact, because everything either one
holds is scoped to an account.

**Pinned bases survive the cut.** A space migrated in step 5 moves from an unprefixed public face to
a prefixed one (§3.2), and its tenants have pinned the old base in their registry entries. The public
listener is already loopback-bound behind the operator's reverse proxy (`service.ts:745`, `:766`), so the
proxy adds the prefix for pre-cut spaces and no tenant re-registers. That makes the proxy rewrite part
of the recorded base for the length of the migration, which is what §3.2's invariant means for a
pre-cut space: the recorded base and the served path differ, and the rewrite is what reconciles them.
Spaces created after the cut receive the prefixed base in their bundle from the start and never need
the alias, and the alias is removed per space only after its tenants have re-pinned (R3).

## 10. What does not change on the wire

Stated plainly, because several parts of this design look like protocol changes and none of them is.

- `$SYS.REQ.USER.AUTH` is unchanged: same subject, same sealed request and response shapes, same
  mandatory xkey, one subscription per account. A callout served by a multi-space process is
  indistinguishable, on the wire, from one served by a dedicated process.
- No new message kind, subject, or endpoint method. `/s/<space>` is an HTTP path on the auth
  service's public face. SPEC does not name that face's paths and no NATS subject carries them.
- Clients pin an opaque base URL and derive their routes from it (`provider.ts:389`), so no client
  learns that a prefix exists, and no client library changes.
- Account JWTs carry the same claims signed by the same operator. Only how the broker obtains them
  changes, from preloaded config to resolver push, which is server configuration.
- `$SYS.REQ.CLAIMS.*` and `$SYS.REQ.ACCOUNT.<id>.CLAIMS.*` are nats-server's own subjects, used by an
  operator tool holding a scoped system-account credential. They are not Cotal subjects and add
  nothing to SPEC.
- The daemon creds the re-signer produces are the same two kinds, for the same identities, under the
  same store keys (§5.2). Only the process holding the timer changes, and no credential a tenant
  holds is affected.
- SPEC §9's trust model is unchanged: one operator, one system account, one data account per space,
  plus that space's dedicated auth account. Multi-space mode changes which process holds the
  connections, not who signs what.
- Per-space material keeps its names (§9), so a credential minted before the migration is valid
  after it.

## 11. Rejected alternatives

1. **More machines, still one process per space.** The cost is per tenant rather than per unit of
   load, so idle tenants dominate the bill at thousands. The binding constraint is connection and
   listener count, not CPU, and adding machines does not improve it.
2. **One shared auth account and one shared data account, with tenancy enforced in the daemon.**
   The broker stops being the enforcement point. Subject scoping, JetStream limits and the
   `allowed_accounts` re-binding all become application logic, and one daemon bug becomes a
   cross-tenant breach. The account boundary is the product, which is also why §4.2 names the broker
   rather than the daemon's own check as the control.
3. **Keep MEMORY plus preload and rewrite the config faster** (batched adds, debounced reloads).
   Batching improves throughput while making the blast radius worse, since more tenants ride each
   rewrite, and it keeps every failure mode that exists because one artifact carries everyone.
4. **A URL resolver backed by a service the platform runs.** Rejected for the reason the per-space
   lifecycle design gave, which still holds: one more component to run, secure and keep available,
   whose outage is a broker-wide authentication outage. §6.1 takes the full resolver because it does
   not add that component.
5. **Per-space worker threads or child processes under one supervisor.** It buys real memory
   isolation and gives back what multi-space mode is for: per-tenant memory returns (each thread
   pays its own runtime), and the connection count, which is the binding constraint, does not drop
   at all.
6. **A multi-space manager process.** Not rejected for seed concentration, which the multi-space auth
   service already carries (§5.1). Rejected because supervising a tenant's agents is the tenant's
   function, and `remoteAuthority` plus the public `manager-service-authority` route already let the
   tenant hold it.
7. **A separate re-signer service for the daemon creds.** It would have to be handed N tenants'
   signing seeds, which is the concentration §5.1 declines to add to, to perform work the process
   holding those seeds can already do under a fence it already holds (§5.2).
8. **Pushing through the account-blind `$SYS.REQ.CLAIMS.UPDATE`.** Its target account is in the
   payload, so no subject ACL can scope it and the credential in §6.3 could not be bounded or denied
   the system account. The per-account subject carries the target as a token the server checks.
9. **Proving a push with `$SYS.REQ.CLAIMS.LIST`.** It answers with account ids, so it proves set
   membership and is blind to every content-only mutation, which includes the limits change §6.7
   makes routine. It stays in the design as drift detection over the id set, not as proof.
10. **Proving cluster convergence by counting update replies.** SPEC 13.13 rejects the same inference
    for connection sweeps and the reason carries: a partition shows one responder. §6.5 uses a
    declared roster, and §1 does not claim the clustered case at all.
11. **Deleting the account JWT on the tenant-facing removal path.** Delete requires the operator key
    online (§6.8), which is more authority than any per-tenant operation should need. The tenant path
    expires the claim; the delete is an offline ceremony.

## 12. Prerequisites

| # | Prerequisite | Why |
|---|---|---|
| P1 | The per-space lifecycle verbs | hot add and remove is the daemon half of a lifecycle whose provisioning half lives there |
| P2 | An injected state base for both daemons, replacing the ambient root walk (`service.ts:649`, `delivery.ts:204`) | a process serving N tenants' ledgers and N tenants' `$SYS` scans must not resolve either from a cwd walk |
| P3 | Per-space async isolation in both daemons | a lease renewal or cred reload starved by a neighbour is a failover with nothing wrong |
| P4 | The U2 saga | §6.6 modifies it rather than replacing it; without it there is no inventory to reconcile |
| P5 | A verified-close primitive for the fence path, over the account-scoped sweep the plane already reaches (`service.ts:253`) | §8.1 step 3 turns on proving connections are gone, not assuming it. Its per-account observation cost at N tenants is R6 |
| P6 | Measured broker capacity | thousands of accounts on a full resolver, N callout connections per process, and the resolver sync interval all need numbers before N is chosen. This design asserts none (R2) |
| P7 | The resolver-admin profile in the provisioning path, and a retained system-account signing key for the hosted broker | §6.3 needs a credential that does not exist, and a signer that today is discarded once provisioning finishes (`provision.ts:2370`). `cotal up` keeps discarding it |
| P8 | A pinned `nats-server` floor and a smoke over the five behaviors in §6.9 | §6.3 and §6.5 are built on an external component's undocumented behavior; an upgrade must go red rather than move it silently |
| P9 | An authoritative server incarnation/roster authority, before any clustered broker | SPEC 13.13 makes a plane-reclaim `gone` verdict valid only under one nats-server process and names this as what replaces the proof (`SPEC.md:3568`). Without it, §8.1 step 3 does not hold on a cluster |

## 13. Named residuals

These are named for the build phase rather than settled here. None of them contradicts the design;
each is a decision it defers.

- **R1 per-space admission budget.** §3.1 and §8 both put the 64-in-flight budget (`service.ts:124`,
  `:1261`) per space under a process cap, with no mechanism. A process cap alone still lets one tenant
  hold every slot under it, so the build picks between a per-space reservation, a fair share, and a
  weighted allocation, and says which.
- **R2 the assignment ceiling.** §4.3 and §8.2 both say N is bounded, and nothing says how N is
  chosen. Derive it from a measured per-space footprint (six plane connections plus the conditional
  admin listener, the callout connection, the delivery unit, the membership arm) and from measured
  resolver behavior at thousands of accounts, rather than leaving it to the embedding.
- **R3 the pre-cut base alias.** §9 keeps two public base shapes alive for the length of the
  migration, reconciled by the proxy rewrite. It needs a live exercise: pinned old bases, prefixed new
  bases, a rollback before the cut and after it, and the per-space removal of the alias once its
  tenants have re-pinned.
- **R4 the clean-close exit-0 arm.** The callout connection has two exits, error and clean
  (`service.ts:801` and `:803`). §8 re-reads the error arm as a blast-radius question and leaves the
  clean one inheriting "clean close stops this space". The build decides whether a clean callout close
  is ever intentional for a tenant.
- **R5 in-process signer isolation.** §5.1 accepts N data-account signing seeds in one address space
  and §5.2 keeps the re-signer there rather than widening it. What would narrow it is an OS sandbox or
  a remote signer behind the store seam, which the embedding page already names and which would cover
  the plane and the re-signer in one move.
- **R6 per-space `$SYS` observation at N tenants.** P5's verified close reads an account-scoped
  connection sweep, which needs a `$SYS` observer per account. The embedding page already classes that
  as a partial gap, so P5 inherits it.
- **R7 live connections and expiry removal.** §6.8 stops new connects and does not kill live ones.
  Whether a tenant removal should also evict live connections, over the KICK path that already exists
  (`provision.ts:2398`), is a policy decision this design does not take.

## 14. Out of scope

- The assignment plane: which process serves which space, and how spaces rebalance across processes.
- Multi-broker and cluster topology, leaf nodes, and where a given space's data lives. §1 and P9 state
  the boundary rather than deferring it silently.
- Tenant provisioning, plans, billing, and the limit values themselves. §6.7 says where limits ride,
  not what they should be.
- Agents present in many spaces at once, which is the other half of the roadmap row.
- Splitting one space across delivery processes, which §4.4 keeps refused.
- Broker-wide operator rotation, including the delete ceremony's key custody (§6.8).
- Any change to SPEC.
