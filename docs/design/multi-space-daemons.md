# Multi-space daemons: one process, N spaces

> **Design** (non-normative, not shipped) · Builds on [per-space lifecycle](per-space-lifecycle.md),
> [space segmentation](space-segmentation-p7-p1.md) and [U2](u2-resolver-cas.md); it does not restate
> them. Answers the hosted half of [embedding](../embedding.md) gap 3 and the
> [roadmap](../roadmap.md) "Multi-space brokers" row. **Wire contract unchanged** (§10).

## 1. The question this settles

A hosted embedding runs thousands of spaces on one broker cluster. The trust layer already holds
them. The daemons do not: every server-side daemon takes `--space` and serves one, so the hosted
shape today is three processes per tenant, whether that tenant has a hundred agents or none.

| Daemon | Per space today | At 2,000 spaces |
|---|---|---|
| auth-service | 1 process, 1 callout connection, 5 authority-plane connections, 1 or 2 HTTP listeners | 2,000 processes, ~12,000 connections, up to 4,000 listeners |
| delivery | 1 process, its Plane-3 and membership connections, 1 delivery lease | 2,000 processes, 2,000 leases |
| manager | 1 process holding a data-account signing seed | 2,000 signing seeds resident on platform machines |

The cost is per tenant, not per unit of load, and an idle tenant costs the same as a busy one. This
document specifies the multi-space mode of each daemon, the broker-account mechanism that survives
the tenant count, and the migration into it.

## 2. What exists today

Everything below was read in this tree at the cited line.

| Fact | Where |
|---|---|
| `runAuthService` refuses to start without `--space` | `implementations/auth/src/service.ts:611`, `:614` |
| Each space owns a dedicated auth-callout account, minted with `authorization { auth_users, allowed_accounts, xkey }` | `implementations/auth/src/callout.ts:80`, `:96` |
| The callout is one subject, served on a connection authenticated into that account | `implementations/auth/src/callout.ts:38`, `service.ts:691` |
| `startAuthCallout` already takes the account material, space, issuer and authorizer per call | `implementations/auth/src/service.ts:694` |
| The authority plane is 5 self-minted connections gated by one plane claim; a mid-life scanner death FENCES it | `implementations/auth/src/service.ts:164`, `:148` |
| A fenced plane exits the whole process | `implementations/auth/src/service.ts:805` |
| Both HTTP faces resolve routes by exact-match lookup on the whole URL | `implementations/auth/src/service.ts:954`, `:1274` |
| The public face is loopback-bound behind the operator's reverse proxy | `implementations/auth/src/service.ts:744` |
| Public admission budget is process-global | `implementations/auth/src/service.ts:124`, `:1261` |
| The discovery bundle is composed per space and its base URL is finalized after bind | `implementations/auth/src/service.ts:1165`, `:1199` |
| Clients derive `/exchange` and `manager-service-authority` from an opaque pinned base | `implementations/auth/src/service.ts:1202`, `provider.ts:389` |
| The non-seam state dir comes from an ambient root walk | `implementations/auth/src/service.ts:649` |
| Auth store keys are already space-scoped through the guarded encoder | `implementations/auth/src/store.ts:58`, `auth-paths.ts:95`, `:125` |
| `runDelivery` is single-space, pins its account from its own creds, and refuses sharding | `implementations/delivery/src/delivery.ts:156`, `:205`, `:162` |
| Membership authority already takes the account id as a parameter | `implementations/delivery/src/delivery.ts:310`, `membership.ts:30` |
| The delivery lease is per space; the broker-gone watchdog exits the process | `delivery.ts:246`, `:392`, `:408` |
| The manager self-mints from the data-account signing seed in static mode | `implementations/manager/src/manager.ts:270`, `:306` |
| `remoteAuthority` exists so the host holds no participant seed | `implementations/manager/src/manager.ts:317` |
| `serverConfig` renders `resolver: MEMORY` with a preload map of every account | `packages/core/src/provision.ts:2493`, `:2553` |
| Data accounts are minted with unlimited JetStream storage | `packages/core/src/provision.ts:341`, `:461` |
| Runtime records are already per space | `packages/workspace/src/local-process.ts:56`, `:72` |

