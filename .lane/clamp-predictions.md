# The `Math.max(0, …)` age clamp — predictions registered BEFORE the fix

Found by review (`fmh-rev-health` finding 3, and predicted as a hypothetical by `fm-health-2`
before anyone located it in source). Re-derived by me at `dabb038d` before accepting either.

## The defect

`packages/core/src/health.ts:51`

    ageMs: Math.max(0, observedAt - evidenceAt)

`evidenceAt` is a FOREIGN clock — written by the daemon into the lease, read by us. When that clock
runs ahead of ours the subtraction is negative and the clamp reports `ageMs: 0`.

**`ageMs: 0` is exactly what a live responder round-trip produces** (`health.ts:204`,
`fact(answered - started, "responder-roundtrip", answered, answered)`). So arbitrarily stale
evidence becomes byte-indistinguishable from an affirmative answer that arrived just now.

The comment directly above the clamp says *"a record stamped in the future is a clock fault, not
negative age."* The code NAMES the fault and then SWALLOWS it. The defensive clamp IS the bug: a
degraded input that does not degrade the claim, inside the envelope built to stop exactly that.

## Why it is a false GREEN and not merely a cosmetic age

`health.ts:171`

    if (heartbeat.ageMs > ttlMs)   // -> refuse as lease-stale

With the clamp, a forward-skewed lease yields `0 > ttlMs` = **false**, so the `lease-stale` refusal
never fires. **The clamp does not just misreport the age; it defeats the staleness check that the
age exists to drive.** A lease of any age passes the TTL gate if its writer's clock is ahead.

## Predicted NAMED cells — registered before the fix, never a count

After the fix these cells must exist and PASS:

  C1  `CLOCK-SKEW: evidence stamped in the future does not render as age 0`
  C2  `CLOCK-SKEW: the fact reports that its age could not be established`
  C3  `CLOCK-SKEW: the fact carries the measured skew, so a reader can see how far ahead`
  C4  `CLOCK-SKEW: a lease whose writer clock is ahead REFUSES rather than passing the TTL gate`
  C5  `CLOCK-SKEW inverse control: the same lease with a sane clock is SERVING`

C5 is the control that makes C4 mean anything. **What would refute this whole item:** if C5 also
refuses, then the fix rejects healthy input and the arms cannot differ, so C4 would prove nothing.

## Non-equivalence of the mutant

Reverting the fix (restoring `Math.max(0, …)`) must turn **C1, C2, C3 and C4** red while **C5 stays
green**. If C5 also flips, the two arms are not independent and the cells are not measuring what
they claim. If only C1 reddens, the fix is cosmetic and has not reached the TTL gate at line 171,
which is the half that actually causes a false green.

## Provisional, and flagged rather than decided

Which refusal ARM a clock fault belongs in is **not settled**. `fmh-rev-health` has a BLOCKING
finding open that the five-member union is neither closed nor coherent, and no ruling has come
back. I am therefore NOT adding a sixth arm unilaterally. This change makes the code stop lying and
names the condition in the refusal `detail`; the arm placement is provisional and is raised with
the reviewer rather than settled here.

## Not measured

Whether any consumer outside this lane reads `ageMs`. Inventory at `dabb038d`: four render sites
and one comparison in `health.ts`, four assertions in the assessment smoke, all in this lane.
