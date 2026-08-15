# M-G1 prediction — written BEFORE the mutation, at `135c7fff`

## The mutant

`implementations/cli/src/lib/delivery-guard.ts`, `guardReport()`: **delete the `ageMs > maxAgeMs`
branch**, so a reading past the freshness bound falls through and is reported as current.

**This is the D2 defect class in the guard itself** — trusting a stale answer because it was the
last good one — and it is exactly what the incident looked like: the last thing anyone saw was fine,
so everything seemed fine for three hours.

## NON-EQUIVALENCE, argued before the run rather than inferred from a red

Same input, observably different output — not a refactor:

| input | original | mutant |
| --- | --- | --- |
| `{health: serving, observedAt: AT}`, `now = AT + 30_001`, `maxAge = 30_000` | `{reporting: false, condition: "guard-stale", ageMs: 30001, maxAgeMs: 30000}` | `{reporting: true, health: serving, ageMs: 30001}` |

The mutant claims a 30-second-old reading speaks for the present moment. A caller switching on
`reporting` takes a different branch. That is a behavioural difference, so the mutant is
**non-equivalent**.

## Cells I predict RED — by NAME, not by count

1. `guard-stale: a reading past the freshness bound does NOT report as current`
2. `guard-stale: and it names that condition specifically`
3. `guard-stale: the stale reading was SERVING, and it is STILL refused — the guard's own silence outranks a good last look`
4. `guard-stale: it carries the age and the bound it exceeded, not just the fact that it did`
5. `the stale render SHOWS its held reading but marks it NOT current`

## Cells I predict STAY GREEN, and naming these is the point

The M-WD3 lesson on this lane was that pairwise cells stayed green under a collapse mutant, so a
prediction that only lists reds cannot be wrong in the direction that matters. These must NOT move:

- `guard-stale inverse control: exactly AT the bound still reports — the refusal is bounded, not universal`
  — reports in both versions, so it is **blind to this mutant by construction**. It controls the
  boundary, not the branch.
- `every REPORTING state leads with the age of its observation` — the newly-reporting stale entry
  still renders `[observed 30001ms ago]`, so this **stays green while the behaviour is wrong**. A
  cell that passes under the mutant is not a broken cell; it is a cell that was never watching this.
- `no NON-reporting state renders as if it were current` — the filtered set shrinks by one and the
  survivors still hold. **Green over a SMALLER set is exactly the vacuity risk** `.every` carries,
  and it is why the non-empty guard cell exists beside it.
- `every NON-reporting state renders a line saying health was NOT established` — same shrinking-set
  reason; `no-observation` and `guard-clock-fault` still satisfy it.
- `the property set is NON-EMPTY, so the .every assertions above are not vacuous` — 6 either way.

## Expected totals

Baseline **25 passed / 0 failed, rc 0**. Under M-G1 I predict **20 passed / 5 failed, rc 1**.
The count is a checksum on the five names above; **the names are the prediction.**

## Recovery

`git checkout -- implementations/cli/src/lib/delivery-guard.ts` at `135c7fff`. Git is the recovery,
not the tool, and the tree is committed clean before the mutation is applied.