Three of these decide the design. The callout is served *inside* each space's own account, so
routing by account is structural rather than something to add. Every per-space name already routes
through one encoder, so multiplexing renames nothing. And every process-fatal exit was written when
a process meant a space, so each one has to be re-read as a question about blast radius.

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
| authority plane (5 connections, plane claim) | one | one per space |
| loopback face | one listener | one listener, space in the path |
| public face and discovery bundle | one listener, one bundle | one listener, one bundle per space |
| ledger and IdP pin dir | `userAuthStateDir(root, space)` | the same call, N dirs |
| store material | `auth/<segment>/*.json` | the same keys, N spaces |
| public admission budget | process-global | per space, under a process cap |
| broker address, TLS, listener ports | process-wide | unchanged, process-wide |

### 3.2 The public face and the space in the path

Both faces look a route up by exact match on the whole URL (`service.ts:954`, `:1274`). Multi-space
mode splits the path once at the front, `/s/<space>/<route>`, and then performs the same closed-table
lookup with the same handlers. The table stays closed, so an unknown path is still a 404, and the
space segment is validated by the same guarded encoder that names its dirs and store keys, so an
empty, `.` or `..` space is refused before any handler or path exists.

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
decided at start, and the only invariant is that the base recorded for a space matches what the face
serves for it.

### 3.3 Per-space state needs no new mechanism

P7/P1 already did this work. `userAuthStateDir(root, space)` (`auth-paths.ts:125`) and the store keys
`auth/<spaceSegment>/…` (`store.ts:58`) both route through the one guarded encoder
(`auth-paths.ts:95`). A multi-space process holds N of each, no layout changes, and no key is
renamed. That is what makes §9 a topology migration rather than a re-keying.

What does change is the root. `findCotalRoot()` is a cwd walk (`service.ts:649`), which is right for
a workstation and wrong for a process serving N tenants' ledgers. The state base becomes an injected
option (prerequisite P2). This is the same ambient-dir gap the embedding page already records; the
multi-space mode makes it structural rather than a footnote.

### 3.4 Hot add and remove

`add(space)` requires the material in the store and both of the space's accounts already trusted by
the broker (§6): the callout connection cannot authenticate into an account the broker does not
know. Then, in order: open the authority plane (which takes the plane claim), open the callout
connection, flush so the subscription is on the broker, compose the bundle, register the path
prefix. The prefix is registered last because it is the readiness signal, for the same reason the
discovery file is written last today ("All planes bound - NOW write the discovery file",
`service.ts:773`). An add that fails at any step registers no prefix, so a half-bound space is
unreachable rather than half-serving.

`remove(space)` is the reverse: unregister the prefix, drain what is in flight, close the callout
connection, close the plane so the claim is released, drop the bundle. The account JWT is deleted at
the broker afterwards, never before (§6.5).

Neither restarts the process. Neither touches another space's connections, dirs, keys or budget.

## 4. The delivery daemon in multi-space mode

### 4.1 One unit per space, N units per process

Everything `runDelivery` holds is derived from one space's creds: the cred source and its
75%-of-lifetime reload, the endpoint, the Plane-3 fan-out writer, the timer writer, the delivery
lease. The account it may touch is pinned from the creds themselves and admission-checked
(`delivery.ts:205`). A multi-space daemon is N of those units in one process, each with its own cred
source and its own reload timer. Nothing in the unit is a singleton by nature; it is a singleton
today because the process is.

### 4.2 Membership authority per account

`startMembership({ space, server, accountId }, store)` already takes the account as a parameter
(`delivery.ts:310`, `membership.ts:30`), and is given the id pinned from the delivery creds. Two
units in one process are two calls with different account ids. The observer's tenancy check
(`membership.ts:89`) is what keeps one from reaching the other's account, and it is the same check
whether the second unit runs here or on another machine, because it is enforced by the broker
against the credential, not by the daemon against itself. Membership stays fail-soft per space: a
membership arm that will not start degrades that space, not its neighbours.

