# Mutation predictions — do the partition pins detect anything the `.every()` cells miss?

Written BEFORE the mutant runs. Baseline: `bin/smoke/delivery-guard.smoke.ts` 28/28 rc 0 at `12df829c`.

## The mutant

The scenario the pins exist for: **`reporting` becomes unconditionally true.** Applied to
`implementations/cli/src/lib/delivery-guard.ts` by flipping `reporting: false` → `reporting: true` on
the three refusal branches (`:87` no-observation, `:96` guard-stale, `:105` guard-clock-fault).

**Non-equivalence:** this is not a refactor. `guardReport(undefined, …)` currently returns
`reporting:false, condition:"no-observation"`; under the mutant it returns `reporting:true`. A guard
that never ran would report as if it had a current reading — the incident, one level up. The
behaviour differs on an input the suite already constructs, so the mutant is a real defect and not an
equivalent rewrite.

## THE POINT OF THE EXERCISE

The mutation empties the `nonReporting` partition. So the prediction is a SPLIT, and the split is the
whole claim:

**PREDICTED TO PASS — VACUOUSLY, asserting nothing (these are the cells the pins were added for):**

- `every NON-reporting state renders a line saying health was NOT established`
- `no NON-reporting state renders as if it were current`

Both are `.every()` over what has become an empty set. They go GREEN over a guard that has stopped
refusing entirely. **If the pins were absent, this mutant would be partially invisible in exactly the
region the file exists to police.**

**PREDICTED TO FAIL — the new pins, which are what notice:**

- `the NON-reporting partition is non-empty and pinned` (3 → 0)
- `the REPORTING partition is non-empty and pinned` (3 → 6)

**PREDICTED TO PASS, and this one is a WEAKNESS I am naming rather than hiding:**

- `the two partitions exhaust the set — no state escapes both properties` — 0 + 6 = 6 still holds.
  The exhaustion check is a consistency property, not a vacuity guard, and it does not detect this.

**ALSO PREDICTED TO FAIL** (the direct cells; they show the mutant is loud in general, which is why
the split above matters — the pins' value is specific to the `.every()` cells, not to the file):

- `no-observation: a guard that never ran does NOT report`
- `no-observation: and it names that condition specifically`
- `no-observation: its detail says this is not a statement about the daemon`
- `guard-stale: a reading past the freshness bound does NOT report as current`
- `guard-stale: and it names that condition specifically`
- `guard-stale: the stale reading was SERVING, and it is STILL refused — the guard's own silence outranks a good last look`
- `guard-stale: it carries the age and the bound it exceeded, not just the fact that it did`
- `guard-clock-fault: a backwards clock does NOT report`
- `guard-clock-fault: and it names that condition rather than lease-stale or no-observation`
- `guard-clock-fault: THE AGE IS NOT CLAMPED TO ZERO — a clamp would render stale evidence as fresh`

Recovery is `git checkout`, not the tool: the tree was committed at `12df829c` before mutating.
