# Mutation result — MY PREDICTION WAS REFUTED, and the pins are NOT proven

Run at `12df829c`, Node v22.23.2. Predictions in `.lane/partition-pin-predictions.md`, written first.

## THE HEADLINE: the claim I made for the pins is unproven

I predicted a SPLIT — that the two `.every()` cells over the emptied partition would pass vacuously
while the new pins failed, demonstrating the pins detect something the `.every()` cells miss.

**No such split was observed, because the suite CRASHED before reaching any of those cells.** The
mutant died at `packages/core/src/health.ts:135` (`if (h.serving)` on an undefined `h`) during
`every state renders a non-empty line`, which is the cell immediately BEFORE the partition pins.
**The pins, and the two cells they were added to protect, never executed.**

Red, but red for a reason unrelated to the property under test. An unrelated early failure is also
red, and this is one. **I do not get to count this as a kill for the pins.**

## Worse for my claim: the scenario the pins defend against may be UNREACHABLE

Working out why it crashed rather than going vacuously green: emptying `nonReporting` requires all
three refusal branches to report, including `no-observation` — and that branch has **no observation
to report**, so any record it fabricates carries `health: undefined` and `renderGuard` throws on it.

So in the "reporting became unconditionally true" world, this file goes **RED BY CRASH**, not
green-by-vacuity. The silent vacuous pass I added the pins to prevent **is not reachable by mutating
the current implementation**, because the renderer dies first.

**Therefore the honest status of the three new cells is: cheap, correct, and UNPROVEN.** They pin an
invariant that the current code shape cannot violate quietly. They are insurance against a future
refactor that gives the no-observation branch something renderable to hold — at which point the
vacuity becomes reachable and silent. That is a real risk and not an imaginary one, but it is a
FUTURE risk, and I am not entitled to describe the pins as catching a defect today. The commit
message for `12df829c` claims more than this measurement supports and the overclaim is recorded here
rather than quietly left standing.

## What the mutant DID prove (this part is a clean kill)

Ten cells failed BY NAME, exactly as predicted, before the crash:

    no-observation: a guard that never ran does NOT report
    no-observation: and it names that condition specifically
    no-observation: its detail says this is not a statement about the daemon
    guard-stale: a reading past the freshness bound does NOT report as current
    guard-stale: and it names that condition specifically
    guard-stale: the stale reading was SERVING, and it is STILL refused …
    guard-stale: it carries the age and the bound it exceeded, not just the fact that it did
    guard-clock-fault: a backwards clock does NOT report
    guard-clock-fault: and it names that condition rather than lease-stale or no-observation
    guard-clock-fault: THE AGE IS NOT CLAMPED TO ZERO — a clamp would render stale evidence as fresh

And the INVERSE CONTROLS stayed green under the same mutant — `a CURRENT reading of a DEAD daemon
still REPORTS`, `guard-stale inverse control: exactly AT the bound still reports`, and the three
`observeOnce` cells — so the mutation is discriminating rather than reddening everything it touches.

Restore was `git checkout --` (git as the recovery, not a saved copy), verified: **28/28 rc 0**.

## A SECOND INSTRUMENT ERROR, same family as the pipe error

My mutation step printed `mutated sites: 4` from
`grep -c 'reporting: true,' "$G"` — run AFTER the substitution. That counts occurrences of the
POST-state, which includes **`:113`, a site that was already `reporting: true,` before I touched
anything**. Only 3 sites were actually mutated. The number I printed did not measure the thing its
label claimed.

Two lessons, both already written in this lane's standing rules and both walked into anyway:

1. **The number reported was not the number measured** — the pipe error's family, one week's worth of
   a different mechanism. A count of the post-state is not a count of the change.
2. **The pattern also matched TYPE DECLARATIONS.** `reporting: false` appears at `:49`, `:54`, `:69`
   as union members. Those were spared only by an accident of punctuation — my pattern required a
   trailing comma and the declarations end in semicolons. **A positive control proves a pattern CAN
   match something, not that what it matched is CODE**, and here the pattern would happily have
   rewritten three type declarations if the file had used different separators.
