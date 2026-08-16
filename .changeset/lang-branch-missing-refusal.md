---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Refuse a migration or fork walk into a recorded branch the edited source renamed away (L5022).

A migration walks the RECORDED WINNING branches of a settled `race` or `parallel`. The branch
digest deliberately covers the losers only, on the argument that the walk enters the winner, so an
edit there diverges at the step it broke rather than at the whole scope. A rename removes the arm,
so there is no step left to diverge at and that argument stops holding.

The failure was not a silent pass. `race` filtered the source's arms down to the recorded winner,
got an empty list, and awaited `Promise.race([])`, which never settles: a migration or a fork over a
renamed winning arm returned no verdict at all — measured at a 2s cap with nothing thrown, nothing
reported, and the ordinary resume of the same source returning OK. `parallel` did not hang, because
`Promise.all([])` resolves, and handed the program back the recorded value keyed by an arm the
source no longer declares.

Both now refuse with `L5022 A recorded branch is not in the migrated source`, naming the missing
arm, the scope, and the arms the source does declare — the repair is a NAME, and a refusal that said
only "this scope diverged" would send an author into an arm's body, the one place nothing changed.
`migrateRun` reports it through `unwalkable`; `planFork` refuses with its own code rather than
L5014's, because a conclave the walk cannot enter and a branch that is gone need opposite repairs.

Every neighbouring edit keeps the answer it had: a renamed or deleted LOSER still diverges through
the branch digest, and an arm the edit ADDED still walks to completion.

Known and unchanged: an ordinary RESUME of the same renamed source is still silent. Resume mode
consumes a settled scope wholesale without entering an arm, which is its documented behaviour, and
the thing that would refuse edited source there is a program-hash pin the run record does not carry
yet.
