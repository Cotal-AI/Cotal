---
"@cotal-ai/core": patch
---

Report which bind went stale when a class-queue split is recovered, and grade the describe/invoke
probe's forced arm on the caller-visible contract.

`split-recovered` carried `servedBy`, the incarnation that answered, without `boundTo`, the one the
handle thought it was addressing. A listener could therefore see that a split had been recovered but
not which bind went stale, which is the difference between one handle to drop and a class that is
churning. Both halves of the fact are now on the event.

The probe's forced arm previously required the repair to land, which asserts a coin comes up heads:
core repairs a bind refusal exactly once and lets a second refusal surface, while in a two-manager
space roughly half of all class-queue calls split, so the re-issue goes back through the same queue
and is split again about half the time. That second refusal is a correct and conclusive outcome, and
grading it as a failure reddened the suite on runs where the property it exists to protect held
completely. The arm now accepts either face: the repair landed exactly once, or it was refused again
and stated that nothing ran.

Accepting an absence of effects requires proving the arm could have produced one, so a positive
control on the arming runs before any question about the outcome. The forcing writes a bind naming no
live incarnation; the control reads it back through a fresh cache lookup, proving the entry the
client sends from was mutated rather than a copy, and requires the first refusal to name that bind.

Without it the ambient system supplied the signal. The probe's space splits naturally about half the
time, so a run that forced nothing still saw a refusal, a repair, and a second refusal naming a
different instance: every symptom of the case under test, produced by the ordinary race. Measured
with the forcing removed, the arm passed 4 of 6 runs. With the control it is caught 6 of 6. Reading
the first refusal's bind is what required it on the event, because once the repair re-issues, the
error the caller ends up holding names the second refusal and not the first.
