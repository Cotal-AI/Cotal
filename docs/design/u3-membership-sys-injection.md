# Membership / `$SYS` credential injection

> **Design** (non-normative, not shipped) · Closes [embedding](../embedding.md) known gap 1
> ("Delivery immediate live eviction and a fully-hosted membership feed"). Wire contract unchanged:
> no new subject, no new stream, no new message type. This is a composition-root seam.

## 1. What the gap actually is

`docs/embedding.md:262-271` names it: the renewable `membership-rw.creds` migrated to the
`SecretStore` seam, but three artifacts still resolve from **fixed disk paths under the workspace
root**, so a hosted composition cannot supply them and live eviction refuses.

| artifact | kind | who signs it | why it is stuck on disk today |
|---|---|---|---|
| `membership-observer.creds` | `$SYS` CONNZ reader | system-account seed | `rotation-renewed`; no store key exists |
| `connection-evictor.creds` | `$SYS` KICK-only | system-account seed | same |
| `membership.json` | `{accountId}`, non-secret | nobody (public key) | explicitly excluded from `SecretStore` scope |

Every read site, measured:

- `implementations/delivery/src/membership.ts:35-36` builds `obsPath`/`cfgPath` from
  `join(findCotalRoot(), ".cotal")`; `:42-43` gate on `existsSync`; `:70` parses the account id;
  `:82` reads the observer; `:90-95` reads the evictor for the torn-rotation check.
- `implementations/delivery/src/evict-exec.ts:54-58` (`resolveScan`) reads `membership.json`;
  `:86-95` reads both `$SYS` creds for eviction; `:117-124` and `:155-163` read the observer for the
  two liveness verbs.

The write sites are `implementations/cli/src/commands/up.ts:2835-2838` (fresh provision),
`:2811-2814` (`healMembershipDataCreds`), and `packages/workspace/src/system-rotation.ts:108-109`
(rotation re-mint).

### 1.1 What is *not* the gap

**Core is already store-agnostic on this path.** Every eviction and liveness primitive takes
credentials as **strings**, not paths:

- `evictDeniedPrincipalWithCreds` — `packages/core/src/evict.ts:694-723`
- `observePlaneLivenessWithCreds` — `packages/core/src/evict.ts:566-584`
- `observePrincipalLivenessWithCreds` — `packages/core/src/evict.ts:669-687`
- `startMembershipFeed` already takes `observerCreds` as a string (`membership.ts:119`)

So U3 changes **no protocol and no core primitive**. It is an edge-composition change confined to
`implementations/delivery/src/` plus two new key constants in `@cotal-ai/workspace`. That is the
whole reason this node is small enough to be worth doing before P2 needs it.

### 1.2 The standing objection, and why it does not bind here

`packages/workspace/src/system-rotation.ts:36-39` and `:88-95` argue the `$SYS` pair is FS-only:
*"the $SYS pair is FS-only anyway (a hosted composition has nowhere in the store to put it), so this
operation was never store-composable to begin with."* `:42-46` repeats it: *"not something a store
can hold half of."*

That argument is **sound about the writer and wrong about the reader**, and the distinction is the
design.

- The **writer** (`rotateSystemCreds`) must rewrite `server.conf` and the broker trust record in the
  same act, and its multi-tenant guard (`assertSingleSpaceBroker`, `:96`) reads FS account records.
  `SecretStore` cannot enumerate, so an injected store would sail past that guard. Correct. **U3
  does not touch `rotateSystemCreds`.**
- The **reader** (the delivery daemon) needs exactly two values by name and one account id. It never
  enumerates, never writes, never touches `server.conf`. The enumeration argument simply does not
  reach it.

Gap 1 is a *reader* gap. It is closable without weakening the writer's guard by one line.

## 2. What is injected

Two **new** keys in `packages/workspace/src/renewal.ts`, beside `DELIVERY_CREDS_KEY` (`:30`) and
`MEMBERSHIP_RW_CREDS_KEY` (`:35`):

```ts
export const MEMBERSHIP_OBSERVER_CREDS_KEY = "membership-observer.creds";
export const CONNECTION_EVICTOR_CREDS_KEY  = "connection-evictor.creds";
```

