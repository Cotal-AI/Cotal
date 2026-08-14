# Mutation record — connection-lifecycle repair

Base: the fix commit `325aaa50` + suite `3c1055e3`, worktree `/home/david/Cotal-wt-fm-meshctl`.
Suite: `packages/core/smoke/connection-lifecycle.smoke.ts`, **20/20 green at base; 27/27 after ARM 3b;
32/32 at `1821abff`; 34/34 at `b1b757f7`** after the per-arm entry preconditions — every number
re-run and re-read, none carried forward.

**This line was stale until it was measured.** It read `27/27` while the suite had already grown to
32 cells, because the count was carried from the last time it was written rather than from the last
time it was run. The number is now the one the suite printed: `CONNECTION-LIFECYCLE OK ✅ (32 passed,
0 failed)`. Recorded here because a ledger that drifts from its own suite is how a ledger becomes
fiction — the fix is to correct the document to the measurement, never the reverse.

**No VOID risk on this suite, and it was checked rather than assumed.** It imports
`../src/index.js` relatively through `tsx`, so a mutation in `packages/core/src` IS the code that
runs. (The *connector* suite is the opposite and that trap already cost me four VOID runs: it
resolves `@cotal-ai/core` → `extensions/connector-core/node_modules/@cotal-ai/core` →
`/home/david/Cotal-wt-fm-meshctl/packages/core/dist/index.js`, measured with
`import.meta.resolve`, so it needs a `tsc -p packages/core` before every run.)

Every prediction below was written to disk **before the first run**
(`scratchpad/PREDICTIONS.md`), including the one I expected to survive.

---

## MX1 — remove `doRebuild`'s post-dial cleanup  → **KILLED**

Mutant: restore the bare `await this.connectAndBind();`.

| cell | predicted | observed |
|---|---|---|
| D1a refusal is `bind-failed` | RED | RED — reason flipped back to `broker-unreachable` |
| D1b nothing live at the broker | RED | RED — **`{ current: 1 }`** |
| D1c endpoint holds no connection | RED | RED — **`{ hasNc: true, self: true }`** |
| ARM 2, ARM 3 | GREEN | GREEN (17 passed, 3 failed) |

**Non-equivalence, at the broker:** `current: 1` is `nats-server`'s own `/varz` reporting a live
connection *after the caller was told the connect was refused*. Not a reddened cell — a connection.

## MX2 — restore the original `disconnect()` ordering  → **KILLED**

Mutant: drop every broker handle and emit `connection:false` first, drain after.

| cell | predicted | observed |
|---|---|---|
| D2b retraction reported only if sent | RED | RED — text flipped to `COULD NOT BE RETRACTED` |
| D2c observer does not see offline | RED | RED — **`{ status: 'offline', activity: 'disconnected: arm2' }`** |
| D2d not stranded in a third state | RED | RED — `{ hasNc: false, self: false }` |
| ARM 1, ARM 3 | GREEN | **NOT OBSERVED — see below** |

**Non-equivalence, at the broker:** D2c's value is read from an INDEPENDENT observer endpoint's
presence view, i.e. off the broker's KV. Under the mutant a peer sees the agent as departed while
the agent is still connected — the ghost, reproduced.

**MY "GREEN ELSEWHERE" PREDICTION FOR MX2 WAS NOT CONFIRMED, AND I AM NOT CLAIMING IT.** D2e also
reddened (the control disconnect then refused `not-connected`), which left the shared subject
endpoint in a state ARM 1 and ARM 3 assume away, so D1c and D3c reddened downstream. That is
**cascade contamination, not independent evidence**: the arms share one endpoint and one broker.
It is a real weakness of the suite — the arms are not independent — and it is recorded here rather
than smoothed over. The named cells reddened on their own values; the extra reds prove nothing.
(First run of MX2 crashed the harness outright at the restore line. I hardened the restore to use
the captured connection object so the mutant's later cells stay observable, then re-ran. The
hardening is in the committed suite.)

## MX3 — remove the whole renewal fence  → **KILLED**

