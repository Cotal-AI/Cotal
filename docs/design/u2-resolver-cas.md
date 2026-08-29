# U2 — resolver-inventory CAS

**Status:** design, Phase 1. Nothing here is implemented. Review gate: this doc is approved
before any code lands.

**Revision 2** — folds the `rev_u2doc_glm` adversarial review (2 blockers, approve withheld) in
full. What moved:

| Change | Driver | Where |
|---|---|---|
| Durable proof record at step 7; resume branches on `appliedGeneration` vs `generation`; **rollback forbidden once proven** | BLOCKER 1 (crash between proof and commit reached a third state whose resume rule could downgrade a live broker) | §3.3, §3.4 (steps restructured), §4 |
| **Mandatory abort-before-rename lease re-check**; the rollback path is itself lease-fenced; commit verifies the running config digest | BLOCKER 2 (lease expiry before rename left a proven, credential-resurrecting config live for an observable window) | §3.4 (steps restructured), §6 residual 3 |
| **§7 — the reconcile verb.** Every refusal now has a printed, runnable exit | FILED-1 (cold-boot divergence had no operator path out) | §7 (new), §3.2, §4, §6 residual 1 |
| **§8 — exported torn-write vocabulary**, each term anchored to a real site | cross-lane citation target | §8 (new) |
| `extraAccounts` slot ownership, bucket names, `rotate-sys` fencing scope | §3.2 amendment + FILED-2 | §3.2, §6 residual 4 |
| Claim-to-render re-key digest gap; `generation` is not a mutation count | FILED-3, FILED-4 | §3.3, §5 |
| Citation hygiene (`endpoint.ts:2804`, `acls.ts` range, U1 smoke name, unresolvable `rehearse-multispace.mts` path) | FILED-5 | throughout |

§3.4's nine-step walk is **restructured**, not merely amended — see the callout there.

**Plan node (verbatim, `docs/CLOUD-PLAN.md` in the platform lane):**

> **U2 — resolver-inventory-CAS** · F4 · Broker-authoritative space inventory with
> generation/CAS + atomic promotion above `serverConfig` (upstream names this gap). v1
> serializes adds in the control plane, so this is post-GA hardening. · **Gate:** two
> concurrent space adds cannot lose one.

Depends on F4 (`spike-live-space-add`, DONE): live add/remove by re-render + `SIGHUP` with the
broker never restarting is proven, including the negative arm, at
`apps/backend/scripts/rehearse-multispace.mts:127-137` (live add) and `:199-201` (live remove)
**on the platform lane** — that path does not exist in this repo (there is no `apps/` directory
here), so a reader of the U2 lane alone cannot resolve it; read it in the platform-runbook tree.
U2 does not re-prove that. U2 makes the re-render *safe to race*.

**Citations.** Every `file:line` below was read at the commit named beside it: this lane at
`0aba73ba`, U1 at `6e634f1855dd`, `origin/main` at `ae9f6164`, and the platform lane for
`rehearse-multispace.mts` / `CLOUD-PLAN.md`. Where a citation crosses a lane it says so.

---

## 1. What exists today, measured

### 1.1 The renderer is pure, and says so

`serverConfig` (`packages/core/src/provision.ts:2465-2531`) takes `(broker, spaces[], opts)` and
returns config text. It emits a whole-broker `resolver: MEMORY` map:

```
resolver: MEMORY
resolver_preload: { <space accounts> , <sys> , <extraAccounts> }
```

— `provision.ts:2525-2529`. It refuses an ambiguous render (an account preloaded twice,
`provision.ts:2496-2498`) and asserts every space account is signed by *this* broker's operator
(`provision.ts:2493`). Those are the only guards it has, and they are the right ones for a pure
function.

The gap is named in the code already, at `provision.ts:2409-2411`:

> NOTE (W4): the MEMORY resolver is one static whole-broker map, so every mutation rewrites all of
> it. Concurrent add/remove of spaces needs a broker-authoritative inventory with generation/CAS
> and atomic promotion above this function; this renderer is deliberately pure.

**U2 is the "above this function" layer.** `serverConfig` itself does not change.

### 1.2 The inventory today is the filesystem

`accountInventory(dir)` (`packages/workspace/src/auth-paths.ts:851-891`) scans `account.*.json`,
validates each record round-trips, and returns `{ spaces, corrupt }`. `corrupt` is what makes the
broker-wide guards fail closed: an unreadable record is *uncertainty about how many tenants
exist* (`auth-paths.ts:848-850`). `listSpaceAccounts` is the thin wrapper (`auth-paths.ts:896-898`).

### 1.3 U1 already fixed the *read* side — build on it, do not redo it

On `lane/u1-per-space-lifecycle` @ `6e634f1855dd`, `preloadSpaceAccounts(dir, current)`
(`packages/workspace/src/auth-paths.ts:915`) is the render input: every tenant on the root, with
the caller's copy of the booting space first because it can be fresher than disk, refusing on a
corrupt record and refusing on a record that *disappeared between the two reads*. `up` calls it
at `implementations/cli/src/commands/up.ts:2717` (on `origin/main` that site is still
`serverConfig(auth, [auth], …)` at `up.ts:2704`).

U1 closed *silent under-count*: rendering from one space when the root holds several. It did not
close *concurrency*: `preloadSpaceAccounts` is a read-modify-write over a directory with no fence.
Its own "disappeared while rendering" refusal (`auth-paths.ts:927` on that commit) is exactly
the race becoming visible at the one point it happened to be detectable. U2 generalises that
posture to every window rather than the one U1 could see.

### 1.4 The write side has no fence at all

`putSpaceAuth` (`auth-paths.ts:1024`) guards *content* — foreign operator, stale system-account
generation, another tenant's account record (`auth-paths.ts:1055-1059`) — and every guard runs
before either put so a refusal never half-writes. It has no guard against *another writer* doing
the same thing concurrently, and nothing anywhere sequences "write the record" against "render the
config" against "reload the broker".

### 1.5 The broker-side reload is already fail-loud

`isolated-broker.ts:444-460`: write config → `SIGHUP` → read the log tail → refuse on
`Failed to reload server configuration`, and refuse *also* when `Reloaded server configuration`
is absent. A reload that cannot be proven is a failure, not a maybe. U2 reuses this shape.

