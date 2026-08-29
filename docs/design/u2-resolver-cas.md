# U2 — resolver-inventory CAS

**Status:** design, Phase 1. Nothing here is implemented. Review gate: this doc is approved
before any code lands.

**Plan node (verbatim, `docs/CLOUD-PLAN.md` in the platform lane):**

> **U2 — resolver-inventory-CAS** · F4 · Broker-authoritative space inventory with
> generation/CAS + atomic promotion above `serverConfig` (upstream names this gap). v1
> serializes adds in the control plane, so this is post-GA hardening. · **Gate:** two
> concurrent space adds cannot lose one.

Depends on F4 (`spike-live-space-add`, DONE): live add/remove by re-render + `SIGHUP` with the
broker never restarting is proven, including the negative arm, in
`apps/backend/scripts/rehearse-multispace.mts:127-137` (live add) and `:199-201` (live remove).
U2 does not re-prove that. U2 makes the re-render *safe to race*.

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

**Bootstrap honesty.** The inventory describes the broker's config and lives *inside* the broker.
A cold `up` has no broker yet, so there are two regimes and the doc must not pretend otherwise:

- **Cold boot** (no broker reachable): disk is authoritative. Exactly one process is starting a
  broker on this root; the existing single-writer posture holds. The first thing the booted broker
  does is **seed** the inventory from `accountInventory` at generation 1 via a create-only CAS
  (`createRecordEntry`). A create that loses means another process booted first — refuse.
- **Live** (broker reachable): the KV generation is authoritative. Disk records remain the material
  (the JWTs live there); the KV row is the *list* and the *generation*. A live mutation that cannot
  reach the KV **refuses** — it does not fall back to disk. Falling back is R1 with extra steps.

Reconciliation between the two is a named residual (§6).

### 3.3 The record

One key, `inventory`, holding the whole list — not one key per space. The thing being made atomic
is the *set*, because `resolver_preload` is a set; per-space keys would require a multi-key
transaction JetStream does not offer, and reconstructing a set from a scan reintroduces the
torn read (`kv-scan.ts:63-72` documents why a scan over a moving tail is not a snapshot).

```jsonc
{
  "generation": 7,          // bumps on every accepted mutation
  "spaces": ["alpha", "beta"],
  "appliedGeneration": 7,   // the generation the RUNNING broker's config was proven to carry
  "configDigest": "sha256:…",// digest of the server.conf bytes that were promoted
  "pending": null           // or { generation: 8, op: "add", space: "gamma", claimedAt, writer }
}
```

`generation` is the CAS subject. `appliedGeneration` is what makes R2 detectable:
`generation > appliedGeneration` means *a mutation was accepted and the broker has not been proven
to carry it* — a resumable, visible state rather than a silent divergence.

### 3.4 The mutation saga

Writer lease first. The file-write + `SIGHUP` window is a genuine critical section (two writers
that both win separate CAS rounds could still interleave their `writeFileSync`+`SIGHUP`), and the
lease is the same per-key CAS create in a TTL bucket the manager lease already uses —
`endpoint.ts:2820` states the invariant plainly: *"the per-KEY CAS create stays the only
single-flight gate"*. TTL bounded like `MANAGER_LEASE_TTL_MS` (`streams.ts:89`), so a crashed
writer's lease expires rather than wedging the broker forever.