Mutant: both arm guards, the entry fence, the in-transaction fence, and `disconnect()`'s
`clearTimeout` — all five sites.

| cell | predicted | observed |
|---|---|---|
| D3b source not called while off | RED | RED — **`{ at: 1, now: 3 }`** |
| D3c broker sees no new connection | RED | RED — **`{ before: 3, after: 7 }`** |
| ARM 1, ARM 2 | GREEN | GREEN (18 passed, 2 failed) — clean, no cascade |

**Non-equivalence, at the broker:** four authenticated connections dialled by an endpoint that had
deliberately left the mesh. Independently reproduced by `rev2-meshctl-authority`, which reached the
same place from the other direction (marker `DRIVE_TIMER_PREFLIGHT_REPRODUCED`).

## MX4 — remove the post-source-await fence inside `adoptFreshCreds`  → **KILLED**

Added after `rev2-meshctl-authority` reproduced the crossing my earlier fences could not reach
(marker `SOURCE_CROSS_FIX_EXPECTATION_RC 1`): a renewal already inside its source call when
`disconnect()` lands is past every earlier check, and the next thing it touches is the preflight.

| cell | predicted | observed |
|---|---|---|
| D3h the crossed renewal does not dial | RED | RED — **`{ before: 7, after: 9 }`** |
| D3k CONTROL: released while CONNECTED it DOES dial | GREEN | GREEN |
| ARM 1, ARM 2, rest of ARM 3 | GREEN | GREEN (26 passed, 1 failed) — clean, no cascade |

**Non-equivalence, at the broker:** two authenticated connections from an endpoint that had
deliberately left the mesh. D3k is what makes D3h mean something — without it, "did not dial" is
equally explained by a renewal that never fires.

**Why the fix is a DISCARD and not a skip-the-dial.** Under prove-before-adopt a candidate may not be
committed without the broker proof, and being deliberately off forbids taking that proof — so
"commits but no longer dials" is not an available state. The candidate is dropped unproven and
re-fetched, and re-proven, by `connect()`. That framing is `rev2-meshctl-authority`'s, and it is the
reason the first patch shape (fence the transaction, keep the commit) would have been wrong.

## MX3a — remove ONLY `disconnect()`'s `clearTimeout`, keep every fence  → **SURVIVED (predicted)**

20/20 green. The entry fence in `renewCredsOnTimer` returns before any work, so the cleared timer
is **defence in depth, not the load-bearing part**. Registered as a survival prediction in advance
and it held.

I am reporting this rather than folding it into MX3, because "MX3 killed" would otherwise imply all
five sites are proven and only three are. The honest statement: **the fences are proven; the
`clearTimeout` is not, and it stays as belt-and-braces, not as tested behaviour.**

---

## MX2-R — the SAME MX2 mutant, re-run to test the arm-independence fix itself

Not a re-proof of MX2. MX2 was already killed. This run tests **the repair**: the original MX2 run
reddened cells in ARM 1 and ARM 3 by cascade, and I recorded those reds as *not evidence*. An
arm-independence fix that is asserted rather than demonstrated is the same defect one level up, so
the fix had to be shown failing ONE arm while the others kept reporting.

Predictions written to `scratchpad/PREDICTIONS-MX2R.md` **before the first run**, including the
refutation criteria. Mutant: identical to MX2 (drop the handles and emit `connection:false` first,
drain after).

### Run 1 — at `8c6c8aea`. HALF MY PREDICTION WAS REFUTED, AND THE REFUTATION IS THE USEFUL PART.

| cell | predicted | observed |
|---|---|---|
| `D2b` / `D2c` / `D2d` | RED | RED — `D2c` = `{ status: 'offline', … }`, the ghost |
| `D2e` control | (RED, as originally) | RED — the exact state that contaminated ARM 1 before |
| `PRE-ARM 1` + all 6 ARM 1 cells | GREEN | **GREEN, 7/7** — the claim under test, and it held |
| `PRE-ARM 3` | GREEN | **RED — `{ mints: 1, current: 2 }`** |
| ARM 3's 13 cells | GREEN | **VOID — not evaluated** |

