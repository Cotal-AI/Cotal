# M-G1 result — the prediction held on BOTH halves

Predicted in `.lane/guard-mutation-predictions.md`, committed **before** the mutant was applied.
Baseline and mutant both run in the same session, same command, same scrubbed environment.
rc read from an EXIT-trap artifact in every case, never from a pipe.

| run | result | rc |
| --- | --- | --- |
| baseline `135c7fff` | **25 passed, 0 failed** | **0** |
| **M-G1** (staleness branch deleted) | **20 passed, 5 failed** | **1** |
| restore, re-derived | **25 passed, 0 failed** | **0** |

Predicted 20/5 rc 1. **Exact match**, and the count is only the checksum — the names below are the
claim.

## The five RED cells are exactly the five named in advance, and nothing else went red

1. `guard-stale: a reading past the freshness bound does NOT report as current`
2. `guard-stale: and it names that condition specifically`
3. `guard-stale: the stale reading was SERVING, and it is STILL refused — the guard's own silence outranks a good last look`
4. `guard-stale: it carries the age and the bound it exceeded, not just the fact that it did`
5. `the stale render SHOWS its held reading but marks it NOT current`

**No unpredicted cell reddened.** That matters as much as the reds: an unrelated early failure is
also red, and a mutation "killed" by collateral damage proves nothing about the cell that was
supposed to catch it.

## The five cells predicted to STAY GREEN all stayed green

- `guard-stale inverse control: exactly AT the bound still reports — the refusal is bounded, not universal` ✓
- `every REPORTING state leads with the age of its observation` ✓
- `no NON-reporting state renders as if it were current` ✓
- `every NON-reporting state renders a line saying health was NOT established` ✓
- `the property set is NON-EMPTY, so the .every assertions above are not vacuous` ✓

**This half is the one that could have embarrassed me and it is why it was registered.** Two of
those cells are `.every` over a set that SHRINKS by one under the mutant — the stale report moves
out of the non-reporting filter — so they pass over a smaller universe while the behaviour is
wrong. They are not broken; **they were never watching this branch**, and the M-WD3 lesson on this
lane is that a prediction listing only reds cannot be wrong in the direction that matters.

`every REPORTING state leads with the age of its observation` is the sharpest example: under the
mutant the stale reading becomes a reporting one and still renders `[observed 30001ms ago]`, so the
cell is satisfied **by an output that is lying to the operator**. Correct rendering of a wrong
verdict is still a wrong verdict, and no rendering cell can be asked to catch that.

## Non-equivalence — argued before the run, confirmed after

On `{health: serving, observedAt: AT}` with `now = AT + 30_001`, `maxAge = 30_000`:

- original → `{reporting: false, condition: "guard-stale", ageMs: 30001, maxAgeMs: 30000}`
- mutant → `{reporting: true, health: serving, ageMs: 30001}`

A caller switching on `reporting` takes a different branch on identical input. **Non-equivalent, not
a refactor.** The mutant is the incident's own shape: the last thing anyone saw was fine, so
everything looked fine.

## Restore, verified rather than assumed

`git checkout -- implementations/cli/src/lib/delivery-guard.ts`; tracked tree clean; the string
`M-G1 MUTANT` returns **0** occurrences; the suite re-derives **25/0 at rc 0**. Git was the recovery,
and the tree was committed clean before the mutant was applied.

## What this does NOT prove

The killed mutation shows these cells **depend on** the staleness branch. It does **not** show a real
entry point reaches `guardReport` — the suite builds its inputs by hand, deliberately, because the
guard's own failure states cannot be constructed against a live broker. **Reachability from a real
CLI surface is UNPROVEN and is not claimed anywhere.** That is the same gap this lane recorded for
`managerClaim` before wiring it to `ready-card`, and it is the honest next step for the guard.