> **These constants do not exist in the tree today — this design introduces them.** What exists is
> `SYSTEM_CREDS_FILES` (`system-rotation.ts:47`), a **positional** `as const` array of the same two
> filenames, consumed by index: `SYSTEM_CREDS_FILES[0]` is the observer and `[1]` the evictor at
> `up.ts:2835,2837`, `system-rotation.ts:126-127`, `clean.ts:276`, `manager.ts:1273` and four CLI
> smokes. Those are raw root-scoped **FS paths**, not `SecretStore` keys: today's tree has no store
> binding for this pair at all. Both readings are correct at different times — the positional array
> is the writer's current spelling, and these named constants are the reader-side store binding this
> design adds. A reader should not mistake them for existing code, and a second lane should not
> re-spell either one.
>
> The two spellings coexist deliberately: the named keys supersede the positional array **on the read
> path only**, and §3 leaves the array in place for the writer sites this design does not touch.
> Index-based access is exactly what makes a positional array unsafe to share across lanes — `[0]`
> and `[1]` carry no meaning at the call site — which is the second reason the reader gets names.

The key **is** the filename, the same key↔filename convention `SYSTEM_CREDS_FILES` already fixes
(`system-rotation.ts:47`). This is load-bearing, not cosmetic: `workspaceSecretStore(root)` is
`new FsSecretStore(join(root, ".cotal"))` (`packages/workspace/src/secret-store-fs.ts:9-11`) and
resolves a key to `<root>/.cotal/<key>`. So key `"membership-observer.creds"` resolves to exactly
`.cotal/membership-observer.creds` — **the same byte on the same path the daemon reads today**
(`membership.ts:35`). Switching the reader from `readFileSync` to `store.get()` is a local no-op by
construction, which is the same property that made the `membership-rw` migration safe.

These two are legitimate `SecretStore` material under core's own scope rule
(`packages/core/src/secret-store.ts:11-16`), which admits *"any daemon standing credential the
hosted composition persists … rotation-renewed observer / evictor creds are read at start or per
use."* The scope doc already anticipated them; only the keys were missing.

### 2.1 `membership.json` is not injected — it is eliminated

`secret-store.ts:18` explicitly lists `membership.json` as **not** `SecretStore` material. That
exclusion is right (it is a public key, not a secret) and U3 respects it rather than arguing with
it. The account id is instead **recovered from credentials the daemon already holds**, by two
independent routes:

1. **The daemon's own delivery cred.** `delivery.ts:170` already computes
   `expectedAccount: accountFromCreds(creds.initial)`. That cred is store-injected today under
   `DELIVERY_CREDS_KEY`. The account id is therefore *already* available in a hosted composition,
   with no file.
2. **The observer cred's own permissions.** `membershipObserverPermissions(accountId)`
   (`packages/core/src/provision.ts:2320-2331`) pins the DATA account into the cred itself:
   `pub.allow = ["$SYS.REQ.ACCOUNT.<accountId>.CONNZ"]` plus the two account event subjects
   (`subjects.ts:866-879`). The observer literally cannot observe an account other than the one
   named in its own JWT — the broker enforces it.

So `resolveScan`'s disk read (`evict-exec.ts:54-58`) is not a source of truth; it is a **second
copy** used to cross-check the first. Section 4 says what replaces the cross-check.

## 3. When it is injected, and by whom

Unchanged from today's ownership. U3 adds no new actor.

| moment | who | today | after U3 |
|---|---|---|---|
| fresh space provision | `provisionMembershipCreds`, `up.ts:2825-2842` | `writeSecretFile(cotalPath(SYSTEM_CREDS_FILES[i]), …)` | `store.put(<key>, …)` — same bytes, same path locally |
| system rotation | `rotateSystemCreds`, `system-rotation.ts:80-` | writes both files | `store.put` via the **workstation** store only; the FS-only guard at `:96` is untouched |
| daemon start / per eviction | `startMembership`, `executeEviction` | `readFileSync` | `store.get(<key>)` |