**I predicted ARM 3 would be independent and it was not.** By the refutation criterion I wrote down
in advance — *"any ARM 3 cell going VOID … would mean an earlier arm can still spoil a later arm's
fixture"* — that is a refutation, and I am recording it as one.

**What the run nevertheless proved:** the VOID machinery is not decoration. It fired on real
contamination and named it, with the measured value that caused it. **The 13 cells that would once
have reddened silently — and been read as evidence — were instead declared not-evaluated.** The
failure mode changed from *invisible* to *named*, which is the whole point of the third outcome.

**Why `current: 2`:** retiring the endpoint OBJECTS is not enough. An earlier arm left a connection
alive at the broker that its endpoint no longer held. Every ARM 3 cell is a cumulative-counter delta,
so a stray socket is indistinguishable from the renewal dial the arm exists to detect.

### Run 2 — after the ARM 3 broker restart (`b1b757f7`)

| cell | predicted | observed |
|---|---|---|
| `PRE-ARM 3` | GREEN | **GREEN — `c` is the only endpoint live** |
| ARM 1, 7 cells | GREEN | **GREEN, 7/7** |
| ARM 2's four named cells | RED | RED |
| VOID count | 0 | **0** |
| ARM 3 cells | GREEN | **12 green, `D3c` RED — `{ before: 2, after: 3 }`** |

**`D3c`'s red is a legitimate kill, NOT residual coupling, and that is measured rather than argued.**
ARM 3 calls `c.disconnect()` — the mutated function — so the mutant genuinely reaches this arm.
The discriminator is `PRE-ARM 3` itself: it passed, establishing that **`c` was the only endpoint
live at the broker**, so the +1 cumulative connection inside `c`'s off-window is attributable to `c`
alone and to no predecessor. *A green precondition is what converts a red cell from an accusation
into evidence.*

**The claim this buys, stated at exactly its width:** under a mutant that breaks ARM 2, **ARM 1 is
demonstrably unaffected — 7/7 green, its own subject, its own precondition.** "Green elsewhere" is
now a measured property of this suite rather than an assumption about it. It is proven for ARM 1;
for ARM 3 the mutant reaches the arm legitimately, so ARM 3 is *fairly run*, not *unaffected*, and
those are different claims.

---

## What this record does NOT cover

- **ARM 3 is core-API only.** A creds SOURCE is not a state `cotalToolSpecs` can construct
  (`MeshAgent` passes static creds bytes), so nothing here shows a *tool caller* can reach the
  renewal arm. `rev2-meshctl-authority` refuted that reachability itself, unprompted, and I am not
  re-asserting it.
- **Arm independence. FIXED and DEMONSTRATED — see MX2-R below.** MX2 showed the three arms shared a
  fixture; each arm now declares an entry precondition, ARM 1 builds its own subject, and ARM 3
  restarts the broker. Re-running the *same* mutant shows ARM 1 fully green while ARM 2 reddens.
- **The in-flight crossing is now CLOSED, and that limitation is withdrawn.** An earlier version of
  this file declared it fenced "for the queued case only, with that exact race undriven". ARM 3b
  drives it (hold a source call open, disconnect, release) and MX4 proves the cell detects it.
- **No repo-wide suite was run.** No gate has been released to this lane. Scoped suites only:
  `connection-lifecycle` **34/34** (re-run at tip `b1b757f7`), `connection-control` 19/19,
  `request-strand` 9/9, `§7.2 gap` 11/11.
  One honest gap in how the earlier 32/32 was read: its exit code was **not** captured — `PIPESTATUS`
  is a bashism and the shell here is `/bin/sh`, so it came back empty. The claim rests on the
  suite's own printed `0 failed` line, not on an exit status I never saw. The 34/34 runs above DO
  carry a captured code: they were run under `bash -c` with an explicit `TERMINAL_MARKER rc=$?`,
  which is why this file can now cite `rc=0` clean and `rc=1` under both mutants.