### 4.3 Leases, and why N is bounded

`ep.acquireDeliveryLease(shard)` (`delivery.ts:246`) is per space, in that space's own KV, so
single-flight is unchanged: two processes serving the same space still cannot both write, and the
handover during migration is serialized by the lease rather than by operator care. What changes is
that one process holds N leases, so losing it is an N-space failover rather than a one-space one.
That is the argument for bounding N and assigning spaces to processes, rather than one process for
the whole cluster. It is also why lease renewal and cred reload for one space must never queue
behind another space's work (prerequisite P3): a renewal starved by a noisy neighbour is a failover
that nothing was wrong with.

### 4.4 What sharding still refuses

`delivery.ts:162` refuses `shards != 1`, and multi-space mode does not lift it. That refusal is
about splitting **one** space across processes, which stays unsupported. Multi-space is the
orthogonal axis: many spaces per process, one process per space at a time. Which process serves
which space is the embedding's own assignment concern (§13), and the lease is what makes a wrong
answer a refusal rather than a corruption.

### 4.5 What stays process-wide

The broker-gone watchdog (`delivery.ts:392`, `:408`) exits the process when the broker has been
unreachable past its window. That stays process-wide and stays correct: the broker is shared, so its
absence is every tenant's fault at once, and one supervised restart is a better answer than N
independent tenants each deciding. This is the one exit that survives the re-read in §8.

## 5. The manager: the platform runs none

Two facts settle it. In static mode the manager self-mints from the data account's signing seed, out
of a store the delivery daemon shares (`manager.ts:306`). And the path that exists precisely so a
host holds no participant seed is `remoteAuthority`, where the participant owns every private seed
and the host returns scoped JWTs only (`manager.ts:317`). A multi-space manager process would
concentrate N tenants' signing seeds in one address space, which is the concentration the second
fact was built to avoid. There is no version of it worth designing.

So the hosted shape runs no manager. It serves `manager-service-authority` from the multi-space
face, and tenants run their own supervisor against it.

| Deployment | Manager process | Signing material | Authority path |
|---|---|---|---|
| local `cotal up` | one, on the user's machine | local and static | loopback discovery file plus per-start capability |
| hosted, tenant's own machine | the tenant's `cotal supervise` | seeds the tenant generated | the space's public `manager-service-authority` |
| hosted sandbox | one per sandbox, inside the sandbox | generated in the sandbox | the same public route |

The route already exists on the public table (`service.ts:1230`) and the remote arm of the provider
already resolves it from the pinned registry entry rather than a local file (`provider.ts:178`). The
hosted sandbox is not a special case: it is a participant that happens to run on the platform's
compute, it gets nothing a laptop does not get, and the platform holds no seed for it. That is why
the multi-space face needs no sandbox-specific route.

One property the multi-space face owes: `manager-service-authority` is issued by the plane of the
space in the path and no other (`plane.issueManagerServiceAuthority`, wired at `service.ts:726`).
That is why §3.2 parses the prefix before the table lookup instead of letting a handler read it.

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
themselves out of a local dir they sync between each other, so there is no resolver service to run,
secure, or keep available, which was the specific cost the earlier rejection named.

### 6.2 The push path

`resolver: { type: full, dir, allow_delete, interval, limit }` replaces the preload map. An account
JWT is added or updated by publishing it as a request to `$SYS.REQ.CLAIMS.UPDATE` on a system-account
connection, with no reload and no restart; `$SYS.REQ.ACCOUNT.<id>.CLAIMS.UPDATE` narrows a push to
one account, and `$SYS.REQ.CLAIMS.LIST` enumerates what the server holds. Changing the resolver
stanza itself still needs a restart or reload signal, which happens once at the migration cut (§9)
and never per tenant.

These are nats-server's own system subjects, and who may reach them is already fenced in this tree:
the membership observer is asserted to be refused `$SYS.REQ.CLAIMS.LIST`
(`packages/core/smoke/membership-feed-confinement.smoke.ts:138`). The push credential is a
system-account credential, which is material the config-rewriting path already has to hold, so this
widens no privilege.