A hosted composition root (P2's provisioner) mints with `mintMembershipObserverCreds` /
`mintConnectionEvictorCreds` while the `$SYS` seed is in memory — exactly the window `up` uses
(`up.ts:2827,2833`; the seed requirement is enforced at `provision.ts:2340,2383`) — and `put`s both
under the two keys into its own store. Nothing about the mint window changes; U3 only changes where
the result lands.

**Read cadence.** The observer and evictor are read **per call** in the eviction path (core opens
and drains them per call by design — `evict.ts:692` "never a standing `$SYS` connection"), and once
at start in the feed path. Reading through `get()` per call is strictly better than today's
`readFileSync` per call: a hosted store that has been re-keyed by a rotation is picked up on the next
eviction with no daemon restart, whereas today an FS rewrite is picked up only because the path
happens to be re-read. No new renewal timer, and none is wanted: these stay `rotation-renewed`
(`system-rotation.ts:19-23`).

## 4. Failure semantics — refuse, never degrade

The two paths already have **deliberately different** postures and U3 preserves both exactly. This
is the part most at risk of being flattened by a refactor, so it is stated as a contract.

### 4.1 The feed path stays fail-soft

`startMembership` is fail-soft by written contract (`membership.ts:16-18`): a missing cred logs and
returns `{ down }`, the graph degrades to traffic-only, **Plane-3 delivery is untouched**. That is
correct and must not become a refusal — the feed is an enrichment, and failing delivery because a
graph feed cannot start would be a strictly worse trade.

What must survive verbatim is the **diagnosis**, not just the failure. `membership.ts:45-68` chooses
between two different repairs depending on which half is missing, because naming the wrong one costs
an operator a full mesh stop for nothing (`:46-51`), and `down` is carried to the adoption reply so a
stale `$SYS` cred does not surface merely as "the feed is not running" (`:26-29`, the #338 failure;
consumed at `delivery.ts:206-209,221-225`).

Under injection the repair strings must become **store-aware**: `cotal down && cotal up
--rotate-sys` is the right advice on a workstation store and is *unactionable* against a hosted KMS.
The rule: when the store is injected, the message names the **missing key** and the **mint window**
("re-mint the `$SYS` pair at a system-account rotation and `put` it under `<key>`"), never a CLI
incantation the host cannot run. Emitting workstation advice into a hosted log is a degradation of
the diagnosis even when the failure semantics are right.

**The detection mechanism, stated (F2).** "Is the store injected?" is answered by the *parameter*,
not by probing the store, and specifically not by sniffing the filesystem:

```ts
const injected = store !== undefined;                  // the runner's own seam
const secrets  = store ?? workspaceSecretStore(root);  // the existing line, unchanged
```

`startMembership(opts, store?)` and `runDelivery(args, store?)` already take the store as an optional
argument whose *absence* is precisely "workstation": the existing `store ?? workspaceSecretStore(root)`
(`membership.ts:37`) is that same fact, read one line later. So the flag is free and exact — it is a
property of the composition root, decided before any I/O.

Three alternatives are rejected because each infers hosting from evidence that does not carry it:

- `instanceof FsSecretStore` — a host may legitimately wrap or subclass the FS store (a caching or
  auditing decorator), and delivery must not depend on the concrete class of an injected seam.
- `existsSync(join(root, ".cotal"))` — the directory exists on a hosted box too (the mesh registry
  and auth state live there per `embedding.md`), so this reports "workstation" for a hosted daemon
  and emits exactly the unactionable advice the rule forbids.
- probing `store.get()` for a workstation-only key — an I/O round trip against a KMS to decide the
  *wording of an error message*, on a path already degraded.

The rule applies to the **repair clause only**. The diagnosis half — which key is missing, and the
observer/evictor vs data-account split of §4.1 — is identical in both compositions and must not fork:
one message builder, two repair tails. `down` still carries the whole string to the adoption reply
(`delivery.ts:206-209`), so a hosted adoption reply is store-aware for free.

### 4.2 The eviction and liveness path stays fail-loud

`executeEviction` (`evict-exec.ts:88-91`), `executePlaneLiveness` (`:118-121`) and
`executePrincipalLiveness` (`:156-159`) **throw** when the `$SYS` creds are absent, and every caller
treats a refusal as **UNKNOWN, never `gone`** (`evict.ts:107-108`, `:140-141`, `:598-600`). A missing
key is a refusal, full stop. There is no "evict best-effort", and specifically:

- a missing evictor key must **not** silently fall back to deny-new-only inside the executor. The
  deny-new-only posture is the *caller's* documented degradation (`evict-exec.ts:72-73`), reached by
  handling the refusal — not something the executor may choose on its own.
- a `get()` that throws (a KMS timeout, a revoked role) is a refusal, not an absence. Absence is
  `undefined` per the `SecretStore` contract (`secret-store.ts:31-32`); anything else propagates.

### 4.3 The tenancy check must not be lost — it gets stronger

This is the one real safety question U3 raises, and it deserves the space.

`evict-exec.ts:19-39` documents why `resolveScan` cross-checks at all: **a complete, well-formed
sweep of the WRONG account is indistinguishable from "the principal is gone"** — a healthy-looking
answer that authorizes eviction. Two guards exist: the root is pinned at daemon start, and the
on-disk account is cross-checked against the account the daemon's own cred authenticates as
(`:59-63`). The asymmetry at `:35-38` is the reason: observer-A with accountId-B under-reports
safely, but observer-A with accountId-A while the gate lives on B answers a **confident, wrong
`gone`**.

Naively deleting the disk read would delete guard two. It must be replaced, not dropped. Two
observations make the replacement strictly stronger than what it replaces:

1. **The disk file was never an independent source.** It sits in the same `.cotal/` dir as the
   creds. A root that is wrong is wrong for both. Its independence came from `expectedAccount` being
   derived from the *cred* (`:32-33`) — i.e. the cred was always the real authority, and the file was
   the thing being checked.
2. **The observer cred names its own account.** Per §2.1(2), the observer's `pub.allow` is
   `$SYS.REQ.ACCOUNT.<accountId>.CONNZ`. So the observer can be checked against `expectedAccount`
   **intrinsically**, with no adjacent file at all.

Proposed replacement, both paths:

```
accountId := expectedAccount                              // from the daemon's own delivery cred
assert connzAccountOf(observer) == accountId              // local, pre-connect, names both sides
```

The composition root performs this read and check during delivery startup, before constructing the
endpoint or acquiring `lease.0`. Deferring it until the first admin request lets a hosted store hand
tenant A's daemon tenant B's observer, claim A's singleton lease, and only then refuse every scan.
Startup also reads the optional evictor so a present but torn observer/evictor generation is refused;
an absent evictor keeps the documented pre-eviction, deny-new-only posture.

**Two mechanisms, not one (F4).** The earlier phrasing called this single assert "intrinsic,
broker-enforced", which conflates two independent things and oversells the assert. Stated correctly:

1. **The daemon's local check** — decoding the observer's own JWT and reading the account out of its
   `pub.allow` CONNZ subject. This is a *local* read of a signed document. It runs **before any
   connection**, and its whole value is the **diagnosis**: it refuses naming both accounts, at the
   daemon, in one line.
2. **The broker's enforcement** — the observer physically cannot publish `$SYS.REQ.ACCOUNT.<other>.CONNZ`,
   because the permission is in the JWT the broker validates. This needs no cooperation from the
   daemon and holds even if check 1 were deleted.

The safety property rests on **2**; **1** exists so the failure is legible instead of arriving as a
bare "Authorization Violation" (the same argument §4.1 makes for the expiry pre-check). Saying the
assert *is* broker-enforced would credit the daemon's own code with a guarantee the broker supplies —
precisely the confusion that lets a later refactor delete the broker-side reasoning as redundant.
"Intrinsic" survives and is the accurate word: no adjacent file is consulted.

Measured, not asserted: a freshly minted observer carries
`nats.pub.allow = ["$SYS.REQ.ACCOUNT.<DATA account pub>.CONNZ"]`, and that id is byte-equal to the
`nats.issuer_account` that `accountFromCreds` returns from the daemon's own delivery cred — so the
two sides of the assert are the same kind of id, which is the thing that actually had to be true.
Note `credsClaims` (`identity.ts:122`) *returns* the full payload at runtime but **declares** only
`{sub,iat,exp,name,iss}`; the accessor is a typing gap to close, not a decoder to write.

This catches everything the file check caught (a store handing back a foreign tenant's observer) and
one thing it did not: an observer whose *permissions* disagree with the `membership.json` sitting
next to it. On the workstation path the disk cross-check at `:54-58` is **kept as well** — there the
root genuinely can drift (`:24-27` enumerates the cases), so it is a real second source and costs
nothing.

The evictor cannot be checked this way, and the design says so rather than pretending: its
permission is `$SYS.REQ.SERVER.*.KICK` with no account in it (`provision.ts:2370-2377`), and
`:2365-2369` states the honest blast radius — a leaked evictor can KICK any connection on the
broker. Its containment is that **every cid it is given comes from the observer's own account-scoped
scan** (`evict.ts:251,272`), so pinning the observer pins the targets. On a shared broker that
containment is exactly what carries the tenant boundary, which is why the observer check is not
optional.

One free win: the **torn-rotation check** (two `$SYS` creds signed by different system accounts —
`membership.ts:90-101`) exists today only in the feed path, so the eviction path can currently open a
half-rotated pair and get a bare "Authorization Violation". Once both creds come from one store, that
check belongs in one shared helper used by both paths.

## 5. Native mechanisms first

U3 introduces **no new NATS or JetStream mechanism**, and that is a deliberate result rather than an
absence of ambition. Eviction already rides `$SYS.REQ.SERVER.<id>.KICK` and observation already rides
the account-scoped `$SYS.REQ.ACCOUNT.<id>.CONNZ` (`subjects.ts:862-890`), both nats-server's own
verbs, with account scoping doing the tenant isolation (`subjects.ts:873` pins the account id
precisely so that two spaces on one broker cannot see each other's events). The gap was never in the
broker; it was in how a host hands two files to a Node process.

**Rejected: distribute the `$SYS` creds through a JetStream KV bucket.** Superficially "more
native", and wrong. The daemon would need a broker connection to fetch the credentials it needs to
open a broker connection — a bootstrap circularity — and it would put `$SYS`-signed material inside
a data account, inverting the trust direction the whole account boundary exists to enforce (DR1). A
credential's distribution channel must sit below the thing it authenticates.

**Rejected: a `--observer-creds` / `--evictor-creds` path flag.** It moves the fixed path rather
than removing it, still requires the host to materialize secrets on a filesystem, and adds two
local-source flags that `resolveCredsStore` (`delivery.ts:142`) deliberately rejects under an
injected store.

**Rejected: widen `rotateSystemCreds` to take a `SecretStore`.** Argued down in
`system-rotation.ts:88-95` and the argument holds: no enumeration means no multi-tenant guard. If
store enumeration ever exists this reopens; until then the rotation writer stays a workstation
operation and says so.

## 6. Live test plan

The gate is: **live eviction proven per space from a store-injected composition.** A claim is not a
gate; the test is a real broker and a real `runDelivery`.

Model: `packages/core/smoke/evict-live-auth.smoke.ts`, which already proves eviction end-to-end
against a real user-auth broker with a real auth callout, and which is the smoke that disproved the
design's original tag-attribution premise (its header, `:18-23`). U3's smoke is that shape at
**two tenants on one broker**, the F4 topology.

New: `implementations/delivery/smoke/sys-injection-evict.smoke.ts`. Boot one `nats-server` with
`serverConfig(broker, [A, B], …)`. Provision both spaces. Put every credential — delivery, rw,
observer, evictor — into an **in-memory `SecretStore`** per space. Write **no `.cotal/` `$SYS` files
at all**, so a regression to `readFileSync` cannot pass by accident. Boot delivery for A via
`runDelivery(args, storeA)`.

| # | cell | expected |
|---|---|---|
| 1 | evict a live callout-minted principal in A | `verifiedGone:true`, `scanComplete:true` |
| 2 | B's live principal during and after cell 1 | still connected — untouched |
| 3 | hand A's daemon **B's** observer | refuses loudly naming both accounts; **never** a confident `gone` |
| 4 | `delete` the evictor key, then evict | throws; the caller reads UNKNOWN; A's principal still live |
| 5 | `delete` the observer key, then start the feed | `{down}` naming the key; **Plane-3 delivery still serves** |
| 6 | evict a principal that is not connected | idempotent success no-op (`kicked:0, verifiedGone:true`) |
| 7 | observer + evictor from different system accounts | torn-rotation refusal, both paths |
| 8 | no `.cotal/membership.json` anywhere | cells 1-2 still pass (proves the file is gone, not defaulted) |

Cell 3 is the load-bearing one — it is the wrong-account confident-`gone` failure `evict-exec.ts:35-38`
names, reproduced against the *store* rather than the filesystem. Cell 2 is the F4 cross-reach
property re-proven under injection. Cell 8 is the anti-regression for §2.1.

**Positive controls, per F4's discipline.** Cells 3, 4, 5 and 7 all assert a refusal, and a refusal
is exactly what a broken test also produces. Each carries an in-cell positive control: the same
operation with the *correct* material must succeed in the same process, so "refused" is distinguished
from "never worked". A cell that cannot state its positive control does not ship.

**The smoke's cwd is `mkdtemp`-pinned (F1).** Every cell's meaning depends on it. `findCotalRoot()`
walks *upward* from `process.cwd()`, and `resolveScan` (`evict-exec.ts:48-53`) compares that live
walk against the root pinned at daemon start. A smoke run from inside this repo resolves the
**repository's own** `.cotal/`, which is the one directory guaranteed to contain exactly the
`$SYS` files and `membership.json` the gate exists to prove absent. Cells 5 and 8 would then pass
against the developer's workstation state rather than the injected store — the precise
false-pass this gate is built to exclude, and one that gets *more* likely as the design succeeds,
since a correct implementation is silent about where the bytes came from.

So: each tenant gets its own `mkdtemp()` root, `process.chdir()` into it before `runDelivery`, and
the smoke **asserts** `findCotalRoot() === thatRoot` before cell 1 — a one-line precondition that
fails loudly rather than letting the walk escape. Roots are removed on exit, including on failure.
That precondition is itself a positive control: it proves the harness can tell the two roots apart,
so a later "no `.cotal` files" assertion means the store served the bytes and not that the test
looked in an empty directory.

Local regression: `pnpm smoke:auth` and the existing delivery smokes must pass unchanged, since §2
claims the workstation path is byte-for-byte identical. That claim is the migration's whole safety
argument, so it is tested, not asserted.

Environment note: this lane's box currently has `nats-server v2.12.12` (an earlier revision of this
doc recorded 2.11.4; the box moved). F4 measured against **2.14.5**, and 2.14.5 is what the gate
runs on — neither box version counts as the gate. The smoke pins and prints its server version, and
refuses rather than silently proving the property on whatever binary is first on `PATH`.

## 7. Boundaries with adjacent lanes

- **U1 (per-space lifecycle).** `docs/design/per-space-lifecycle.md` §2.1 step 5 commits
  `account.<key>.json` "then the `$SYS` cred files". That step is the write side of exactly these
  two artifacts. Boundary, **decided**: **U3 owns the two key names and the reader; U1 owns the
  lifecycle verb.** Neither owns both halves, and the seam between them is the two constants of §2.

  **Sequencing, decided (not "neither blocks the other").** U3 lands the store seam and the two
  named constants **first**; U1's **P7** (per-space keying) then builds *through* that seam and
  **imports these constants rather than re-spelling either filename**, and U1's **P8** follows P7.
  This replaces the earlier symmetric "if U1 lands first, U3 rewrites that one step" — that framing
  was written when the constants were assumed to exist. They do not (§2), so there is nothing for U1
  to build through until U3 lands, and a U1-first order would force U1 to invent the names U3 then
  has to reconcile. The ordering is a consequence of §2's "these are new", not a scheduling
  preference. U1's acceptance sentences for P7/P8 are held by `default_agent`; U3 does not need them
  to land its own half, which is the point of the split.

- **U2 (resolver-inventory-CAS).** **Not "no overlap" — a real adjacency, on the writer side.** An
  earlier revision of this section claimed no overlap; that is true at the *wire* level and too
  strong everywhere else, so it is withdrawn here rather than left standing.

  Two shared surfaces, measured: both lanes touch the **`extraAccounts` slot** of
  `serverConfig(…)` and the **same `up.ts` provisioning path** — U2 at the config render
  (`up.ts:2704`), U3 at the `$SYS` mint window (`up.ts:2825-2842`). And `--rotate-sys` is an
  **unfenced config writer**: `rotateSystemCreds` returns a successor bundle from which `server.conf`
  **must** be re-rendered (`up.ts:2634` and its comment), through that same `extraAccounts` render.
  Once both lanes land, that rewrite would invalidate U2's `configDigest` provenance — the
  unfenced-writer adjacency U2's review FILED. Coordination, matching U2's §6 residual 4:
  **`--rotate-sys` must eventually write through U2's fenced saga once it exists.**

  One attribution correction, so the residual is charged to the right lane: **U3 does not introduce
  or modify that config writer.** Re-rendering `server.conf` on rotation is today's behavior of
  `up --rotate-sys`, and §1.2 and §5 both keep `rotateSystemCreds` explicitly out of U3's scope —
  §3's rotation row changes only where the *cred bytes* land, never the config render. The adjacency
  is real and worth naming here; it is not a defect this design creates, and U3 landing first neither
  worsens nor repairs it.

  The torn-rotation check in §4.3 remains the same *class* of problem as U2's inventory CAS (a
  two-write commit observed half-applied) and reuses U2's vocabulary rather than inventing a second
  one: `docs/design/u2-resolver-cas.md` §8, *"Exported vocabulary — the torn-write failure modes"*,
  which names itself the stable citation target for other lanes. The term §4.3's torn rotation
  instantiates is **TORN WRITE / LOST UPDATE**.

  **Same class, not the same instance.** The citation borrows a name for the failure mode; it does
  not claim U2's mechanism closes U3's window, and nothing in §4.3 waits on U2. U2's instance is an
  inventory CAS; U3's is a `$SYS` two-cred write straddling a trust-record commit, and the two are
  fenced by different things — U2 by its CAS, U3 by the intrinsic `iss` comparison that proves
  staleness with no signer read. Reading the citation as coverage would be the one way this reference
  does harm, so it is ruled out here rather than left to the reader.

- **P2 (space-provisioner).** P2's gate already names "per-space membership/`$SYS` semantics on a
  shared broker" as an F4 residual (`CLOUD-PLAN.md:155-156`). U3 is the upstream half that makes
  P2's version composable. P2 should not carry a private fork of this reader.

  **Sequencing within one provision (F3).** P2 composes two mint windows that are ordered and not
  interchangeable: U2's **inventory-account mint** must commit its inventory record *before* U3's
  **`$SYS` mint window** runs, because the observer's permissions pin the DATA account id (§2.1(2))
  and therefore cannot be minted until that account is the committed one — an observer minted against
  an account the inventory later renames or loses to a CAS retry is broker-dead in exactly the
  §4.3 way, and is unrecoverable without a system-account rotation since the `$SYS` seed is gone by
  then (§8.1).

## 8. Residuals, named

1. **`rotateSystemCreds` stays workstation-only.** A hosted composition must mint the `$SYS` pair at
   its own provision (the `$SYS`-seed-in-memory window) and cannot use `cotal up --rotate-sys` to
   renew it. Renewal in a hosted composition is a re-provision of the system account by the host,
   using the same core mint primitives. Blocked on store enumeration; out of scope here.
2. **The evictor is not tenancy-checkable.** `$SYS.REQ.SERVER.*.KICK` carries no account
   (`provision.ts:2370-2377`). Containment is inherited from the observer's account-scoped scan
   (§4.3). A future account-scoped KICK in nats-server would close this; today it is a stated
   property, not a hidden one.
3. **`membership.json` remains on the workstation path** as the second source for the drift check
   (§4.3). It is not deleted from `up`; it stops being *required*. `cotal clean`'s removal list
   (`implementations/cli/src/commands/clean.ts:277`) is unchanged.
4. **Single-server proof unchanged.** `gone` still requires the SPEC 13.13 single-server proof
   (`evict.ts:519-531`); injection does not touch it, and a clustered hosted broker still reads
   `unknown`. Worth stating because a hosted deployment is *more* likely to be clustered than a
   workstation.
