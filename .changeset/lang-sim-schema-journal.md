---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Simulator fidelity, ask schema enforcement, journal result bound, and the scope release law.

The simulator is now discrete-event: timed effects park at their wake times and are delivered in
wake order on one virtual clock, so concurrent branches accumulate the durations they wrote and a
simulated race is decided by the same rule as a live handler (least recorded clock, ties by
declaration order) instead of by the order effects were asked.

The reference simulator enforces the ask schema shorthand (spec §6.5): a schema it cannot read is
refused with the new L4022 rather than skipped, a non-conforming reply consumes one attempt, and
exhausted attempts report L4006.

A journal can be constructed with a result bound (`JournalInit.resultBytes`, plumbed through
`DriveRequest.resultBytes`); a settled ok result over it is refused ahead of the settling append
with L5006, which leaves the reserved list.

A host release or refused append inside a parallel, race, fanOut or conclave no longer cancels
sibling branches or settles their in-flight entries cancelled: the unwind propagates bare, the
scope settles nothing, and a resume picks the run up exactly where the journal says it stopped.
The old behavior permanently poisoned any run a driver stopped while an effect was in flight
inside a scope.