---

## 2. The races

All three assume one broker process serving N spaces on one root, i.e. the F4 topology.

### R1 — two concurrent space adds (**the plan's gate**)

```
 W1: read inventory {alpha}          W2: read inventory {alpha}
 W1: write account.beta.json         W2: write account.gamma.json
 W1: render preload {alpha,beta}     W2: render preload {alpha,gamma}
 W1: write server.conf  ────────────────────────┐
                                     W2: write server.conf   (last writer wins the FILE)
 W1: SIGHUP                          W2: SIGHUP
```

Final `resolver_preload` = `{alpha, gamma}`. **Beta is lost.** Its account record exists on disk,
`accountInventory` reports it, `cotal status` lists it — and every cred minted under it is refused
by the broker with nothing printed anywhere. This is precisely the silent eviction U1's commit
message describes, reintroduced through a channel U1's fix cannot see, because each writer's
render was individually correct at the moment it read.

Note the two independent losses: the **file** loses (W2's bytes overwrite W1's) and the
**read** loses (W2's inventory read predates W1's record write). Fixing only the file write with
an atomic rename does *not* fix this — W2's content is stale regardless of how atomically it lands.

### R2 — add during boot

`authSetup` renders and writes `server.conf` (`up.ts:2704`, U1's `up.ts:2717`) and then continues:
mint an ephemeral provisioner cred, probe reachability, `setupSpaceStreams`, `seedChannelRegistry`
(`up.ts:2705-2709`). A concurrent add landing inside that window renders from an inventory that
does or does not contain the booting space depending on whether `putSpaceAuth` has returned yet —
and the booting process will later `SIGHUP` (or start) against a `server.conf` it did not write.
Either the adder's space or the booting space is dropped, decided by scheduler timing.

There is a second, worse arm: `up` is the path that *creates* the store. A crash or refusal
between "account record written" and "config promoted" leaves a tenant that exists on disk and
not in the broker — indistinguishable, to every later reader, from R1's loss.

### R3 — remove during render

`preloadSpaceAccounts` reads the inventory, then loads each sibling record individually
(`auth-paths.ts:921-929` @ `6e634f1`). A removal landing between those reads is caught *only*
because the sibling load returns nothing and the function refuses. Widen the window by one step —
removal lands after the sibling load and before the `SIGHUP` — and the render is a
**resurrection**: the removed space is preloaded back into a running broker, and its
supposedly-revoked creds connect again. Live removal was proven to work in F4
(`rehearse-multispace.mts:199-201`); nothing today prevents a concurrent add from undoing it.

**R3 is a security regression, not just a lost update.** It is the reason the failure semantics
below cannot be "retry silently until it sticks".

---

## 3. Proposed mechanism

### 3.1 Principle: native first

Every primitive below already exists in this codebase against real NATS/JetStream. U2 adds no new
consensus, no new lock file, no new daemon.

| Need | Existing native mechanism | Where it is already used |
|---|---|---|
| Compare-and-swap on a record | JetStream KV revision-pinned `update` | `endpoint-records.ts:591-598` (`updateRecordEntry`) |
| Create-only CAS (claim) | `kv.put(key, v, { previousSeq: 0 })` | `endpoint-records.ts:580-587` (`createRecordEntry`) |
| Classify a CAS loss | `err_code` 10071 / 10164, never message text | `endpoint-records.ts:557-560` (`isCasLoss`) |
| Single-flight across processes | per-key CAS create in a TTL bucket | `endpoint.ts:2806-2822`, `streams.ts:88-113` |
| Sequenced multi-step CAS state machine | the lifecycle saga's reserve → transition → reopen | `lifecycle-saga.ts:1-19, 45-59` |
| Durable authority-store shape | `allow_direct:false` + subject/storage assertion | `endpoint-binding.ts:498-530` |

The saga shape (`lifecycle-saga.ts:2-6`) is the direct model: *reserve, transition under a fence,
commit last, with crash-resume*. U2 is that machine over one more key.

### 3.2 Where the inventory lives

A JetStream KV bucket holding the broker's tenant list plus the generation counter.

It cannot live in a tenant's data account — a tenant would then hold the tenant list. It goes in an
**operator-owned, non-data account**, the slot `serverConfig` already has for exactly this class of
thing: `extraAccounts`, documented at `provision.ts:2472-2474` as "additional operator-signed
accounts to preload — e.g. the dedicated auth-callout account, which must never share the data
account". The inventory bucket is another authority store in that account, wearing the shape
`assertAuthorityStoreBinding` already enforces (`endpoint-binding.ts:520-530`): exactly one
`$KV.<bucket>.>` subject, `storage: file`, `allow_direct: false` — the last because every fence
here is a leader-served revision-pinned CAS and Direct Get's follower reads would defeat
read-your-writes (`endpoint-binding.ts:502-503`).

#### Keys and accounts — what U2 claims, precisely

Stated as an ownership claim so the U3 seam (§6 residual 4) can be checked against it rather than
inferred.

**U2 owns the `extraAccounts` slot usage** for one added entry: a single operator-signed
**broker-authority account**, sibling to the auth-callout account already documented at
`provision.ts:2472-2474`, never sharing a data account. U2 adds *one* account, not one per bucket.

Two buckets live in it:

| Bucket | Key(s) | Role | Shape |
|---|---|---|---|
| `cotal_broker_inventory` | `inventory` (exactly one) | the tenant list + generation record (§3.3) | authority store: one `$KV.<bucket>.>` subject, `storage: file`, `allow_direct: false` (`endpoint-binding.ts:520-530`) |
| `cotal_broker_cfgwriter` | one key per broker root | the writer lease (§3.4 step 0) | TTL bucket, `max_age` bounded like `MANAGER_LEASE_TTL_MS` (`streams.ts:89` = `10_000`), the `endpoint.ts:2806-2822` shape |

**Neither name carries a space token, and that is deliberate — it is the broker-scoped signal.**
Every existing bucket name in this codebase is `cotal_<thing>_${token(space)}`:
`managerBucket` (`subjects.ts:932`), `artifactBucket` (`subjects.ts:943`), `recordsBucket`
(`endpoint-records.ts:29`), and the rest. A reader who sees a space token knows the resource is
per-tenant; the *absence* of one here is the marker that these two are whole-broker resources that
no tenant may reach, and it is checkable by grep rather than by comment. A reviewer finding a space
token added to either name should read that as a scope regression, not a naming choice.

**Scope of the fence (FILED-2).** The lease fences the *inventory list*, not the *broker trust
record*. Step 4 invokes `putSpaceAuth` (`auth-paths.ts:1024-1066`), which also writes
`BROKER_AUTH_KEY`; its `guardBrokerOverwrite` (`auth-paths.ts:1032`) refuses a stale broker
generation, but two `--rotate-sys` runs racing each other still read-modify-write that record
outside any inventory CAS. `rotate-sys` therefore remains single-writer **by its own content
guard**, not by U2's lease, and U2 does not claim otherwise — while the saga is unimplemented.
§6 residual 4 records the decision that `rotate-sys` acquires the lease when the saga lands.
This is the same seam U3 works in (§6 residual 4): a `--rotate-sys`-driven config rewrite
invalidates a `configDigest` U2 proved, and U2's step-8 digest verification (§3.4) *detects* that
but does not prevent it.

**Bootstrap honesty.** The inventory describes the broker's config and lives *inside* the broker.
A cold `up` has no broker yet, so there are two regimes and the doc must not pretend otherwise:

- **Cold boot** (no broker reachable): disk is authoritative. Exactly one process is starting a
  broker on this root; the existing single-writer posture holds. The first thing the booted broker
  does is **seed** the inventory from `accountInventory` at generation 1 via a create-only CAS
  (`createRecordEntry`). A create that loses means another process booted first — refuse.
- **Live** (broker reachable): the KV generation is authoritative. Disk records remain the material
  (the JWTs live there); the KV row is the *list* and the *generation*. A live mutation that cannot
  reach the KV **refuses** — it does not fall back to disk. Falling back is R1 with extra steps.

Reconciliation between the two is **§7**, and it is a required part of this design, not a residual:
every refusal named above has a printed, runnable exit or it does not ship (§7's invariant).

### 3.3 The record

One key, `inventory`, holding the whole list — not one key per space. The thing being made atomic
is the *set*, because `resolver_preload` is a set; per-space keys would require a multi-key
transaction JetStream does not offer, and reconstructing a set from a scan reintroduces the
torn read (`kv-scan.ts:63-72` documents why a scan over a moving tail is not a snapshot).

```jsonc
{
  "generation": 7,          // last COMMITTED generation — the CAS subject
  "spaces": ["alpha", "beta"],
  "appliedGeneration": 7,   // the generation the RUNNING broker's config was PROVEN to carry
  "configDigest": "sha256:…",// digest of the server.conf bytes proven at appliedGeneration
  "pending": null           // or the in-flight claim, below
}
```

```jsonc
"pending": {
  "generation": 8,          // g+1
  "op": "add",              // add | remove | reconcile (§7)
  "space": "gamma",
  "writer": "…",            // writer identity, for the operator message
  "leaseId": "…",           // the lease value this writer holds — step 6 re-checks THIS
  "claimedAt": "…",
  "stagedDigest": "sha256:…"// set at step 5; digest of the server.conf.<g+1> bytes staged on disk
}
```

`generation` is the CAS subject. `appliedGeneration` is what makes R2 detectable:
`generation > appliedGeneration` means *a mutation was accepted and the broker has not been proven
to carry it*. **`appliedGeneration > generation` is the converse and is equally legal**: a mutation
was PROVEN on the running broker and not yet committed. Both are resumable, visible states rather
than silent divergence, and §3.4's resume rule branches on exactly this comparison.

**`appliedGeneration` may only ever be written by the step that read the proof line.** That is the
whole of BLOCKER 1's fix: the field's name is a claim about what was proven, so no step that did
not observe a proof may set it, and no step may leave it unset after a proof *was* observed.

**Two properties this record does NOT have, stated so nothing downstream assumes them:**

- **`configDigest` describes bytes, not the KV's vouching for them (FILED-3).** `spaces` stores
  *names*; the material — the JWTs — lives on disk and is read at render time
  (`preloadSpaceAccounts`, U1 `auth-paths.ts:915-929`). If a space is re-keyed (account rotated)
  between the step-3 claim and the step-5 render, the render legitimately uses the *new* JWT under
  the *old* claimed name, and `configDigest` then describes bytes whose material the inventory
  record never saw. This is not a set-semantics bug — the set is unchanged and correct — but it
  means the digest is a **promotion identity** (which bytes are live), never a **content
  attestation** (that those bytes hold the material the claim intended). Step 8's digest check
  (§3.4) uses it only in the first sense. Anything that later wants the second sense needs the
  material's own digest in the record, which U2 does not add.
- **`generation` is a monotonic counter, not a count of spaces or of successful mutations
  (FILED-4).** A refused mutation that was rolled back before proof consumes no generation; a
  mutation that was proven and then completed forward by a *different* writer consumes exactly one;
  a §7 reconcile consumes one while adding or removing several spaces at once. Any assertion of the
  form `generation == <number of adds>` is fragile. §5's gate cell is restated accordingly.

### 3.4 The mutation saga

> **RESTRUCTURED — read this even if you read the previous revision.** The step count is unchanged
> (0-8, plus lease release at 9) but the content of steps 5, 6, 7 and 8 has moved, in response to
> two blockers from the `rev_u2doc_glm` adversarial review:
>
> - **Digest staging moved *into* step 5** (was: computed at commit). The bytes are staged and their
>   digest is durably recorded *before* anything is promoted, so a crashed writer's successor can
>   tell promoted bytes from un-promoted ones without guessing.
> - **The lease re-check moved *into* step 6 as a mandatory ABORT gate** (was: a "should" in §6
>   residual 3). A writer that has lost its lease may not call `rename()` — in either direction.
> - **The durable proof record moved *into* step 7** (was: written by the step-8 commit). Step 7 now
>   writes `appliedGeneration = g+1` immediately after reading the proof line and *before* the
>   commit, which is what closes the third state.
> - **Step 8 verifies the running config's digest before committing** (was: it wrote the digest
>   unconditionally).
> - **Rollback is now forbidden past a point**, and the crash-resume rule branches on
>   `appliedGeneration` vs `generation` — never on "is `pending` consistent with disk", which was
>   the rule that could downgrade a live broker.

Writer lease first. The file-write + `SIGHUP` window is a genuine critical section (two writers
that both win separate CAS rounds could still interleave their `writeFileSync`+`SIGHUP`), and the
lease is the same per-key CAS create in a TTL bucket the manager lease already uses —
`endpoint.ts:2804` states the invariant plainly: *"the per-KEY CAS create stays the only
single-flight gate"* (the surrounding `managerLeaseRegistry` is `endpoint.ts:2806-2822`). TTL
bounded like `MANAGER_LEASE_TTL_MS` (`streams.ts:89` = `10_000`), so a crashed writer's lease
expires rather than wedging the broker forever.

**The lease is liveness, never safety** — that is why every step that touches `server.conf`
re-checks it and *aborts* rather than trusting it, and why the CAS fences below, not the lease, are
what make the outcome correct.

```
0. acquire writer lease         create-only CAS in the TTL bucket; loss ⇒ REFUSE (§4)
                                keep the value written as `leaseId` — steps 5-7 re-check THIS id
1. read inventory               get → { value, revision }
2. decide                       add: space already present ⇒ no-op success (idempotent)
                                remove: space absent ⇒ no-op success
                                pending non-null ⇒ RESUME (table below), never fresh work
3. claim                        CAS update at `revision`:
                                  pending = { generation: g+1, op, space, writer, leaseId }
                                loss ⇒ REFUSE (§4)
   ── from here the intent is DURABLE and RESUMABLE ──
4. materialise                  add: putSpaceAuth (auth-paths.ts:1024-1066) writes the record
                                remove: retire the record
5. render + STAGE               serverConfig(broker, preloadSpaceAccounts(dir, current), …)
                                unchanged renderer; input is the claimed list
                                write server.conf.<g+1> in the same dir, fsync — NOT yet live
                                CAS update: pending.stagedDigest = sha256(those bytes)
                                ── the digest is durable BEFORE any promotion ──
6. FENCE, then promote          re-read the lease key. REQUIRE it present, unexpired, value ==
                                our `leaseId`.  NOT HELD ⇒ **ABORT BEFORE RENAME** (§4):
                                  unlink the staged file, clear `pending` by CAS, REFUSE loud.
                                  Nothing was promoted, so this abort evicts nobody.
                                only then rename() server.conf.<g+1> over server.conf
                                (POSIX rename is atomic; the broker never observes a partial
                                config).  The fence is the instruction before the syscall.
7. reload, PROVE, RECORD        SIGHUP, then require "Reloaded server configuration" and refuse on
                                "Failed to reload server configuration"
                                — the isolated-broker.ts:444-460 proof, verbatim in shape (the
                                  two refusals are :458-459)
                                on PROOF: immediately CAS update:
                                  appliedGeneration = g+1
                                  configDigest      = pending.stagedDigest
                                (`generation` still g; `pending` still non-null)
   ── from here ROLLBACK IS FORBIDDEN. The only exit is forward. ──
   on proof FAILURE             the running broker did NOT take these bytes. Roll back — but the
                                rollback is itself fenced: re-check the lease exactly as step 6
                                does; if it is NOT held, rename NOTHING, leave `pending` in place
                                (it carries `stagedDigest`, so the next holder's resume rule can
                                read the situation) and REFUSE loud.  Holding the lease: rename the
                                previous generation's bytes back, SIGHUP, prove again, clear
                                `pending`, REFUSE loud.
8. commit                       re-read server.conf and require sha256(bytes) == configDigest —
                                the digest THIS writer proved at step 7. Mismatch ⇒ something
                                outside the saga promoted a config after our proof: do NOT commit,
                                leave `pending`, REFUSE loud (§4, and see the read-side scope
                                statement below).
                                then CAS update: generation = g+1, spaces = new set,
                                pending = null   (appliedGeneration/configDigest already written)
9. release lease
```

**Four CAS points now, not two:** step 3 (claim), step 5 (stage the digest), step 7 (record the
proof), step 8 (commit). Steps 5 and 7 are new, and each exists to make a crash window *readable*
rather than guessable.

Step 3 is what makes R1 impossible: W1 and W2 both read revision *r*; one CASes to *r+1* and the
other's CAS at *r* loses and refuses. Neither writer's render is ever built from a list the other
has already superseded, because a superseded list cannot get past step 3.

R2 is closed by the lease plus `appliedGeneration`: `up`'s render happens *inside* the lease, and a
concurrent add blocks at step 0 rather than racing the boot's config write.

**R3 — what the fence actually delivers (corrected).** The previous revision claimed *"a remove
that commits at generation g+1 makes any in-flight add's step-8 CAS at g lose, so the resurrecting
render is never promoted."* **That was false, and its own §6 residual 3 said so.** The step-8 CAS
loss arrives *after* the rename and the SIGHUP, so the resurrecting config was promoted, proven and
serving revoked credentials for the whole rollback-latency window. What closes it now is the step-6
fence, not the step-8 CAS: a paused writer whose lease expired **cannot reach `rename()` at all**,
in either direction, so the stale render is never promoted in the first place. The step-8 digest
check is the *second* line — it catches a promotion that happened outside the saga entirely.

**Read-side scope — stated honestly, because the mechanism does not cover it.** U2 fences
*cooperative writers*: every process that drives the saga. It cannot fence a SIGHUP. Any process on
the box with permission to write `server.conf` and signal the broker — a stale pre-U2 CLI, a
hand-run `kill -HUP`, an operator with an editor — can promote a preload map that resurrects
revoked credentials, and no POSIX mechanism available here prevents that. U2 makes such a promotion
**detectable** (step 8's digest mismatch; the §7 verb's disk-vs-KV compare) and never claims to make
it impossible. §5's R3 cell tests exactly and only the cooperative-writer property.

#### Crash resume — branch on the record, never on disk

A non-null `pending` found at step 2 means the previous writer died between claim and commit. The
resuming writer holds the lease (it got past step 0), so nothing else is moving. It decides by
comparing `appliedGeneration` to `generation` and, within the not-yet-proven arm, by digesting the
bytes actually at `server.conf`. **It never asks whether `pending` is "consistent with disk".**
That question was the previous revision's rule and it is the one that could downgrade a live
broker: disk account records say nothing about which generation the broker is *running*.

| Record state | Meaning | Action |
|---|---|---|
| `appliedGeneration == generation`, `pending == null` | clean | proceed with fresh work |
| `appliedGeneration == generation`, `pending.stagedDigest` absent | died at or before step 5's staging CAS; nothing was promoted | **rollback permitted**: clear `pending`, refuse loud, report |
| `appliedGeneration == generation`, `sha256(server.conf) == configDigest` | staged but never renamed; the running bytes are still generation *g*'s | **rollback permitted**: unlink the staged file, clear `pending`, refuse loud |
| `appliedGeneration == generation`, `sha256(server.conf) == pending.stagedDigest` | **PROMOTED-BUT-UNCOMMITTED** — the rename landed; the broker may or may not have loaded it | **complete FORWARD only.** Re-SIGHUP, re-prove, write `appliedGeneration`, commit. Rollback is forbidden: the broker may already be serving *g+1*, and renaming back would be a silent eviction of a connected tenant |
| `appliedGeneration == generation + 1` (`== pending.generation`) | **proven, uncommitted** — the third state, now durably recorded | **commit only.** Verify `sha256(server.conf) == configDigest`, then finish step 8. Rollback forbidden |
| anything else | unreachable under the fences above | **fail closed**: refuse, print both lists and the record, route the operator to §7 |

Two rules carry the whole table:

1. **Rollback is forbidden once proven** — and "proven" now has a durable witness
   (`appliedGeneration`), so no resumer has to infer it. The old guarantee in §4 ("a refusal leaves
   the broker on the last generation it was *proven* to carry") is only true because of this rule;
   the previous revision's resume path violated it.
2. **A re-drive is idempotent completion, not a fresh attempt.** Re-SIGHUPing the same bytes is
   harmless, so completing forward is always safe where rolling back is not. Where the two are both
   available the design still picks forward, because forward's failure mode is a retry and
   rollback's failure mode is evicting a working tenant.

This is `lifecycle-saga.ts`'s initial-activation crash-resume shape (`lifecycle-saga.ts:1-19`,
transport and fences at `:45-59`) — reserve, transition under a fence, commit last, resume by
reading the durable state rather than the world. That module is the one to model on, and the
correction above is precisely the point where the previous revision had *departed* from it.

---

## 4. Failure semantics

**A lost CAS REFUSES. It does not retry silently, and it never last-writer-wins.**

- The refusal is loud and typed: `EpEnvelopeError("conflict", …)`, the code
  `updateRecordEntry` already raises (`endpoint-records.ts:595`), classified on `err_code`
  10071/10164 and never on message text (`endpoint-records.ts:551-556`).
- The message names the concurrent mutation and tells the operator to re-read and re-decide —
  the wording discipline `endpoint-records.ts:584` and `:595` already use.
- **Retry is explicit, bounded, and re-reads first.** `writeAcl` (`acls.ts:188-259`; the
  declaration is at 188, its doc comment opens at 180) is the house
  pattern: up to 5 attempts, each one re-reading current state and re-deciding, and on exhaustion a
  loud throw that carries the underlying broker error as `cause` (`acls.ts:253-258`) so the real
  reason is not lost behind a wrapper. U2 follows it exactly.
- **A retry re-runs the decision, never the render.** Retrying step 3 with a list computed before
  the conflict is R1 again. The retry restarts at step 1.
- **Idempotence, not tolerance.** Adding a space already in the list is a no-op success (step 2), so
  a client that legitimately cannot tell whether its first attempt landed can safely re-issue.
  This is `writeAcl`'s "idempotent in effect" (`acls.ts:181-182`).
- **Fail-closed on uncertainty.** A corrupt account record already refuses every broker-wide
  operation (`auth-paths.ts:848-850`, and U1's `preloadSpaceAccounts` refusal). An unreachable
  inventory KV on a live broker refuses too. The rule is `provision.ts`'s: a tenant left out of the
  config is *evicted*, so never render while the list is uncertain.
- **An unproven reload is a failure.** Absent success line ⇒ roll back and refuse
  (`isolated-broker.ts:458-459`). Never "probably fine".
- **No silent partials.** Step 7's rollback restores the previous generation's bytes and re-proves
  the reload before refusing. A refusal leaves the broker on the last generation it was *proven* to
  carry — the same posture as U1's smoke, which asserts an unreadable record refuses the boot *with
  the previous config intact*.
- **Rollback is forbidden once proven, and every rollback is lease-fenced.** These two are what make
  the bullet above true rather than aspirational. A writer that has observed the proof line for
  generation *g+1* may never restore *g*'s bytes: the broker is serving *g+1*, and restoring *g*
  would revoke a tenant that is connected and working — a silent eviction dressed as a clean
  refusal. And a writer that does not hold the lease may not `rename()` in *either* direction; a
  rollback is a promotion too, and an unfenced one is the same hazard as an unfenced commit.
  Where rollback is forbidden the exit is **forward** (§3.4's resume table), never "leave it".
- **Every refusal names a runnable exit.** No refusal in this design may print only what is wrong.
  It prints what to run — a retry (bounded, above), a resume (automatic, §3.4), or the operator verb
  (§7). A refusal with no exit is a wedge, and a wedge reachable from a crash inside our own steps
  is a design defect, not an operator problem. §7 exists to discharge this rule; §7's own invariant
  restates it as a ship condition.

---

## 5. Live-test plan

Against a **real `nats-server`**, driving real processes — the F4 bar
(`rehearse-multispace.mts`, 9/9 cells against nats-server 2.14.5), not mocks. Each cell carries its
positive control, so a green cell cannot be green because nothing happened.

**The gate cell — R1.** Boot with `alpha`. Fire two concurrent adds, `beta` and `gamma`, from two
separate processes with a deliberate barrier so their inventory reads provably overlap. Assert:

1. Exactly one add succeeds; the other refuses with a `conflict`, not a timeout and not a success.
2. The refuser, retried, succeeds.
3. **After both settle, `alpha`, `beta` and `gamma` all connect** — the plan's gate, stated
   positively. `resolver_preload` contains all three, `spaces` is exactly
   `{alpha, beta, gamma}`, and `generation == appliedGeneration` with `pending == null`.
   *Assert the set and the convergence, never a generation NUMBER* (FILED-4, §3.3): a refused-then-
   retried mutation, a forward-completed resume, or a §7 reconcile all move the counter
   independently of how many spaces landed, so `generation == 3` is an assertion about scheduling
   luck rather than about correctness. The invariant with meaning is
   `generation == appliedGeneration && pending == null && spaces == the expected set`.
4. Positive control: with the CAS disabled, cell 3 fails and the *dropped* tenant's cred is refused
   as a broker `Authorization Violation` — the lost update is demonstrated, so cell 3 is meaningful.

**R2.** Start `up` on a root holding `alpha`; from a second process add `beta` timed into the
window between the config write and `setupSpaceStreams` (`up.ts:2704-2709`). Assert the adder
blocks on the lease rather than racing, both spaces connect afterwards, and
`generation == appliedGeneration`. Second arm: kill the adder between claim and commit; assert
`pending` is non-null and visible, the next writer resumes or rolls back, and no tenant is
silently missing.

**R3.** Remove `beta` concurrently with an add of `gamma` that read the pre-removal list. Assert
the add refuses, and — the security assertion — **a `beta` cred does not connect afterwards**.
Positive control: the same `beta` cred connected before the removal.

**Reload-failure arm.** Force a config the broker rejects (a deliberately malformed extra account).
Assert: refusal, previous config restored, `appliedGeneration` unchanged, and every
previously-working tenant still connects. This is the arm that proves "no silent partials".

**Bootstrap arm.** Cold `up` on a root with two account records seeds `generation: 1` with both
spaces. A second concurrent cold `up` loses the create-only CAS and refuses.

**Crash-window arms (new — these are the blocker fixes' tests).** Each kills the writer at a named
point and asserts the §3.4 resume table's row, and each carries the same positive control: the
tenant that must keep working does.

| Kill point | Expected record state | Assert |
|---|---|---|
| between step 3 and step 5's staging CAS | `appliedGeneration == generation`, no `stagedDigest` | next writer rolls back and refuses; every pre-existing tenant still connects |
| between the staging CAS and step 6's `rename()` | `sha256(server.conf) == configDigest` | next writer unlinks the staged file and refuses; no tenant moves |
| between `rename()` and the step-7 proof | `sha256(server.conf) == pending.stagedDigest` | next writer completes **forward** (re-SIGHUP, re-prove, commit); **no rollback occurs**; the added tenant ends up connected |
| **between the step-7 proof CAS and step 8** | `appliedGeneration == generation + 1` | next writer **commits only**; assert `spaces` gains the space and — the blocker-1 assertion — **the tenant proven at step 7 is never evicted** |
| lease expiry while paused before `rename()` | `pending` intact, nothing promoted | the woken writer **aborts before rename**; the config on the broker is the one the *other* writer committed; **the removed space's cred does NOT connect at any point** — the blocker-2 assertion, sampled continuously across the window, not just after it settles |

The last row's negative control is the one that matters: a `beta` cred polled on a tight loop for
the whole window must never once succeed. Sampling only at the end would have passed against the
*previous* revision's design, which is what made the resurrection window invisible.

**Cold-boot wedge arm (§7).** Diverge disk and KV with the broker down (add an account record by
hand). Assert: `up` refuses **and prints the reconcile command**; running that command with no
resolution flag refuses and prints both lists; `--adopt-disk --yes` converges and every space
connects; a corrupt record makes reconcile itself refuse *before* offering any resolution.

Landing shape: one live smoke in the CLI package, registered in `bin/smoke/ci-suites.txt` — the
same place the multi-space suites are registered (`ci-suites.txt:188` is `smoke:multi-space` in
this lane; U1's entry is `smoke:up-multi-space-render:live`, which is the registered *suite name*
— the previous revision cited it as the filename `up-multi-space-render-live.smoke.ts`).

---

## 6. Named residuals

Stated, not silently absorbed.

1. ~~**Cold-boot / live reconciliation.**~~ **RESOLVED — promoted to §7.** The previous revision
   proposed refusing on divergence and left the decision open. Refusing was right; leaving it open
   was not, because the refusal has no exit and a crash inside our own step 4 can reach it, so every
   later `up` refuses identically and the box is wedged. §7 is the exit, and it is a required part
   of the design.
2. **One broker, one root.** This design fences writers against one broker process. A clustered or
   multi-box broker is out of scope and would change where the lease lives.
3. ~~**The lease is liveness, not safety.**~~ **RESOLVED — folded into §3.4.** The "should" is now a
   MUST: the step-6 fence aborts before `rename()`, the rollback path is fenced identically, and
   step 8 verifies the running digest. The residual's own reasoning was correct and its proposed
   safety net (the step-8 CAS) was not sufficient — the CAS loses *after* promotion, which is an
   observable resurrection window, not a prevented one. What remains genuinely residual is the
   **read side**: U2 fences cooperative writers and cannot fence a SIGHUP from an arbitrary process
   on the box (§3.4, "Read-side scope"). That is a stated limit of the design, not a to-do.
4. **`extraAccounts` placement — the U3 seam, stated precisely.** U2 adds one operator-signed
   broker-authority account to `extraAccounts` (§3.2) beside the auth-callout account. U3
   (`membership-sys-injection`) works in the same *account class* and its §7 records "U2 … No
   overlap". That is true of subjects, streams and messages — U2's buckets are `inventory`-keyed
   and U3 touches no bucket — but it is **too strong as written**, and the shared seam should be
   named from both sides rather than only U3's. Concretely, both lanes edit:
   (a) `provision.ts`'s `extraAccounts` plumbing and its callers, and
   (b) the operator-account provisioning path in `up.ts` — U2's step-5 render call
   (`up.ts:2704` on `origin/main`, U1's `:2717`) against U3's provision window (`up.ts:2825-2842`).
   And the functional collision: **U3's `--rotate-sys`-driven config rewrite invalidates a
   `configDigest` U2 proved, and U2 does not fence it** (§3.2, FILED-2). U2 *detects* it at step 8
   and refuses; it cannot prevent it. Coordinate on (a) and (b) before implementing.
   **Decided (cross-lane):** `rotate-sys` acquires U2's writer lease, and that is a **U2
   build-phase item landing with the saga implementation** — the lease is U2's own construct, and
   until the saga exists there is nothing for an unfenced rotate to invalidate. Today's
   `rotate-sys` stays guarded by its own `guardBrokerOverwrite` (`auth-paths.ts:1032`) and **U3 is
   untouched**. When it lands it is a U2-implementation change to the shared path, coordinated with
   U3's seam at the time it lands — not U3 homework.
5. **v1 does not need this.** The plan says the control plane serializes adds, so U2 is post-GA
   hardening. Nothing here should be read as blocking P2.

---

## 7. The reconcile verb — every refusal has a runnable exit

### 7.1 The invariant

> **No refusal in this design is reachable without a printed, runnable exit.**

This is a ship condition, not an aspiration. A refusal that only describes the problem is a wedge,
and §6 residual 1 was exactly that: a cold-boot divergence check with no way out, reachable from a
crash inside our own step 4 (record written, generation never committed), after which *every*
subsequent `up` refuses identically until someone hand-edits the KV store — which is the same
hand-editing the check exists to catch. The cure was the disease.

Two more wedges close here. A root restored from backup with a KV older than disk diverges on the
next boot with no path out. And any resume that lands in the §3.4 table's `anything else` row —
a state unreachable under the fences, so a state we do not get to reason about — must fail closed
*to somewhere*, not just fail closed.

The exit is one operator verb: **`cotal broker reconcile`**.

### 7.2 What it prints before it does anything

Unconditionally, on every invocation including a refusing one:

- **The disk list**, from `accountInventory(dir)` (`auth-paths.ts:851-891`) — every
  `account.*.json` that round-trips.
- **The KV list**, from the `inventory` record — `spaces`, `generation`, `appliedGeneration`,
  `configDigest`, and `pending` in full if non-null.
- **The diff**, as two named sets: `disk-only` (present on disk, absent from the broker's list) and
  `kv-only` (listed by the broker, no record on disk). Never a single merged "differences" blob —
  the two directions have different blast radii and the operator is choosing between them.
- **The derived state**, in the §8 vocabulary: which of `SILENT EVICTION`,
  `PROMOTED-BUT-UNCOMMITTED`, `UNPROVEN RELOAD` or plain divergence this box is in.

Printing is not gated on a flag. An operator diagnosing a refusal runs the verb bare and gets the
picture; nothing is hidden behind the thing they have not decided yet.

### 7.3 It refuses without a named resolution

`reconcile` with no resolution flag **refuses after printing**. There is no default and no
`--force`. The operator must name a direction:

- **`--adopt-disk`** — the disk records are the truth. The KV list is rewritten to match
  `accountInventory`; `kv-only` names are dropped from the list. This is the backup-restore case and
  the hand-added-record case.
- **`--adopt-kv`** — the broker's list is the truth. The config is re-rendered from the KV list;
  `disk-only` records stay on disk but stop being preloaded. This is the "a record was added by
  hand and should not have been" case.

Naming the direction is the point. "Reconcile" without a direction is a guess, and a guess here
evicts tenants.

### 7.4 It enumerates the eviction blast radius, and asks

Both directions can evict. `--adopt-kv` stops preloading every `disk-only` space; `--adopt-disk`
drops every `kv-only` name from the list, and if that name's record is also absent from disk the
space is gone from the broker. So before doing anything, `reconcile` prints:

```
--adopt-kv will EVICT 2 spaces (their creds stop connecting immediately after the reload):
    delta    (account.delta.json present on disk, not in the broker list)
    epsilon  (account.epsilon.json present on disk, not in the broker list)
  These records are NOT deleted. Re-add with `cotal space add <name>`.
Confirm by re-running with --yes, or choose --adopt-disk to keep them.
```

Every evicted space is listed **by name** — never "2 spaces will be affected" — because the operator
needs to recognise the tenant, and a count is not recognisable. The confirmation (`--yes`
non-interactively, or a typed confirmation interactively) restates the count. An empty blast radius
still prints, saying so; "evicts nobody" is information the operator wants before pressing enter.

### 7.5 It runs THROUGH the saga

`reconcile` does **not** write the inventory record directly, and does not write `server.conf`
directly. It is a saga op like `add` and `remove` — `pending.op = "reconcile"` — and it takes every
step of §3.4 in order:

- **step 0** acquire the writer lease. A concurrent mutation blocks the reconcile, or the reconcile
  blocks it; either way they do not interleave.
- **step 3** claim, CAS-fenced at the revision it read. If the record moved between the print and
  the confirmation, the claim loses and reconcile refuses — the operator's decision was made against
  a state that no longer holds, so it must be re-made. This is why the verb re-reads and re-prints
  rather than acting on the numbers it showed a minute ago.
- **step 4** materialises nothing. The records already exist (or already do not); `reconcile` changes
  the *list*, never the material. It does not create, delete or edit an `account.*.json`.
- **steps 5-8** render, stage, fence, promote, prove, record the proof, verify the digest, commit —
  identical to a normal mutation, including the crash-resume table. A crash inside `reconcile`
  resumes exactly like a crash inside an `add`.

The reason this matters: a "repair tool" that writes state directly is a second writer, and a second
writer is R1. The verb that fixes divergence must not be able to cause it.

### 7.6 It fails closed on unreadable records

`accountInventory` returns `{ spaces, corrupt }`, and `corrupt` is the codebase's existing signal
that the tenant count is *unknown* (`auth-paths.ts:848-850`; U1's `preloadSpaceAccounts` refuses on
it too, `auth-paths.ts:915-929`). If `corrupt` is non-empty, `reconcile` **refuses before offering
any resolution at all** — `--adopt-disk` is meaningless when the disk cannot be read, and
`--adopt-kv` would silently evict whatever those unreadable records turned out to be.

Its exit, per §7.1, is printed and runnable: the corrupt paths by name, and the instruction to
repair or move them aside and re-run. That is the one refusal in this design whose exit is not
another command in this design — and it is honest about that, because the alternative is guessing
how many tenants exist.

### 7.7 Refusal → exit table

The §7.1 invariant, discharged. Every refusal U2 can emit, and what it prints as the way out.

| Refusal | Where | Printed exit |
|---|---|---|
| lease not acquired | §3.4 step 0 | who holds it and the TTL; retry after it expires |
| claim CAS lost | §3.4 step 3 | the concurrent mutation; re-read and re-decide (bounded retry, §4) |
| lease lost before rename | §3.4 step 6 | nothing was promoted; re-run the mutation |
| reload unproven | §3.4 step 7 | rolled back to generation *g*; the broker log tail |
| digest mismatch at commit | §3.4 step 8 | something outside the saga promoted a config; `cotal broker reconcile` |
| resume lands in `anything else` | §3.4 resume table | the full record and both lists; `cotal broker reconcile` |
| cold-boot disk/KV divergence | §3.2 | both lists, the diff, and `cotal broker reconcile` |
| seed create-only CAS lost | §3.2 | another process booted this root first; `cotal status` |
| reconcile with no direction | §7.3 | both lists and the two flags, with each one's blast radius |
| corrupt account record | §7.6 | the corrupt paths; repair or move aside, then re-run |

---

## 8. Exported vocabulary — the torn-write failure modes

**This section is the stable citation target for other lanes** (U3 cites it as
`docs/design/u2-resolver-cas.md` §8). Each term names one failure mode, anchored to a real site in
this codebase rather than to a general notion, so that "we handled the torn write" is a checkable
claim about a specific window rather than a reassuring phrase.

### TORN READ
A set reconstructed by *scanning* while the thing scanned is moving: entries added or removed
between the first and last read produce a set that never existed at any instant.
**Anchor:** `kv-scan.ts:63-72` documents exactly this — a scan over a moving tail is not a snapshot.
**In U2:** the reason §3.3 holds the whole list under *one* key rather than one key per space. A
per-space layout would require reconstructing the set by scan on every render, which is this bug by
construction, and JetStream offers no multi-key transaction to avoid it.

### TORN WRITE / LOST UPDATE
Two writers each read, each compute a correct result from what they read, and each write — and the
second write erases the first, with neither writer's own logic ever being wrong.
**Anchor:** `provision.ts:2409-2411`, the W4 note in the renderer itself: *"the MEMORY resolver is
one static whole-broker map, so every mutation rewrites all of it."* And `putSpaceAuth`
(`auth-paths.ts:1024-1066`), which guards *content* thoroughly and *concurrency* not at all.
**In U2:** race R1. Note the two independent losses — the file loses and the *read* loses — which is
why an atomic file write alone does not fix it, and why the fence is a CAS at step 3 on the list
rather than an atomic rename at step 6 on the bytes.

### SILENT EVICTION
A tenant that exists everywhere an operator would look — on disk, in `accountInventory`, in
`cotal status` — but is absent from the promoted `resolver_preload` map. Its credentials are refused
by the broker with **nothing printed anywhere**, by either side.
**Anchor:** `provision.ts:2525-2529` — the preload map is whole-broker and total, so omission *is*
revocation; there is no partial state and no diagnostic.
**In U2:** the harm R1 causes and the harm every rollback risks. It is the reason §3.4 forbids
rollback once proven and §7 enumerates the blast radius by name: an eviction nobody can see is
strictly worse than a refusal everybody can.

### RESURRECTION
A stale render promoted into a running broker re-admits a space that was deliberately removed, and
credentials that were revoked connect again and work.
**Anchor:** race R3, and U1's `preloadSpaceAccounts` (`auth-paths.ts:915-929` @ `6e634f1`), whose
"disappeared while rendering" refusal caught this *only* in the one window where it happened to be
detectable — between the inventory read and the sibling load. Widen the window by one step and
nothing catches it.
**In U2:** a security regression, not a lost update, which is why §4 cannot be "retry until it
sticks". Closed among cooperative writers by §3.4's step-6 abort-before-rename fence; explicitly
**not** closed against an arbitrary process on the box that writes the config and sends its own
SIGHUP (§3.4, "Read-side scope").

### PROMOTED-BUT-UNCOMMITTED
Bytes have been renamed over `server.conf` and may already have been loaded by the broker, but no
generation has been committed to record it. The durable state says one thing and the running process
may say another.
**Anchor:** §3.4's step 6 → step 7 window, and its resume row. Detected by comparing
`sha256(server.conf)` against `pending.stagedDigest` — which is why step 5 stages that digest
durably *before* promoting anything.
**In U2:** resolved **forward only**. Rolling back is forbidden here even though nothing was proven,
because the broker may already be serving the new config and rolling back would be a SILENT
EVICTION of a tenant that is connected right now.

### UNPROVEN RELOAD
A `SIGHUP` was sent and no success line was observed. Not a failure — an *absence*, which is the
point: the config may be live, may not be, and the process that sent the signal cannot tell.
**Anchor:** `isolated-broker.ts:444-460` — the existing shape refuses on
`Failed to reload server configuration` **and** refuses when `Reloaded server configuration` is
absent (`:458-459`). A reload that cannot be proven is a failure, never a maybe.
**In U2:** step 7 reuses this verbatim in shape, and it is the sole authority for writing
`appliedGeneration`. The field means "proven", so only the step that read the proof line may set it.

### FAIL-CLOSED ON UNCERTAINTY
When the tenant set is not knowable, refuse the whole broker-wide operation rather than proceeding
with the part that is known. Proceeding renders a config missing whoever could not be read, and per
SILENT EVICTION, missing *is* revoked.
**Anchor:** `auth-paths.ts:848-850` — a corrupt record is *uncertainty about how many tenants exist*,
and it already fails the broker-wide guards closed.
**In U2:** an unreachable inventory KV on a live broker refuses (§3.2); an unreadable account record
refuses reconcile before it will even offer a resolution (§7.6); the §3.4 resume table's
`anything else` row refuses to §7. The rule pairs with §7.1 and is incomplete without it: failing
closed without a printed exit is how a safety property becomes a wedge.
