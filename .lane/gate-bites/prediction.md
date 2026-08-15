# G1 — predictions, written and committed BEFORE the mutant is applied

The claim under test is **"the gate bites"**: with `smoke:delivery-health` now in the `smoke:ci`
chain, a real defect in the code it covers must take the chain red and stop it.

A prediction of a COUNT is not a prediction. Named cells below, plus the cells that must STAY GREEN —
those are what make the mutant discriminating rather than merely destructive.

## The mutant

`packages/core/src/health.ts`, in `fact()`: restore the clamp this lane removed.

    -  if (delta < 0) return { value, source, observedAt, ageMs: null, clockSkewMs: -delta };
    +  if (delta < 0) return { value, source, observedAt, ageMs: 0, clockSkewMs: -delta };

Chosen because `0` is exactly what a live responder round-trip produces, so evidence stamped in the
FUTURE becomes indistinguishable from evidence that arrived this instant — and `ageMs > ttlMs` then
sails through the TTL gate. It is a real defect with an observable operator-facing effect, not a
syntactic break.

## What must go RED — 7 named cells, all in `packages/core/smoke/delivery-health.smoke.ts`

1. `CLOCK-SKEW: evidence stamped in the future does not render as age 0`
2. `CLOCK-SKEW: the fact reports that its age could not be established`
3. `CLOCK-SKEW: a lease whose writer clock is ahead REFUSES rather than passing the TTL gate`
4. `CLOCK-SKEW: the machine-readable condition is clock-fault, NOT lease-stale`
5. `CLOCK-SKEW: the refusal carries the measured skew on the arm itself`
6. `CLOCK-SKEW: and its detail names the direction of the fault`
7. `CLOCK-SKEW RENDER: it names clock-fault and refuses`

Expected totals: **31 passed, 7 failed**, suite rc `1`. The totals are a cross-check on the names,
not the prediction.

## What must stay GREEN — the discriminators

- `CLOCK-SKEW: the fact carries the measured skew, so a reader can see how far ahead` — the mutant
  keeps `clockSkewMs`, so a cell that reddened here would mean the mutant is broader than claimed.
- `CLOCK-SKEW RENDER: the operator line contains no raw null` — under the mutant there is no `null`
  to print at all. **This cell passing while the suite is broken is the point of listing it:** it
  shows a green cell can accompany a false green, which is why cell 7 exists beside it.
- `CLOCK-SKEW inverse control: the same lease with a sane clock is SERVING — the skew is what
  decided it` — unaffected; if this reddened, the arms could not differ and cell 3 would prove
  nothing.
- All 5 refusal-grammar blocks above the clock-skew block (serving / no-responder / lease-stale /
  no-lease / refused) and the state matrix — none constructs a future-stamped lease.

## What must happen AT THE CHAIN LEVEL — the actual gate claim

`bin/smoke/shard.mjs 0 1` is the real CI entry point and shard `0/1` is the whole chain: **221
members**, `pnpm smoke:delivery-health` at index **217**, with exactly three after it —
`pnpm smoke:delivery-health-live`, `pnpm smoke:manager-claim`, `pnpm smoke:ready-card`.

| run | predicted rc | predicted log |
| --- | --- | --- |
| baseline | `0` | 221 lines of `STUB`/`REAL`, `EXIT smoke:delivery-health 0`, `EXIT smoke:delivery-health-live 0`, ends `✓ smoke:ci shard 0/1 passed` |
| mutant | `1` | ends `EXIT smoke:delivery-health 1`; shard prints `✗ shard 0/1 FAILED at: pnpm smoke:delivery-health (exit 1)` |

**And the abort must be shown, not assumed:** under the mutant the three members after index 217
must be ABSENT from the log. Their absence is asserted by name — grepping for each of the three and
requiring a miss, with the same grep shape sighted first against a member that IS present.

## Non-equivalence

A killed cell shows the test depends on that line; it does not show the mutant is a real defect.
`witness.mts` renders the operator line for a lease stamped 5s in the future, captured under the
mutant and again after restore. The two must DIFFER, and the mutant's must read as healthy.

## What this run does NOT measure

The other 219 chain members. They are stubbed to exit 0 by `shim/pnpm`, so this run says nothing
about any of them, and it is not a gate. It answers one question: when this member exits nonzero,
does the chain go red and stop.
