# One auth service process for every space on a host

Status: implemented. `openAuthServiceLane`, `authHostSettings` and `runAuthServiceHost` are in
`implementations/auth/src/service.ts`; the version 2 manifest grammar, the startup policy option and
the `<manifest>.applied` acknowledgment are in `runSpaceHost` in
`packages/workspace/src/space-host.ts`, which the callout host and the delivery host also run on.
`cotal auth-service --spaces <manifest>` is documented under [server daemons](../cli.md#server-daemons).
SPEC §10, §13.13 and Appendix B were amended in the same change. `pnpm
smoke:auth-service-multi-space:auth` drives the real daemon over three spaces on a live broker.

The record below is the design as reviewed before implementation. Every claim about current behavior
names the file and function it was read from, at `origin/main` 5a9323f8b. The callout host (#4819,
[multi-tenant-callout.md](multi-tenant-callout.md)) and the delivery host (#4953,
[multi-tenant-delivery.md](multi-tenant-delivery.md)) are the templates.

## 1. The problem, measured

Cotal Cloud runs one auth service process per hosted space: `cloud-authsvc@<hex>.service` runs
`apps/backend/src/cotal/spaces/authsvc.ts`, which calls `runAuthService(args, store)` with the
platform's secret store as a code-level parameter. Each space has a stable public face port
(`spaces.auth_port`) that the backend proxies under one public origin
(`internalAuthFaceUrl(authPort)` in `apps/backend/src/cotal/space-discovery.ts`).

On the production Cloud box, stock 0.109.11, 2026-10-27 18:40Z: 16 auth-service processes use
1,657 MB (MemoryCurrent plus swap), about 103 MB per space. That is the largest per-space cost left
after the delivery host. Most of it is the same module graph loaded sixteen times; the callout
design measured that graph at about 136 MB RSS before a single space is served. The implementation
step measures RSS per space at 1, 4 and 16 lanes in one process against 16 single-space processes,
on a live `nats-server`, and reports the table in the PR.

`cotal auth-service --spaces <manifest>` exists today only with `--callout-only`
(`authServiceConfiguration` in `implementations/auth/src/service.ts` refuses `--spaces` without
it). A callout replica answers connects and nothing else. A space still needs its one full primary:
the authority plane, the exchange, the JWKS and the public face.

## 2. What is already space-parameterized

Read from `implementations/auth/src/service.ts` (`runAuthService`, `startAuthContext`,
`startAuthService`):

- `startAuthContext(o)` already takes the space as an input and derives every per-space fact from
  it: the secret loads (`loadServiceKeys`, `loadCalloutAuth`, `loadIssuer`, `loadOwnerSecret`, all
  keyed by space over one store), the IdP pin (`loadPinnedIdp(dir)` in the space's state dir), the
  authority plane and its claim (`openAuthAuthorityPlaneWithCustody`), the callout connection, the
  `ConnectLimiter`, the per-start capability, the failure budgets and both HTTP listeners.
- It installs no signal handler and never exits the process. `startAuthService` already runs it as a
  hosted context; `runAuthService` adds the process shell: the discovery file
  (`saveAuthServiceInfo(dir, ...)`), SIGINT and SIGTERM handlers, and `process.exit` on a fence or a
  broker loss.
- Every signing key enters the request path through a closure built once per context: the callout
  through `serveCallout(nc, { callout, dataAccount, issuer, hooks })`, the exchange through
  `createIdpBridge({ spaceSecret: ownerSecret, issuer, ... })` and the `HandlerCtx` the listener
  handlers close over. No code on a request path maps a space to a key.
- Module-level state on this path is keyed per space or per ledger directory: `SPACE_SCAN_CHAINS`
  (ledger and records scanners, keyed by space), `MANAGED_ALIAS_CHAINS` (keyed by the resolved
  ledger dir), `CHAT_HOLDER_CHAINS` in `chat-session-authority.ts` (keyed `<space>:<owner>.<hash>`),
  `armRenewal`'s spacing table in `packages/core/src/renewal.ts` (keyed by space). The other
  module-level maps on the service path are `WeakMap`s keyed by per-context objects. Two contexts in
  one process share no row of any of them.

Two things are single-space by construction: the process shell in `runAuthService`, and the CLI's
flags, which carry one space's listener settings.

## 3. The lane

`openAuthServiceLane({ space, server, root, secrets, publicFace, serviceEndpoints, limits, log })`
in `service.ts` opens one space's full primary: `startAuthContext` with the CLI composition's
sources (the root's state dir, the local manager read from the root), then that space's discovery
file. It returns the `SpaceLane` shape the other two hosts use: the space, a `close()`, and a
`lost` promise that settles with what the lane lost once it stops serving.

A lane installs no signal handler and never exits. On a fence or a broker loss its context closes
itself (`startAuthContext` already does), the lane removes its discovery file and settles `lost`,
and the host reopens it.

`runAuthServiceHost` holds the lanes on `runSpaceHost`. `runAuthService(args, store)` dispatches to
it when `--spaces` is given without `--callout-only`, so the embedder entry Cloud already calls is
the library entry: Cloud passes its store and a manifest path, and no new export is needed.

Each lane writes its space's own `auth-service.json` (loopback URL, the host's pid, its own
capability, its public URL), so every local reader (`userCredentials`, `agent-bearer`, the
provider's readiness poll) finds a space's service as it does today. A lane removes the file at the
start of its close, before the plane claim is released, so a successor that wins the released claim
never has its file removed by its predecessor. A lane does not scrub the file before it wins the
claim: during a migration the space's old process still serves and still owns that file, and a
lane retrying every 5 seconds would otherwise delete it each time. A stale file from a dead process
names a dead pid, which every reader already treats as not running.

Lane lines carry a `[<space>] ` prefix, as the delivery host's do. The callout journal line already
carries `space=` and keeps its format.

## 4. Isolation

The rule: each lane uses only its own space's material on its own connections, and no credential
widens across spaces. Three structural barriers give it, and none is a runtime lookup.

**The broker confines each lane's connections.** A space is its own NATS account. The callout
connection authenticates as the space's auth account (`callout.calloutCreds`); the plane's store,
scanner, barrier, reader and issuer connections authenticate with user JWTs the space's data
account signs (`dataAccount.signingSeed`). A NATS account is a disjoint subject namespace, so lane
A's callout requests, ledger, records, sessions and claim row are reachable only on lane A's
connections. This is #4819's argument, extended from the callout to the whole plane.

**The closure decides which key signs.** Each lane calls `startAuthContext` once, so its xkey, its
auth and data account signing keys, its owner secret and its issuer keys are captured in that
context's closures for the lane's life. The host holds a map from space to lane handle for reconcile
and holds no map from space to key, credential or context on any request path.

**The listener decides which lane answers HTTP.** Each lane binds its own loopback listener and its
own public listener, and each listener's handler closes over that lane's `HandlerCtx`. The kernel
demultiplexes by port before any Cotal code runs. See section 5.

The suite proves the result from the outside: a bearer minted by space A's exchange connects only
into A's data account (read from the broker's `/connz`); A's bearer is refused by B's callout; A's
actor token is refused by B's exchange; A's and B's JWKS publish different keys; each space's
claim row names its own lane's scanner connections.

## 5. Listeners: one port per space per face

Decision: each lane binds its own loopback face on an ephemeral port, published in that space's
`auth-service.json` as today, and its own public face on the port the manifest names for that space.

Rejected: one listener for every space, routed by path (`/s/<space>/exchange`) or by `Host`.

- It changes the published HTTP contract per space. The exchange URL is in the discovery bundle
  (`endpoints.url`), in `auth-service.json`, in the operator's `--exchange-public-url`, and in Cloud
  as `internalAuthFaceUrl(authPort)`, which the backend compares against its runtime URL in at
  least four places. A per-space port keeps every one of them as it is.
- It puts a space-to-context lookup on the request path. A routing defect would answer space A's
  exchange from space B's context, which mints with B's owner secret and issuer keys. The callout
  design ruled out that class of lookup for keys; a shared listener would reintroduce it one layer
  up.
- The per-face budgets (refused-exchange window, bad-capability window, the per-peer probing budget,
  the trusted-proxy policy) live in each context. A shared listener would have to re-key every one
  per space.
- It saves almost nothing. An idle `http.Server` is a few kilobytes, and client sockets are per
  request either way.

The cost of the decision is one public port per space, which is the allocation Cloud already makes.

## 6. The manifest, version 2

The full primary needs per-space listener settings; the v1 manifest is a list of names. Decision: a
version 2 manifest whose entries are objects, parsed by the shared grammar in `space-host.ts`, with
the fields other than `space` validated by the host that reads it:

```json
{ "version": 2, "spaces": [
  { "space": "<s>", "exchangePublicPort": 7451, "exchangeTrustedProxy": true },
  { "space": "<s>" }
] }
```

- The shared grammar keeps every v1 refusal (not whole or not JSON, unknown top-level field, empty
  list, empty or repeated space name) and adds: an entry must be an object with a `space` string. A
  host passes `runSpaceHost` a settings parser for one entry, plus an optional check across entries.
  A host without one reads version 1 only; a host with one reads version 2 only. A manifest written
  for one kind of host never runs on the other with its settings silently ignored.
- The auth host's entry fields are the public-face group of `auth-service --space`, under the same
  names in camel case: `exchangePublicPort`, `exchangePublicUrl`, `exchangeTrustedProxy`,
  `advertisedServer`, `agentProvisioningUrl`. Each entry gets the single-space rules: the last four
  require `exchangePublicPort`, and `checkPublicFace` runs on it. Across entries, two spaces naming
  one nonzero port refuse the whole manifest, which keeps the live lanes.
- Host flags are what is one value per broker or host: `--server` and `--auth-timeout` (the broker's
  `authorization { timeout }`). `--space`, `--port` and the five public-face flags refuse with
  `--spaces`; the refusal names the manifest as where the face is set. `--service-endpoints` first
  applied to every lane; it now refuses too, and an entry's `serviceEndpoints` (`true` or `false`)
  sets it per space, so a space that admits service endpoints no longer needs a process of its own.
- A live lane whose entry changes is closed and reopened by the same reconcile pass, since a bound
  listener cannot change its port. This is the multi-space form of the existing rule that a
  listener flag change needs a restart.

Rejected:

- Settings derived from the space. A port computed as a base plus the entry's index moves when an
  earlier space leaves; one computed from a hash collides; one read from a per-space file in the
  state dir is a second source of truth beside the manifest; one read from the mesh registry reads
  the service's output back as its input.
- One version 2 file shared by all three hosts. A callout or delivery host would accept face
  settings it cannot apply. Separate files also let an embedder order roles per space: Cloud starts
  authsvc before delivery and stops authsvc first, and one shared file would change both at once.
  An embedder writes each file from its own database, which stays the one source of truth.
- Per-space settings on the command line. A command line is a publication surface, and it cannot
  change without a restart.

## 7. Startup: serve what can be served, retry the rest

Both shipped hosts refuse to start unless every space opens. Decision: the full primary host
serves every space it can at startup, reports each one it cannot by name, and retries those every
5 seconds through the same reconcile path, as it already does after startup.

Why, on merit:

- The full primary is each space's only minter and its only authority plane. All-or-none makes
  every restart (a deploy, a crash, an OOM, a reboot) an outage for every tenant on the host
  whenever any one tenant has a fault: missing material, a corrupt claim row, an account not yet in
  the broker config, a port held by a stray process. With one process per space, that fault stopped
  one unit.
- A crashed host leaves every space's claim row `held`. Reclaiming a held row needs that space's
  delivery daemon to answer the liveness oracle (SPEC §13.13). Cloud starts authsvc before delivery,
  and one space whose delivery lane is down would hold every space's auth service down at restart
  under all-or-none.
- Migration needs it. A host started while a per-space unit still serves space X sees X's claim held
  by a live peer. All-or-none refuses the whole host until every old unit is stopped. Servable
  startup brings the others up, and X opens within 5 seconds of its old unit's clean stop releasing
  the claim.
- Readiness is already per space. A space has an `auth-service.json` only while its lane serves, so
  a reader asking about one space is never told a partial host serves it.
- It stays loud. Each unservable space gets a startup line naming it and the reason, and a line on
  every retry. The ready line counts the spaces serving against the spaces named.

What still refuses at startup, with nothing left running: a flag error, a manifest that does not
read or parse whole (there is no list of spaces to serve), and a manifest directory that cannot be
watched.

Rejected: all-or-none for the full primary, for the reasons above. The argument "a typo in the
manifest should be loud" is met by the per-space lines; it does not need every other tenant to go
down with it.

The callout host kept all-or-none in this change. The shared loop takes the startup policy as an
option. The same reasoning applies to the delivery host, whose lanes answer the oracle this host's
restarts depend on: one bad tenant at a restart could hold every tenant's auth down through it. The
delivery host moved to servable startup in the change after this one, and the callout host after
#5003, where one space with open service endpoint admission kept every space's callout lanes down.

## 8. Per-space failure isolation

Per lane, as in a single-space process: its own connections, plane claim, scanners, barrier,
issuer session, connect limiter, failure budgets, capability, listeners and discovery file.

- **Broker loss or renewal failure.** The context closes itself and reports `unavailable`
  (`startAuthContext`'s `ended`). The lane settles `lost`; the host reopens it at once, then every 5
  seconds while it fails. This replaces systemd's `RestartSec=5` for that space alone.
- **Fence.** An owned scanner disconnect fences the plane, and SPEC §13.13 requires that the
  space's service go down rather than serve from a half-dead plane. In a host the lane is that
  space's service: every authority operation of that space refuses from the fence on, its listeners
  and callout close, and the other lanes are untouched. Its reopen reclaims through the oracle, as a
  restarted single-space process does.
- **A close that cannot release the claim.** A single-space process exits non-zero and the kernel
  closes its sockets. A lane does the equivalent: it logs the failure, closes every connection and
  listener it still holds, and settles `lost`. The claim row is left `held` by connections that are
  now gone, which is the crash shape the oracle reclaim already handles. The lane never keeps a
  half-closed plane.
- **What lanes share.** The event loop, the heap and the process. One lane's CPU delays another's
  callouts (section 10 covers the capacity), one OOM or one uncaught exception ends every lane. The
  host installs no catch-all exception handler: continuing after an unknown fault would be a
  fallback. The supervisor restarts the host, and servable startup brings each space back on its
  own.

## 9. Stopping minting for one space

Cloud's teardown stops the minter first as its mint fence: `stopTrio` runs `systemctl stop
cloud-authsvc@<hex>` and continues only after it returns (`apps/backend/src/cotal/spaces/units.ts`,
`destroy.ts` §4.3). With one host for every space, the fence is a manifest removal plus an
acknowledgment that it took effect.

**Removal.** Removing a space from the manifest closes its lane in the next reconcile pass. The
lane's close order is the existing `close()` in `startAuthContext`, so the exchange stops first:
the discovery file is removed, both listeners stop admitting and give accepted requests the public
request deadline, then the authority plane closes (its claim is released and no ledger write is
possible), and the callout connection closes last.

**Acknowledgment.** After each reconcile pass has closed every lane its manifest does not name, the
host writes `<manifest>.applied`, atomically, holding `{"version": 1, "sha256": "<hex>"}`: the
SHA-256 of the manifest bytes that pass read. It states that every space that manifest does not name
has no lane in this process. Opening is not part of it; a space's readiness is its own discovery
file. The acknowledgment is written by `runSpaceHost` itself, so the full host, the callout host and
the delivery host all write it with this one contract. A host that cannot write it at startup
refuses before it opens any lane.

The fence covers every process that can authorize a connect for the space. The full host is one;
each callout replica host listing the space (section 10) is another, since it answers the space's
callout queue group with outstanding bearers. An embedder's fence for one space is: remove the space
from every manifest that names it, then wait until each of those hosts acknowledges the manifest it
was given. A host whose last space is removed is stopped instead, because a manifest names at least
one space; stopping its unit is that host's fence.

This is sound because passes are serialized and each pass reads the manifest afresh. A pass that
read an older manifest may still be opening the removed space when the new manifest lands; the next
pass, which reads the new one, closes it before it writes the acknowledgment. No pass opens a space
its own manifest does not name, a reopen after a loss goes through a pass, and the retry timer only
schedules a pass.

Rejected:

- Inferring the fence from the discovery file's absence or the port refusing. A pass that read the
  older manifest can open the space after the embedder observed the absence, so the inference has a
  window in which the space mints.
- A per-space stop file or a stop flag in the entry. That is a second source of truth beside the
  manifest's list.
- A control endpoint on the host. It is a new authenticated surface for one bit of state.
- A signal naming the space. Signals carry no payload and no reply.

A host writes no acknowledgment while it is not running. Stopping a host's unit remains the fence of
last resort, and it stops every space that host serves.

## 10. Scale-out

**One host per broker.** Every lane dials the one `--server`. A deployment with several brokers
runs at least one host per broker.

**Spaces partitioned across hosts.** Several hosts may serve one broker with disjoint manifests,
which bounds what one process crash or one OOM takes down. Disjointness is the operator's intent;
at-most-one primary per space is enforced by the plane claim (SPEC §13.13), never by the manifests.
Two manifests naming one space give one serving lane and one lane retrying every 5 seconds with the
"live peer" refusal, which is safe and loud.

**Moving a space from host A to host B.** Remove it from A's manifest, wait for A's acknowledgment,
add it to B's. Callout replica hosts need no change for a move: they keep answering the space's
queue group throughout. A's close released the claim, so B claims the released row with no oracle round, and
the gap is B's open time. The reverse order is safe too: B retries until A releases. If A crashed,
B reclaims the held row through the oracle, which needs the space's delivery daemon up. Hosts that
share a root (one box) move a space freely. Moving a space to another box also moves its state dir
(the actor ledger and IdP pin live there, not in the store), which is outside this change.

**Callout CPU, and the storm arithmetic.** Measured by cloud_ux on the 2 vCPU lab VPS at stock
0.109.11: the auth service spends 7.8 ms of CPU per callout (medians over steady 5, 10 and 20 per
second, one callout process). A burst of 250 connects admitted 179; the refusals were broker
`authentication timeout` against the default 2 second window, with no callout reason. Derived: one
Node event loop runs callouts serially, so it caps near 1000 / 7.8 = 128 callouts a second, and a
simultaneous burst larger than about 256 cannot finish inside the 2 second window on one loop
(observed: about 180).

Sixteen processes spread a reconnect storm over the box's cores: on a 4-core box that is up to about
4 x 128 = 512 callouts a second. One host for every space puts the whole storm on one loop: 128 a
second. A box carrying C connections that all reconnect after a broker restart needs C x 7.8 ms of
callout CPU: 1,000 connections is 7.8 s on one loop, about 2 s on four. Clients that time out retry,
so the storm drains rather than fails, but it drains four times slower on one loop.

Decision: keep callout CPU parallel with stock callout replicas. Next to the full primary host, run
K - 1 callout hosts, `cotal auth-service --callout-only --spaces <list>`, over the same spaces.
Each is a member of every listed space's `cotal-auth-callout` queue group, and the broker spreads
each space's callouts over the members. K processes give K event loops, so size K to the box's
cores: on 4 cores, one full host and three callout hosts give the same storm capacity as sixteen
processes with four processes' module graphs. The callout hosts also keep connects answered while
the full host restarts. The embedder writes their v1 list from the same database it writes the v2
manifest from, and its mint fence for a space includes them (section 9).

One constraint, named: a callout replica cannot issue a service-endpoint connection and refuses a
space that admits service endpoints (`openCalloutLane`). Such spaces are answered by the primary's
loop alone until that is lifted, which is a separate change. A callout host names and retries such a
space and serves the rest, and `admitsServiceEndpoints` tells the writer which spaces to leave off
its list. Cloud's unit sets
`--service-endpoints` when `COTAL_SERVICE_ENDPOINTS=1`.

Other levers, unchanged by this design: `--auth-timeout` widens the window a burst must fit in, and
the callout's own CPU per request is an optimization target of its own.

Rejected:

- Worker threads per lane. Each worker is a V8 isolate that loads the module graph again, which
  gives back most of the memory this change saves, and it moves signing keys across a thread
  boundary into a new concurrency model in the authority plane.
- Node `cluster`. It shares one listener across processes, which per-space ports do not need, and it
  is otherwise the same as separate processes.
- Only partitioning spaces across full hosts. It spreads a storm across hosts by space, but one busy
  space still gets one loop. It is the tool for blast radius; replicas are the tool for CPU.

No mechanism gives one space CPU isolation from another inside one loop. Partitioning is how an
operator separates spaces that must not share one.

## 11. What the operator and an embedder run

```bash
cotal auth-service --spaces <manifest> --server <url> [--auth-timeout <seconds>] [--service-endpoints]
```

An embedder calls `runAuthService(args, store)` with `spaces` and `server` in `args.values`, and its
store as the only source of every space's secret material, as it does for one space today. The
`auth-service` service preset keeps running one space; a lifecycle-hosted run with `--spaces`
refuses.

A signalled host closes every lane at once and exits 0 once they have closed. A lane writes no
pidfile; `cotal down` signals the per-space pidfile `cotal up` writes, and the host is owned by its
supervisor, like the other two hosts.

## 12. What `--space` keeps

`cotal auth-service --space <s>` keeps its flags, refusals, lines, discovery file, signal handling
and exit codes. The context code it runs gains a log sink that defaults to `console.error`, so its
output is unchanged. `--callout-only --spaces` is unchanged.

## 13. SPEC and docs paragraphs this touches

| Paragraph | Why |
| --- | --- |
| §10, the auth-callout onboarding paragraph | It states one process MAY serve several spaces' callouts. The same process may now serve several spaces' exchange and JWKS; each space's exchange is served on that space's own listeners from its own keys. |
| §13.13 Plane ownership | One process MAY hold the planes of several spaces, one claim each. The holding invariant's "the service goes DOWN" applies to that space's service, the lane, in a process serving several. |
| Appendix B, the `issuer` bullet | It says an auth service holds one session per account, space and plane lifetime, and that a replica process may hold several. A full service process may hold several too, one per space. |
| Appendix D | A change log row. |

Docs: `docs/cli.md` server daemons (synopsis and the `--spaces` paragraphs), `docs/identity-and-auth.md`
(one auth service per space, held by one process per space or one host for many), and this record as
`docs/design/multi-tenant-auth-service.md`.

## 14. Proof

A live suite drives the real `auth-service --spaces` daemon over a real `nats-server` with two
provisioned user-auth spaces: one process serves both; each space's loopback and public exchange and
JWKS answer, and differ; each space's bearer connects only into its own data account; a cross-space
bearer and actor token are refused; every connection a lane holds is in its own space's accounts;
with a callout replica host beside the full host, removing one space from both manifests is
acknowledged by each only after that space has no listener, discovery file, connection or callout
responder left on the box, so its outstanding bearer no longer connects, while the other space keeps
exchanging and connecting; one unservable space at startup leaves the other serving,
retries by name, and opens once its fault is cleared; the grammar refusals hold. `--measure` reports
RSS per space for 1, 4 and 16 lanes against 16 single-space processes.

## 15. Decisions for review

1. **Per-space ports.** Rejected: one listener routed by path or host (section 5).
2. **A version 2 manifest with per-space public-face fields**, host-level `--server`,
   `--auth-timeout` and `--service-endpoints`. Rejected: derived settings, one file for every host
   kind, per-space flags (section 6).
3. **Servable startup with per-space retry** for the full primary. Rejected: all-or-none (section 7).
   The other two hosts are unchanged; the delivery host is a follow-up.
4. **Per-space failure isolation** with the lane as the unit a fence downs, and a failed close
   ending in the crash shape (section 8).
5. **The mint fence for one space** is its removal from every manifest that names it, full and
   callout hosts alike, plus each host's `<manifest>.applied` naming that manifest's digest. All
   three host kinds write it. Rejected: inference from absence, a stop file, a control endpoint, a
   signal (section 9).
6. **Scale-out** by one host per broker, disjoint manifests enforced by the plane claim, moves by
   remove, acknowledge, add, and callout CPU kept parallel with stock callout replica hosts sized to
   the cores. Rejected: worker threads, cluster, partitioning alone (section 10).