```
0. acquire writer lease         create-only CAS in the TTL bucket; loss ⇒ REFUSE (§4)
1. read inventory               get → { value, revision }
2. decide                       add: space already present ⇒ no-op success (idempotent)
                                remove: space absent ⇒ no-op success
3. claim                        CAS update at `revision`:
                                  pending = { generation: g+1, op, space, writer }
                                loss ⇒ REFUSE (§4)
   ── from here the intent is DURABLE and RESUMABLE ──
4. materialise                  add: putSpaceAuth (auth-paths.ts:1024) writes the record
                                remove: retire the record
5. render                       serverConfig(broker, preloadSpaceAccounts(dir, current), …)
                                unchanged renderer; input is the claimed list
6. promote ATOMICALLY           write server.conf.<g+1> in the same dir, fsync, rename() over
                                server.conf  (POSIX rename is atomic; the broker never observes
                                a partial config)
7. reload + PROVE               SIGHUP, then require "Reloaded server configuration" and refuse on
                                "Failed to reload server configuration"
                                — the isolated-broker.ts:455-459 proof, verbatim in shape
   on failure                   rename the previous generation's bytes back, SIGHUP, prove again,
                                clear `pending`, REFUSE loud
8. commit                       CAS update: generation = g+1, spaces = new set,
                                appliedGeneration = g+1, configDigest = …, pending = null
9. release lease
```

Steps 3 and 8 are the two CAS points. Step 3 is what makes R1 impossible: W1 and W2 both read
revision *r*; one CASes to *r+1* and the other's CAS at *r* loses and refuses. Neither writer's
render is ever built from a list the other has already superseded, because a superseded list
cannot get past step 3.

R2 is closed by the lease plus `appliedGeneration`: `up`'s render happens *inside* the lease, and a
concurrent add blocks at step 0 rather than racing the boot's config write. R3 is closed by the
same fence — a remove that commits at generation *g+1* makes any in-flight add's step-8 CAS at *g*
lose, so the resurrecting render is never promoted.

**Crash resume.** A non-null `pending` found by the next writer means: the previous writer died
between claim and commit. Recover by re-driving from step 4 if `pending` is still consistent with
disk, else roll it back and clear it. Never by assuming. This is exactly `lifecycle-saga.ts`'s
initial-activation crash-resume shape (`lifecycle-saga.ts:3-5`), which is why that module is the
one to model on rather than a new state machine.

---

## 4. Failure semantics

**A lost CAS REFUSES. It does not retry silently, and it never last-writer-wins.**

- The refusal is loud and typed: `EpEnvelopeError("conflict", …)`, the code
  `updateRecordEntry` already raises (`endpoint-records.ts:595`), classified on `err_code`
  10071/10164 and never on message text (`endpoint-records.ts:551-556`).
- The message names the concurrent mutation and tells the operator to re-read and re-decide —
  the wording discipline `endpoint-records.ts:584` and `:595` already use.
- **Retry is explicit, bounded, and re-reads first.** `writeAcl` (`acls.ts:188-259`) is the house
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
   positively. `resolver_preload` contains all three; `generation == appliedGeneration == 3`.
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

Landing shape: one live smoke in the CLI package, registered in `bin/smoke/ci-suites.txt` — the
same place U1 registered `up-multi-space-render-live.smoke.ts`.

---

## 6. Named residuals

Stated, not silently absorbed.

1. **Cold-boot / live reconciliation.** Disk and KV can diverge if records are edited by hand while
   the broker is down. Proposal: on boot, compare `accountInventory` to the KV list and **refuse on
   divergence** with both lists printed, rather than picking a winner. Needs a decision.
2. **One broker, one root.** This design fences writers against one broker process. A clustered or
   multi-box broker is out of scope and would change where the lease lives.
3. **The lease is liveness, not safety.** A writer paused past its TTL could in principle promote a
   config after losing the lease. The step-8 CAS is the safety net (it will lose), but the config
   file was already promoted — so step 6 should re-check lease ownership immediately before the
   rename, and step 8's loss must trigger the step-7 rollback path. Worth an adversarial pass.
4. **`extraAccounts` placement** for the inventory bucket needs confirmation against U3
   (`membership-sys-injection`), which is also working in the operator-owned non-data account space.
   Coordinate before implementing rather than colliding.
5. **v1 does not need this.** The plan says the control plane serializes adds, so U2 is post-GA
   hardening. Nothing here should be read as blocking P2.
