# Per-space lifecycle on a shared broker

> **Design** (non-normative, not shipped) · Closes [roadmap](../roadmap.md) "Multi-space brokers"
> and [embedding](../embedding.md) known gap 3. Wire contract unchanged; this is operator tooling.

## 1. Where the gap is

The trust layer is already multi-space. `createBrokerAuth` mints the one operator plus system
account a broker trusts, `createSpaceAccountAuth(broker, space)` signs each tenant's data account
under it, `serverConfig(broker, spaces, opts)` renders them all into one file, and the two
authorities persist separately as `auth/broker.json` plus `auth/account.<key>.json`
(SPEC [§9](../../SPEC.md#9-nats--jetstream-security-and-authorization)).

What does not exist is the operator layer above it. Every lifecycle verb the CLI ships is
broker-wide: `down` stops the shared process, `clean store|all` deletes the shared JetStream store
and the broker trust record, `backup` snapshots the whole store, `up --restore` puts one back.
`assertSingleSpaceBroker` refuses each of them on a root with more than one tenant, because naming
a space cannot scope any of them, and it says so in its own message: "a per-space form does not
exist yet". This document specifies that form.

## 2. Verbs

A new `cotal space` group, deliberately separate from the broker-wide verbs rather than a
`--space` flag on them (see rejected alternative 2).

| Verb | Broker state | What it acts on |
|---|---|---|
| `cotal space add <name>` | running or stopped | one new data account, its streams, its `$SYS` creds |
| `cotal space rm <name>` | running | one tenant's streams, buckets, account record, local material |
| `cotal space backup <name>` | stopped, after a cut | one tenant's backed-up streams |
| `cotal space restore <name>` | stopped, after a cut | one tenant's backed-up streams |

Every one of them takes the root maintenance lock (§4) and reads the validated tenant inventory
(`accountInventory`) first. A `corrupt` entry refuses all four, for the reason
`assertSingleSpaceBroker` already refuses on one: an unreadable record may be a real tenant, so the
blast radius is unknown.

### 2.1 `cotal space add <name>`

1. Take the lock. Read the inventory. Refuse on any corrupt record.
2. Load broker trust. Refuse when `broker.json` is absent: a space is signed by an existing broker,
   never by a fresh operator it mints itself (`guardBrokerOverwrite` already refuses the write that
   would do that).
3. Refuse when the retained broker system signing seed is absent (§5).
4. Mint `createSpaceAccountAuth(broker, name)` and the space's `$SYS` creds in memory.
5. Commit: write `account.<key>.json` through `saveSpaceAccountAuth`, then the `$SYS` cred files.
6. Re-render and promote `server.conf` from broker trust plus the whole re-read inventory (§4).
   Reload the broker when one is running.
7. With a reachable broker, run `setupSpaceStreams`, `ensureDefaultDeliveryClass` and the channel
   registry seed under a fresh ephemeral `provisioner` cred, as `up` does today.

Steps 1 to 4 change nothing on disk, so a crash there leaves the root untouched. From step 5 the
account exists and, after step 6, the broker trusts it, while its streams may not exist yet. That
state is real and is made resumable rather than hidden: re-running `space add <name>` on an account
record that already composes under this broker skips steps 4 and 5 and completes 6 and 7. Booting
the space with `up` completes step 7 too, now that `up` renders from the full inventory (§4). The
verb is forward-idempotent and never destructive; it refuses only on a corrupt inventory, a missing
broker record, a missing system seed, or an account record for that name signed by a different
operator.

`space add` does not start a manager or a delivery daemon for the new space (§6).

### 2.2 `cotal space rm <name>`

1. Take the lock. Read the inventory. Refuse on any corrupt record.
2. Refuse when `<name>` is the only tenant. That case is the broker-wide teardown that already
   exists (`cotal down` then `cotal clean all`), and `serverConfig` refuses to render zero spaces,
   so a "remove the last one" path would have no config to promote.
3. Refuse while any recorded local process for that space is alive, reusing the pidfile and
   `liveMeshProcesses` checks `clean` performs. Per-space daemons are per-space today, so this
   check scopes to one tenant without touching a sibling's processes.
4. Journal the removal (`{ op: "space-rm", space, startedAt }`). While that entry is present, every
   verb on this root refuses except a re-run of `space rm <name>`.
5. Point of no return: delete the space's streams and buckets with `deleteSpace` under a
   lifecycle-scoped `teardown` cred, the sole holder of `STREAM.DELETE`.
6. Re-render and promote `server.conf` from the inventory minus this space, then reload (§4).
7. Delete the local material keyed to this space: `account.<key>.json` through a new
   `deleteSpaceAccountAuth` (§7, rejected alternative 7), the `space.<hex>` user-auth state dir,
   `manager-instance.<hex>.json`, and the space's `$SYS` creds once those are keyed per space (P7).
8. Clear the journal entry.

Steps 5 to 7 are individually idempotent, so a re-run after a crash finishes the removal instead of
starting a second one. The commit point is step 5: before it the tenant is intact, after it the data
is gone and only a backup can bring it back.

What step 6 does to that tenant's live connections is an eviction, not a revocation. Once the broker
loads a config without the account, its users are refused. Creds minted under it stay
cryptographically valid and would still be honored by a stale broker that never loaded the new
config, the same qualifier `up --rotate-sys` already prints for retired `$SYS` creds.

The per-agent secret files under `auth/creds` are not deleted, because that directory is
space-independent today (`agentCredsDir(root)` takes no space) and no file in it names its tenant, so
reaping one space's would risk a sibling's. They are broker-dead the moment the account leaves the
resolver, so what remains is disk residue. `space rm` lists the files it is leaving behind, and
re-keying that directory by `spaceSegment` is prerequisite P1 (§7).

### 2.3 Per-space artifacts

`cotal space backup <name>` and `cotal space restore <name>` keep the existing cut discipline.
`cotal down --preserve-state` writes the maintenance journal,
and the operation reads the preserved store through an isolated broker. The cut is broker-wide
because the JetStream store is shared, so a per-space backup is per-space in content, not in
availability. Taking a backup of one tenant still stops the broker for all of them (rejected
alternative 5).

Two changes to what exists:

- `validateSpaceBackupInventory(space, names)` today demands that the store's whole stream list
  equal one space's inventory, which is the single-space assumption in its sharpest form. It becomes
  a multi-tenant form: partition `names` across the inventories of the tenants in
  `accountInventory`, refuse any stream that belongs to no tenant, and require the named space's
  own streams to be present and complete.
- A per-space artifact pins the space's account public key alongside the existing chain
  commitment, so restoring into a root where that name now addresses a different account refuses.

A per-space artifact carries no trust material. Its streams are keyed by space name, not by account
public key, so restoring is data only and trust comes from `space add` under the current broker.
That keeps a restore from moving the broker root, which `SpaceAccountAuth` already states a
per-space restore must not do, and it makes a per-space artifact portable to a different broker,
which the full artifact is not.

`space restore <name>` refuses when the target space's streams already exist. Restore provisions
into an empty namespace; it does not merge into a live one.

## 3. Refusal rather than partial state

The rule every verb follows: work that cannot be undone happens at one identified commit point, and
everything before it is either free of side effects or idempotently repeatable.

- Nothing before the commit point writes. `space add` mints in memory first; `space rm` runs its
  live-process and tenant-count checks before it deletes anything.
- After the commit point the re-run of the same verb is the recovery. A verb that only adds state
  (`space add`) needs no journal, because its remaining steps are forward-idempotent and `up`
  completes them too. A verb that destroys state (`space rm`) journals what it is doing and refuses
  every other verb on the root until it finishes.
- One window is observable rather than closed. Between `space rm` steps 6 and 7 the account record
  is still on disk while the rendered config no longer names it, so `accountInventory` and anything
  reading it (`cotal status`, the guards) report a phantom tenant that the broker has already
  stopped trusting. The journal from step 4 is what makes that state legible, and the re-run clears
  it. A reader that must not see the phantom takes the lock.
- The journal blocks the root, not just the tenant. A wedged `space rm` refuses
  `down --preserve-state`, so a sibling's urgent backup waits for the re-run to finish. That is
  intended: a cut taken mid-removal would capture a store the config no longer describes.
- Uncertainty refuses. A corrupt account record, an unreadable inventory, an unconfirmed broker
  reload and a live process for the space being removed all stop the verb, in the fail-closed posture
  `assertSingleSpaceBroker` and `soleSpaceOf` already take.
- A refusal names the tenant and the blast radius, because the operator's next decision depends on
  which spaces an aborted verb could have touched.

## 4. Rewriting the broker config safely

`serverConfig` renders one static whole-broker map: the MEMORY resolver preloads every account, so
adding or removing one tenant rewrites the config for all of them. Its own note says concurrent
add and remove needs a broker-authoritative inventory with generation and compare-and-set, and
atomic promotion, above the renderer. That is this section.

**The inventory is on disk, not in a caller's hand.** Every render re-reads `accountInventory` under
the lock and renders from that plus `broker.json`. No verb passes a remembered list, so a render can
never drop a tenant that another verb added.

`up` used to violate that rule, which was prerequisite P0. It called `serverConfig(auth, [auth], …)`
with the one space it resolved from the cwd, so on a root with several tenants the next `up` would
render a config holding one account and orphan the rest, undoing any `space add` that came before it
— and nothing guarded it, because `assertSingleSpaceBroker` covers `up --restore` and not a plain
boot. It now renders `serverConfig(auth, preloadSpaceAccounts(dir, auth), …)`: that reader re-reads
the validated inventory and returns the booting space first with every sibling behind it, so `up`
renders from disk like every other writer while still booting the one space it was asked for.

It also refuses rather than narrowing the config, in both directions a tenant can go missing between
the two reads: an unreadable account record fails the render naming the tenant list uncertain, and a
record that disappears after the inventory validated it fails too. Both say the same thing — a tenant
left out of the config is evicted from the broker, so an uncertain list is not a list to render from.

**Serialization is the root maintenance lock.** `acquireMaintenanceLock` already gives an exclusive,
owner-recorded, stale-reaping lock per root, and `backup` and `clean` take it. The lock is per root
rather than per space on purpose: the config, the store and the broker process are shared, so two
tenants' lifecycle verbs are not independent. Every `up` now holds it across its render — the
ordinary path, `up -f`, and a resume re-entry alike, which is prerequisite P2 (§7). A re-entry used
to hold no lock at all and still reach the renderer, so a concurrent `up` could rewrite the
whole-broker config — every tenant's trust, unserialized — while a resume was mid-flight. The lock is
now mutual exclusion over every writer of `server.conf`, with no exception.

**A resumed `up` inherits that lock, and must hand it down.** The recovery journals `resume-intent`
under the lock it already holds, so releasing it for the re-entry to re-acquire would leave exactly
the window the lock is there to close: the journal in a resume state with the lock free. Inheriting
in turn makes handing the lock down mandatory rather than tidy. The lock is not reentrant, and it
cannot stale-reap its way out either, because the recorded owner is alive — it is the caller. A
helper that self-acquired would take the "held by a live owner" refusal and fail the resume outright.
So every helper that journals under it takes the lock as a `heldLock` parameter and the re-entry
passes it, on the restore and the ordinary side alike; the one caller that does not is the
prepare-failure path, where the lock has genuinely not been taken in that frame and the helper is
meant to take its own. Audit that by the callee, not by the call site: a site that passes no lock
says nothing about whether the callee acquires one, and threading only the sites that visibly named
a lock left `up --restore` dead in its listener bind, on the self-acquiring restore-side writers.

**Promotion is compare-and-set, because the lock is advisory.** A small non-secret
`broker-config.json` beside `server.conf` records `{ gen, inventoryDigest }`. A verb reads
generation G, renders, writes `server.conf.next`, re-reads the record, and promotes with a rename
only when it still reads G; then it writes G+1 with the new digest. A mismatch refuses and names the
other operation. The rename is atomic, so a reader sees one whole config or the other; the
generation check turns a lost or bypassed lock into a loud refusal instead of a silent overwrite.
The digest is a fingerprint of the tenant set, so any reader of the auth directory can test a guess
at which spaces a root holds. That directory already holds one `account.<key>.json` per tenant with
the name recoverable from the key, so the record adds no exposure a reader did not have.

**Broker trust is untouched by tenant verbs.** `space add` and `space rm` never write `broker.json`.
Broker trust keeps its own compare-and-set, the operator-identity check plus the `gen` successor
rule in `guardBrokerOverwrite`, and rotating it stays broker-wide per SPEC §9.

**Reload is verified, and rolled back when it is not.** The verb sends `SIGHUP` to the recorded
broker pid and then reads the server log tail for `Reloaded server configuration`, treating
`Failed to reload server configuration` and an absent confirmation alike, which is the pattern
`isolated-broker.ts` already uses for its maintenance-login reload. The previous rendering is kept
until the confirmation arrives; an unconfirmed reload restores it, decrements nothing (the
generation record is written only after confirmation), and refuses. When no broker is running there
is nothing to reload and the next `up` loads the promoted config.

**Reload evidence.** The one assumption the whole design rested on was whether `nats-server` picks
up an added and a removed MEMORY-resolver account on `SIGHUP`, with JetStream enabled and live
clients on a sibling account. A live spike outside this tree proved both directions, 9 checks of 9,
probing the cross-space wall on the concrete subjects with positive controls in the same run. So
`space add` provisions hot, no broker restart is needed, and the directory resolver stays rejected.
Porting that spike into this tree as the smoke P6 names is later work, not a precondition.

## 5. System-account creds for a later-added space

`sys.signingSeed` is the capability to mint system-account users. It exists in memory only on a
fresh `createBrokerAuth`, and `saveBrokerAuth` strips it before writing, so on the filesystem path a
space added after first boot cannot mint its `$SYS` users at all. `mintMembershipObserverCreds` and
`mintConnectionEvictorCreds` both throw when it is absent, and they are right to.

The two creds are not equivalent. The membership observer pins the data account id in its CONNZ and
connect and disconnect subjects, so it is genuinely per-space and a new space needs its own. The
connection evictor is `$SYS.REQ.SERVER.*.KICK` with no account scoping, so it is broker-wide and one
per broker would do, though today one is minted per space at `up`. Both land on root-scoped paths,
alongside a root-scoped `membership.json` naming one account and a root-scoped `membership-rw.creds`
store key. One tenant's set is all a root can hold, and the way that bites is INHERITANCE, not an
overwrite. A second space's `up` cannot overwrite the first space's, because `up` refuses a `--space`
the root does not already hold — at the workspace-root identity check, before any trust write — so on
an established root the fresh-space branch that mints the bundle never runs at all. On a root that
already holds two tenants neither space is fresh either, so the only writer that runs is the
absent-only heal path, which writes what is missing and nothing else. The first tenant to boot
therefore wins the root-scoped bundle and the second silently runs on it: after the second tenant
boots, `membership.json` still names the FIRST tenant's data account. Keying those paths per space is
prerequisite P7, and `space rm` step 7 can only reap them once it lands.

Without the seed a later-added space has no observer, which degrades membership to traffic-only and
makes live eviction refuse. `space add` refuses rather than provisioning a second-class tenant.

The design: a root is opted into multi-space at broker creation, and only then is the seed retained,
as its own broker-scoped `SecretStore` key, never inside `broker.json` and never inside any
per-space projection. `stripSpaceAuth` does not carry it, no manager receives it, and a single-space
install keeps today's property of holding no broker-admin minting capability at rest (rejected
alternative 4).

For a broker root created before that opt-in the seed is gone, and only a system-account rotation
produces a fresh one. `space add` refuses with that recovery named: stop the broker, run
`up --rotate-sys`, which re-mints every tenant's `$SYS` creds under the successor generation and
retains the seed going forward. That path is offline and broker-wide by construction, and it
invalidates full backups taken against the retired chain, which `up --rotate-sys` already says.

That recovery only reaches a root that still holds one space. `rotateSystemCreds` is itself
`assertSingleSpaceBroker`-guarded, and correctly so today: the rotation retires the system account
every tenant shares, while the single `$SYS` cred pair it re-mints pins one data account, so on a
multi-tenant root it would leave every sibling unobservable. A root that has already grown past one
space therefore hits a refusal where §5 promises a repair. Growing a broker-wide rotation form, one
that re-mints each tenant's pair under the successor generation and drops the guard, is prerequisite
P8. Until it lands, retaining the seed is a decision taken at broker creation with no later repair.

## 6. Out of scope

- **Daemon multiplexing.** One manager and one delivery daemon per space stays. `space add` does not
  start them, `space rm` requires them stopped, and nothing here makes a daemon serve two spaces.
- **Federation.** Connecting spaces keeps its own staged path in the [roadmap](../roadmap.md), and
  the rule that trust roots never merge is untouched.
- **Agents present in many spaces at once.** An endpoint is bound to one space for its lifetime.
- **Per-space listener or transport settings.** TLS and the ports are listener-wide, which
  `serverConfig` states; no space enables, disables, or rotates them on its own.
- **Per-space broker trust rotation.** Broker-wide by SPEC §9.
- **A per-space form of `clean store`.** The store is shared; `space rm` deletes a tenant's streams
  through the broker, which is the scoped operation that exists.

## 7. Prerequisites

- **P0.** Make `up` render `server.conf` from the validated inventory instead of the single space it
  booted (§4). Landed: `up` renders through `preloadSpaceAccounts`, which re-reads the inventory and
  refuses the render whenever the tenant list is uncertain.
- **P1.** Re-key `auth/creds` by `spaceSegment` so per-agent secrets name their tenant and
  `space rm` can reap them (§2.2). Still open: the split auth records (callout, issuer, owner-secret,
  service-keys) are keyed `auth/<spaceSegment>/…`, but `agentCredsDir(root)` still takes no space, so
  §2.2's residue and the unreapable per-agent secrets stand.
- **P2.** Make a resumed `up` take the root maintenance lock before it renders, which the ordinary
  and manifest paths already do, so the lock covers every writer of `server.conf` (§4). Landed: the
  re-entry inherits the recovery's lock rather than taking its own, and hands it to every helper that
  journals under it.
- **P3.** A multi-tenant backup inventory validator (§2.3).
- **P4.** `deleteSpaceAccountAuth(store, space)`, deleting one tenant's account key and nothing else.
- **P5.** Retained broker system signing seed behind the multi-space opt-in (§5).
- **P6.** Port the §4 reload spike into this tree as a smoke. No longer gating, since the behavior
  is already proven live.
- **P7.** Key the `$SYS` cred pair, `membership.json` and `membership-rw.creds` per space, so a
  tenant stops silently running on whichever sibling booted first and `space rm` can reap them (§5).
- **P8.** A broker-wide system-account rotation that re-mints every tenant's `$SYS` pair, so §5's
  named recovery works on the multi-tenant root it is prescribed for (§5).

## 8. Rejected alternatives

1. **One broker per space.** Multiplies processes, ports and stores, and discards the shared
   JetStream store. SPEC §9 already allows one operator to host several accounts, so the trust layer
   would be paying for a capability nothing used.
2. **A `--space` flag on the broker-wide verbs.** `down` stops the shared process and `clean store`
   deletes the shared store, so the flag would name a scope it cannot deliver. This is the reason
   `assertSingleSpaceBroker` refuses instead of offering one.
3. **A directory or URL resolver instead of MEMORY.** It would make adding an account a file drop
   with no whole-broker rewrite, but it adds a second location for trust material and, for the URL
   form, a resolver service to run and secure. Under the lock and the generation check, the rewrite
   is affordable. The §4 evidence removed the case that would have forced it, so it is rejected
   rather than held in reserve.
4. **Persisting `sys.signingSeed` unconditionally.** It would give every single-space install
   broker-admin minting capability at rest for a capability it never uses. Opt-in at broker creation
   keeps the default install where it is.
5. **A live per-space backup.** The artifact's consistency comes from the cut, and the maintenance
   journal has no per-space state to cut against. Snapshotting one tenant's streams while the broker
   serves the others would produce an artifact with no defined consistency point.
6. **Removing a tenant by revoking its users and leaving the account preloaded.** Revocation needs
   the account's own revocation list, does not free the stream and bucket namespace, and leaves a
   removed tenant visible in the rendered config.
7. **Reusing `deleteSpaceAuth` for teardown.** It deletes the broker auth key as well as the space
   account, which would orphan every sibling tenant. Per-space teardown needs a helper that touches
   one account record.