| Mutation | MEMORY plus preload | Full resolver |
|---|---|---|
| add a space | rewrite the whole config, reload, re-read every tenant's trust | one push, one account touched |
| change one tenant's JetStream limits | the same whole-file rewrite | one push |
| remove a space | the same | one delete, gated by `allow_delete` |
| blast radius of a bad mutation | every tenant's trust | one account |
| proof it applied | infer from the running config or from behavior | read the claims back |

### 6.3 Reconciling with the U2 CAS inventory

U2 guards a config-file rewrite with a writer lease and a CAS inventory. The full resolver keeps all
of that except the artifact.

| U2 element | Under the full resolver |
|---|---|
| writer lease | unchanged: one mutator at a time, still TTL-leased |
| generation and the CAS points | unchanged in shape: intent, proof and commit are still bracketed |
| `configDigest` | becomes a digest over the resolver's account set, not over config bytes |
| abort-before-rename fence | becomes abort-before-push, at the same point and for the same reason |
| UNPROVEN RELOAD | becomes UNPROVEN PUSH: a push whose read-back was not seen is not a commit |
| forward-only once proven | holds harder, since undoing a pushed JWT is another push and so is forward motion by construction |
| SILENT EVICTION and RESURRECTION | narrowed: no whole-file rewrite exists, so an unrelated tenant's mutation can no longer drop or restore this account |
| TORN READ, TORN WRITE, FAIL-CLOSED ON UNCERTAINTY | unchanged |

The scope narrows honestly rather than disappearing. U2's hardest cases come from one artifact
carrying every tenant; per-account pushes remove the shared artifact. A push can still be lost and a
writer can still die between push and proof, so the saga stays. What goes away is the class where
one tenant's mutation resurrects or evicts another's credentials.

### 6.4 Limits ride in the account JWT

Data accounts are minted with `mem_storage: -1, disk_storage: -1` and no stream or consumer ceiling
(`provision.ts:341`, applied at `:461`). One tenant can consume the cluster's storage. At thousands
of tenants that is not a policy gap to defer; it is the reason the account JWT is the right carrier.
The limits ride in the claim, the broker enforces them per account with no daemon in the path, and a
plan change is one push (§6.2) that touches one tenant and reloads nothing. The hosted embedding
picks the numbers. This design adds no limits field to core: it uses the account-limits shape that is
already minted today.

### 6.5 Removal order

`allow_delete` gates removal, and the server renames the stored JWT rather than dropping it, which
keeps a mistaken delete recoverable. Order is the inverse of add: the daemons drop the space first
(§3.4, §4.4), then the account is deleted. Deleting first would leave live connections in an account
the broker no longer trusts, and the daemon would read that disconnect as a fault rather than as the
intent it was.

## 7. The seam an embedding calls

| Today | Multi-space |
|---|---|
| `runAuthService(args, store?)` | `startAuthServiceMulti(opts)` returning a handle with `add(space)`, `remove(space)`, `spaces()`, `closed` |
| `runDelivery(args, store?)` | `startDeliveryMulti(opts)` returning the same shape |
| `Manager`, `ManagerOptions` | unchanged, and not run by the platform (§5) |
| `serverConfig(broker, spaces, opts)` | unchanged for the local shape; the hosted shape renders the resolver stanza and pushes (§6) |
| `createBrokerAuth`, `createSpaceAccountAuth`, `SecretStore` | unchanged |

The multi-space entry points take an options object rather than `ParsedArgs`. `ParsedArgs` is the
CLI's shape, and a library caller should not have to build a flag bag to start a daemon. The
single-space `run*` functions stay, as thin wrappers that start a handle and `add` one space, so
`cotal up` and the hosted path share one code path instead of drifting apart.

