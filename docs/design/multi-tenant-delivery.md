# One delivery process for every space on a host

Status: implemented. `openDeliveryLane` is in `implementations/delivery/src/delivery.ts`,
`runDeliveryHost` is in `implementations/delivery/src/delivery-host.ts`, and the manifest grammar
and reconcile loop are `runSpaceHost` in `packages/workspace/src/space-host.ts`, which the auth
callout host now runs on too. `cotal deliver --spaces <manifest>` is documented under
[server daemons](../cli.mdx#server-daemons). SPEC Appendix B was amended in the same change.
`pnpm smoke:delivery-multi-space` drives three spaces through one process on a live broker. The
shipped code settles or extends the text below in six places:

- `--shard` and `--shards` refuse with `--spaces`, with `--creds` and `--dev-mint`, rather than
  applying per lane: every lane runs one shard.
- A lane's ready line is `✓ delivery lane up (space <s>)`. The single-space line names `cotal down`,
  which would stop every lane.
- A signalled host closes every lane at once, and exits after 10 seconds when a lane cannot finish;
  a lease left behind expires with its bucket TTL. The shared host also closes the lanes it opened
  before it refuses on a manifest directory it cannot watch, and closes lanes at once on a startup
  refusal. Both apply to the callout host.
- A context that closes itself on a lost lease names what it lost. The hosted entry's `unavailable`
  cause carries the same phrase.
- Startup now serves the spaces it can and retries the rest, as the full auth service host does
  ([multi-tenant-auth-service.md](multi-tenant-auth-service.md) section 7), so decision 2 and the
  all-or-nothing text of section 6 no longer hold: one space's fault at a restart keeps no other
  space's delivery, or the plane-claim oracle its lane answers, down.
- The suite also proves renewal by an outside party: the stock `remintDaemonCreds` re-signs one
  lane's credential in the root store, and the broker reports that lane's connections presenting it
  before the old one expires, while another lane's connections are untouched.

The record below is the design as written before implementation.

A design record, not a description of shipped behavior. Every claim about current behavior names the
file and the function it was read from, at `origin/main` 888874668. Everything else is proposed. The
callout host of #4819 (`docs/design/multi-tenant-callout.md`) is the template, and this record
follows its structure.

## 1. The problem, measured at this head

Cotal Cloud runs one `cotal deliver --space <s> --server <url>` process per hosted space. On stock
0.109.11 each costs 78 MB (73 MB resident, 5 MB in swap), so sixteen spaces cost about 1.25 GB of an
8 GB host.

Most of that is the same code loaded sixteen times. Measured on this host at this head, Node
24.22.0, GC settled, importing `implementations/delivery/dist/index.js` and nothing else:

| | RSS |
| --- | --- |
| Node baseline, no imports | 45 MB |
| After the delivery module graph | 114 MB |

So about 69 MB of every per-space process is the module graph before it opens a connection. One
process holding sixteen lanes pays it once. The implementation step measures RSS and CPU per space
at 1, 4 and 16 lanes in one process against 16 single-space processes, on a live `nats-server`
under identical load, and reports the table in the PR.

## 2. What is already space-parameterized

Read from `implementations/delivery/src/delivery.ts` (`runDelivery`, `startDeliveryService`,
`runStartedDelivery`), `membership.ts` (`startMembership`), `evict-exec.ts` (`ScanTarget`,
`validateScanTargetAdmission`) and `watchdog.ts` / `transport-health.ts`:

- `runStartedDelivery` already takes the space as an input and derives every per-space fact from it:
  the credential key (`resolveCredsStore`, `deliveryCredsKey(space, …)`), the registry record
  (`resolveMeshTarget(root, { space })`), the `$SYS` scan target (`ScanTarget.source.space`), the
  endpoint (`new CotalEndpoint({ space, … })`), the lease (`deliveryBucket(space)`), the membership
  feed and the timer writer (`startTimerWriter(nc, space)`).
- The credential is captured in a closure at start. `loadDeliveryCreds` returns a `source` that
  re-reads one fixed key of one fixed store; the endpoint calls it at each renewal. Nothing maps a
  space to a credential at request time.
- A hosted mode already exists. `startDeliveryService(inputs)` calls `runStartedDelivery` with
  `hosted` set, and in that mode the function installs no signal handler, writes no pidfile, never
  calls `process.exit`, throws where the CLI exits, and on a broker loss or a lost lease closes its
  own context and reports `unavailable` instead of exiting. The existing
  `hosted-delivery-startup-isolation` suite runs two such contexts in one process.
- Every lease, watchdog and eviction object is per call: `DeliveryTransportHealth` and its
  `LoopLagMeter`, the renew interval, the lease watch, the revision, the `ScanTarget`. Core's only
  module-level per-space state on this path is `armRenewal`'s spacing table in
  `packages/core/src/renewal.ts`, which is keyed by space.

Two things are single-space by construction:

- The hosted mode is tied to an injected `SecretStore` and a `HostedContextInputs` record. The CLI
  daemon reads a workstation root instead: per-space credentials under
  `<root>/.cotal/<spaceSegment(space)>/`, the mesh registry, and the repair advice that names CLI
  commands. A host for Cotal Cloud needs the CLI's sources with the hosted mode's process behavior.
- The CLI mode owns the process: SIGINT and SIGTERM handlers, the start-up fault guards, the
  pidfile, `process.exit` on a lost broker or lease. Two spaces cannot share it.

Each space costs four NATS connections today: the endpoint, the timer writer, and the membership
feed's observer and rw connections. Eviction and liveness verbs open per-call `$SYS` connections.

## 3. The lane

`runStartedDelivery` gets a third mode beside the CLI and hosted ones. A **lane** reads the CLI's
sources (the workstation root's store and registry, the same refusals and repair advice) and has the
hosted mode's process behavior (no signal handler, no pidfile, no start-up fault guard, no
`process.exit`). Internally the process-owning branches test "is this context held by someone else"
rather than "is this hosted", so the hosted mode and the lane share one set of branches.

`openDeliveryLane({ space, server, root, rootNamed, tls, log })` in `delivery.ts` returns a handle:
the space, a `close()`, and a `lost` promise that settles with what the lane lost once it stops
serving, by a deliberate close or by a fault. That is the shape of `CalloutLane` in
`implementations/auth/src/callout-lane.ts`. A start-up failure after the lease acquire gives the
lease back before it rethrows, as `startDeliveryService` does.

`runDeliveryHost({ manifest, server, root, rootNamed, tls })` holds a `Map<string, Lane>` and the
process shell for many lanes. A lane that ends leaves the map and is reopened by reconcile.

The manifest grammar and the reconcile loop of `implementations/auth/src/callout-host.ts` move into
`@cotal-ai/workspace` as one generic host (`parseSpaceManifest`, `runSpaceHost`), and both the
callout host and the delivery host call it. Implementations never import each other, and two copies
of one manifest grammar would drift. The callout host's behavior and log lines stay as they are.

`cotal deliver --space <s>` is the CLI mode, unchanged.

## 4. Isolation

A lane can act only inside its own space's account, and no code on a hot path selects a credential
for a space.

**The broker confines each lane.** In auth mode a space is its own NATS account. Every connection a
lane opens authenticates with a credential the space's account signed: the endpoint and the timer
writer with the space's `delivery` credential, the membership feed with its `membership-rw`
credential, and the `$SYS` observer and evictor with credentials whose CONNZ and KICK permissions
are scoped to that account (checked at start by `observerTenancyProblem`). A NATS account is a
disjoint subject namespace, so lane A's lease row, durables, control rail and streams are reachable
only on lane A's connections.

**The closure decides which credential a lane presents.** Each lane resolves its credential source
once at open, `deliveryCredsKey(space, { injected: false, root })` on the root's one store, and the
endpoint's renewal calls only that closure. The `$SYS` pair, the membership rw key and the scan
target are pinned to the lane's space at open the same way. The host holds a map from space to lane
handle for reconcile and holds no map from space to credential. Adding a lane adds a closure.

The suite proves the result from the broker rather than from the host's report: each space's lease
row is held by that space's own delivery identity; a CONNZ sweep of each account with that space's
observer lists the lane's delivery identity there and the other lane's nowhere; and each space's
control rail answers only through its own lane.

## 5. Per-space singleton guarantees, per lane

Each guarantee holds per lane because each is built from the lane's own objects:

- **Lease.** The single-flight row lives in `deliveryBucket(space)` in the space's account. Each lane
  acquires it on its own endpoint before binding, renews it on its own interval, and watches its own
  key. A row taken by another holder ends that lane only, through the same `leaseAction` and
  `mayServeOn` decisions; in the CLI those paths call `shutdown(1)`, in a lane they close the lane and
  settle `lost`. A second process for the same space, a lane or a single-space daemon, is refused by
  the atomic create exactly as today.
- **Watchdog.** Each lane has its own `DeliveryTransportHealth` driven by its own endpoint's
  transport edges. A broker loss or a credential expired without renewal closes that lane and
  reports it; the other lanes' connections and clocks are their own. The `LoopLagMeter` measures the
  shared event loop, which is the right evidence: a lane whose timers fired late was starved, as in a
  single process.
- **Eviction and liveness.** The four verbs run per call against the lane's `ScanTarget`: the root
  pinned at host start, the lane's space, and the account its own credential authenticates as. The
  admission check runs per lane before its endpoint or lease exists.
- **Renewal and adoption.** Each lane's `reloadCreds` and `reloadStoreIdentity` are served on its own
  endpoint's admin rail. All lanes report the same workstation root identity because they read one
  root's store, which is what a manager on that root expects.
- **Timer writer and membership feed.** One of each per lane, on the lane's own connections, with
  the same restart loop and fail-soft rule.
- **Pending views.** `cotal pending` and `deliver pending` are CLI reads over one space's DM durable
  with their own admin credential. They never talk to the daemon, so the host changes nothing there.
- **Pidfile.** A lane writes no `delivery.<space>.pid`. The record names the process `cotal down`
  signals for that space, and signalling a host stops every space it serves. The host is owned by
  its supervisor, as the callout host is. `cotal status` reads the lease, so a lane's space still
  shows a bound responder; a root with no pidfile reads as absent, never stale.

## 6. Adding and removing a space while the process runs

One reconcile function diffs the manifest against the live lanes and opens or closes the
difference, with the triggers and timing #4819 ships: the manifest's directory changing on disk, a
`SIGHUP`, a lane's loss (at once, then one fixed 5 second wait after a failed reopen), and a 60
second backstop. A manifest that does not read or parse whole is reported and the open lanes are
kept.

Closing a lane follows the existing `close()` in `runStartedDelivery`: quiesce Plane-3, release the
lease against the broker's revision, then stop the membership feed, the timer writer and the
endpoint. While a space has no lane its messages wait in their durable streams, as they do while a
single-space daemon restarts. Opening a lane is the start-up path, lease first.

A lane whose lease another process holds fails to open with the existing "a live lease already
exists" line and is retried every 5 seconds. That gives the migration from one process per space:
start the host on a manifest of spaces that have no daemon, then for each remaining space stop its
single-space process and add the space to the manifest. Startup is all or nothing and names the
space it could not serve, so a host started while a single-space daemon still holds a lease refuses
rather than serving the rest.

## 7. What the operator runs

```bash
cotal deliver --spaces <manifest> --server <url> [--root <dir>] [--tls]
```

The manifest is the same file the callout host reads, `{"version": 1, "spaces": ["<s>", "<s>"]}`,
with the same refusals.

`--space` and `--spaces` are mutually exclusive and there is no single-space fallback. `--spaces`
requires `--server`, because every lane dials one broker. It refuses `--creds` and `--dev-mint`,
which name one space's credential, and the `pending` read. The N=1 shard rule applies per lane as
today. `--root` names the root holding every space's credentials; without it the nearest `.cotal/`
above the working directory is chosen once at start.

Each lane prints the lines a single-space daemon prints, prefixed with `[<space>] `, so sixteen
lanes on one stderr stay readable. The host prints one line per lane opened, closed or lost, and
one ready line naming the spaces it serves.

`deliver` is a deprecated entry. Its warning today names `cotal service start delivery`, which has
no multi-space form, so a run with `--spaces` is told to keep `cotal deliver` for that flag, the way
`supervise` already words its flags that `cotal manager start` lacks.

## 8. What `--space` keeps

`cotal deliver --space <s>` keeps its behavior: the same refusals, lines, pidfile, signal handling,
exit codes and teardown. Its log lines go through the same sink with no prefix, so its output is
byte-identical. The hosted entry `startDeliveryService` keeps its behavior.

## 9. SPEC and docs paragraphs this touches

| Paragraph | Why |
| --- | --- |
| Appendix B, the `delivery` bullet | It describes the profile as the delivery endpoint's serve credential and reads as one daemon per space. One process MAY hold the role for several spaces, one credential and one set of connections per space, never shared across accounts; that needs stating, as #4819 stated it for `issuer`. |
| Responder verdicts, the delivery line | It grades a responder from its own shard lease row. Each lane is its own responder; read for conformance and expected to need no change. |
| §8 durable backstop paragraphs | Read for any per-process claim about the delivery daemon. Named here so review can confirm. |

Docs updated in the same change: `docs/cli.md` (the `deliver` synopsis and the server-daemons entry
for `--spaces`), `docs/delivery-daemon.md` (where it runs, and the pidfile paragraph, which says the
daemon records itself whichever way it was started), and a design note under `docs/design/`.

## 10. Decisions for review

1. **One `--server` and one root for every space in the manifest.** Same as #4819. A host whose
   spaces live on different brokers or roots runs one host process per broker or root.
2. **All-or-nothing startup, best-effort reconcile.** Same as #4819.
3. **No pidfile for a lane.** The alternative writes each space's pidfile naming the host, which lets
   `cotal down` on one space stop every space the host serves.
4. **A `[<space>] ` prefix on lane lines, none in single-space mode.** The alternative adds a `space=`
   field to each of the ~40 lines, which changes single-space output for no reader.
5. **The manifest grammar and reconcile loop move to `@cotal-ai/workspace`.** One grammar for both
   hosts, and the callout host is refactored onto it in this change. The alternative copies about 150
   lines into delivery.
6. **Lanes open one at a time at startup.** As in #4819. The PR reports how long sixteen take.
7. **The host never exits on lane loss**, including when every lane is lost to a broker outage; it
   keeps retrying and a supervisor sees the log. The single-space daemon exits on broker loss.
