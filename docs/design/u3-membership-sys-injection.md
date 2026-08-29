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

Two new keys in `packages/workspace/src/renewal.ts`, beside `DELIVERY_CREDS_KEY` (`:30`) and
`MEMBERSHIP_RW_CREDS_KEY` (`:35`):

```ts
export const MEMBERSHIP_OBSERVER_CREDS_KEY = "membership-observer.creds";
export const CONNECTION_EVICTOR_CREDS_KEY  = "connection-evictor.creds";
```

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
accountId := expectedAccount                        // from the daemon's own delivery cred
assert accountOf(observer.pub.allow CONNZ subject) == accountId   // intrinsic, broker-enforced
```

This catches everything the file check caught (a store handing back a foreign tenant's observer) and
one thing it did not: an observer whose *permissions* disagree with the `membership.json` sitting
next to it. On the workstation path the disk cross-check at `:55-58` is **kept as well** — there the
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

Local regression: `pnpm smoke:auth` and the existing delivery smokes must pass unchanged, since §2
claims the workstation path is byte-for-byte identical. That claim is the migration's whole safety
argument, so it is tested, not asserted.

Environment note: this lane's box has `nats-server v2.11.4`; F4 measured against 2.14.5. The smoke
pins and prints its server version, and the gate is run on the F4 version before the node is called
done.

## 7. Boundaries with adjacent lanes

- **U1 (per-space lifecycle).** `docs/design/per-space-lifecycle.md` §2.1 step 5 commits
  `account.<key>.json` "then the `$SYS` cred files". That step is the write side of exactly these
  two artifacts. Boundary: **U3 owns the keys and the reader; U1 owns the lifecycle verb.** If U3
  lands first, `space add` step 5 writes through `store.put(<key>, …)` and inherits hosting for
  free; if U1 lands first, U3 rewrites that one step. Neither blocks the other. Both must be told the
  key names once, so they cannot be spelled twice.
- **U2 (resolver-inventory-CAS).** No overlap. U2 is about concurrent *space adds* racing on the
  broker inventory; U3 never writes broker config, never enumerates, and adds no ordering
  requirement. The one adjacency worth a line: if U2 introduces a generation/CAS discipline over the
  inventory, the torn-rotation check in §4.3 is the same *class* of problem (a two-write commit
  observed half-applied) and should reuse U2's vocabulary rather than invent a second one.
- **P2 (space-provisioner).** P2's gate already names "per-space membership/`$SYS` semantics on a
  shared broker" as an F4 residual (`CLOUD-PLAN.md:155-156`). U3 is the upstream half that makes
  P2's version composable. P2 should not carry a private fork of this reader.

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