Store keys need nothing new. They are already space-scoped: `auth/<segment>/callout.json`,
`issuer.json`, `owner-secret.json`, `service-keys.json` (`store.ts:58`), and
`deliveryCredsKey(space, composition)` / `membershipRwCredsKey(space, composition)` over
`segmentedKey` (`space-segmentation.ts:342`, `:362`, `:367`). One process reads N of them from one
injected store, and a hosted adapter resolves them under its own tenant scope as opaque ids. The
documented rule that the manager reads the same store as the delivery daemon (`manager.ts:306`) is
unchanged; at N tenants it means one store with tenant-scoped resolution, not N stores.

**What stays single-space.** Local `cotal up` and everything under it: one broker, one space, one of
each daemon, the ambient root for state, the MEMORY resolver with its preload map, unprefixed
loopback paths, and the broker-wide verbs that `assertSingleSpaceBroker` (`auth-paths.ts:694`)
already refuses on a multi-tenant root. A user who never hosts sees no behavior change from this
design, and the local path does not acquire a prefix, a resolver dir, or an assignment plane.

## 8. Failure and isolation

Every process-fatal exit in these daemons was written when a process meant a space. Each has to be
re-read as a question about blast radius, and they do not all answer the same way.

| Failure | Today | Naive multi-space | Containment |
|---|---|---|---|
| sealed scanner mid-life disconnect (plane FENCED) | whole process exits (`service.ts:805`) | every tenant on the process goes down | per-space teardown, §8.1 |
| callout connection closed | whole process exits (`service.ts:800`) | every tenant goes down | that space goes down and is re-added or reassigned |
| broker unreachable past the window | delivery exits (`delivery.ts:408`) | correct as written | stays process-wide: the broker is shared (§4.5) |
| plane claim lost to a successor | the open refuses | one space refuses | already per space |
| public face flooded | 64 in flight, process-global (`service.ts:124`) | one tenant starves the rest | per-space budget under a process cap |
| one tenant's JetStream growth | limits are unlimited | one tenant fills the cluster | limits in the account JWT (§6.4) |
| store read fails for one space | start fails | that `add` fails | add is per space and fails alone |
| membership arm will not start | that space degrades, fail-soft | unchanged | already per space |

### 8.1 A fenced plane must stop answering, not necessarily exit

SPEC 13.13's requirement is that a fenced plane answers nothing more. `process.exit(1)` is how the
daemon satisfies it today, and that is available because the process serves one space. The exit is
the implementation; "answers nothing more" is the invariant. In multi-space mode the invariant is
served by a per-space teardown, which has to be at least as total as the exit was:

1. Mark the space down first, before any I/O. The prefix stops routing and the callout stops
   answering. A fenced plane must not answer one more connect while its connections are closing.
2. Then close, in order: the callout subscription and connection, the five plane connections, the
   bundle and the prefix registration.
3. Then verify the close. A successor's reclaim adjudicates on liveness alone over a complete
   connection sweep, so a connection this process stopped using but did not close is still live to
   that sweep and blocks the reclaim it was supposed to enable. The fence path confirms the
   connections are gone rather than assuming it (prerequisite P5).
4. If any of that does not complete, escalate to the process exit. Fail-closed on uncertainty: a
   space that cannot be proven torn down means the process cannot say what it is still answering,
   and the old whole-process exit is the correct fallback. It is a worse outcome for the neighbours
   and a correct one. This design's job is to make it rare, not to remove it.

The identities a reclaim adjudicates on are per space, since each space's plane self-mints its own.
A multi-space process is therefore no obstacle to reclaim as long as step 3 holds.

### 8.2 What one process cannot promise

Fault containment across tenants sharing an address space is bounded by what a process can promise.
An out-of-memory kill, an unhandled rejection that reaches the top, or a stalled event loop is
process-wide, and no arrangement of per-space objects changes that. What this design contains is the
expected faults in the table above, and the honest statement of the rest is: N is the blast radius of
a process crash, which is why N is bounded and assignment is a platform concern (§4.3). Per-space
budgets keep one tenant's traffic off the shared event loop; per-space async paths keep one tenant's
slow store read out of another's lease renewal. Neither promises more than that.

## 9. Migration from the process-per-space shape

Zero re-keying is a requirement, and it is already satisfied by work that landed for other reasons:
every per-space name goes through one encoder (`auth-paths.ts:95`, `store.ts:58`,
`space-segmentation.ts:342`), and the runtime records are per space (`local-process.ts:56`, `:72`).
The migration changes process topology and the resolver. It renames nothing, re-mints nothing, and
invalidates no credential a tenant holds.

| Step | Action | Tenant impact | Reversible |
|---|---|---|---|
| 1 | Write the full-resolver stanza while keeping the preload map, one reload | none: preloaded accounts stay trusted | yes, revert the stanza |
| 2 | Push every existing account JWT and read the claims back | none: the same claims, now also resolver-held | yes, the dir can be cleared |
| 3 | Drop the preload block, second and last reload | none if step 2 was proven | yes, restore the block |
| 4 | Move the U2 inventory to the resolver-content digest at a generation boundary | none | forward-only from here |
| 5 | Start the multi-space processes; per space, stop the single-space daemons then `add` it | a short window where new connects are denied | yes, stop the add and restart the single-space pair |
| 6 | Repeat per cohort | as step 5 | as step 5 |

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
listener is already loopback-bound behind the operator's reverse proxy (`service.ts:744`), so the
proxy adds the prefix for pre-cut spaces and no tenant re-registers. Spaces created after the cut
receive the prefixed base in their bundle from the start, and never need the alias.

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
- `$SYS.REQ.CLAIMS.*` are nats-server's own subjects, used by an operator tool holding a
  system-account credential. They are not Cotal subjects and add nothing to SPEC.
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
   cross-tenant breach. The account boundary is the product.
3. **Keep MEMORY plus preload and rewrite the config faster** (batched adds, debounced reloads).
   Batching improves throughput while making the blast radius worse, since more tenants ride each
   rewrite, and it keeps every failure mode that exists because one artifact carries everyone.
4. **A URL resolver backed by a service the platform runs.** Rejected for the reason the per-space
   lifecycle design gave, which still holds: one more component to run, secure and keep available,
   whose outage is a broker-wide authentication outage. §6.1 takes the full resolver precisely
   because it does not add that component.
5. **Per-space worker threads or child processes under one supervisor.** It buys real memory
   isolation and gives back what multi-space mode is for: per-tenant memory returns (each thread
   pays its own runtime), and the connection count, which is the binding constraint, does not drop
   at all.
6. **A multi-space manager process.** It would hold N tenants' signing seeds in one address space
   (§5), which is what the remote-authority path exists to prevent.
7. **Lifting the delivery sharding refusal to serve one space from several processes.** Orthogonal
   to this design and it costs single-flight. Per-space load is not the problem being solved.

## 12. Prerequisites

| # | Prerequisite | Why |
|---|---|---|
| P1 | The per-space lifecycle verbs | hot add and remove is the daemon half of a lifecycle whose provisioning half lives there |
| P2 | An injected state base for the auth service, replacing the ambient root walk (`service.ts:649`) | a process serving N tenants' ledgers must not resolve them from a cwd walk |
| P3 | Per-space async isolation in both daemons | a lease renewal or cred reload starved by a neighbour is a failover with nothing wrong |
| P4 | The U2 saga | §6.3 modifies it rather than replacing it; without it there is no inventory to reconcile |
| P5 | A verified-close primitive for the fence path | §8.1 step 3 turns on proving connections are gone, not assuming it |
| P6 | Measured broker capacity | thousands of accounts on a full resolver, N callout connections per process, and the resolver sync interval all need numbers before N is chosen. This design asserts none |

## 13. Out of scope

- The assignment plane: which process serves which space, and how spaces rebalance across processes.
- Multi-broker and cluster topology, leaf nodes, and where a given space's data lives.
- Tenant provisioning, plans, billing, and the limit values themselves. §6.4 says where limits ride,
  not what they should be.
- Agents present in many spaces at once, which is the other half of the roadmap row.
- Splitting one space across delivery processes (§11.7).
- Broker-wide operator rotation.
- Any change to SPEC.
