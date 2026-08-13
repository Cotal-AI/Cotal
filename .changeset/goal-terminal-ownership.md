---
"@cotal-ai/manager": patch
---

Derive the right to settle a goal from winning its claim, instead of tracking it with a flag.

`serveSpawnGoal` used one boolean, `terminalEntered`, to answer two different questions: has this
goal already been settled, and may this attempt settle it. The second is an authority question and
the flag defaults to the permissive value, so every way of leaving the accept path was opted **into**
committing a terminal unless someone remembered to claim it by hand. That is how a duplicate-goal
loser came to commit `failed` on the winner's goal (#357), and the fix for it had to add two more
hand-placed claims, which is the same shape again.

An attempt now earns `ownsGoal` by winning the create-only `bindGoal` CAS, and the single commit path
refuses anything else. Both loser branches drop their hand-placed claims: a losing attempt cannot
commit down any unwind path, including ones added later that never considered this.

`terminalEntered` keeps its own job, which is stopping a second settle behind a despawn that owns the
outcome.

This also closes a coverage gap rather than arguing it away. The sibling-instance branch (a foreign
manager already recorded the goal) previously needed its own guard, and mutation-testing that guard
killed no check because the duplicate-goal test races a single manager. There is now one enforced
check covering both branches, and removing it reddens that test: 33 passed / 2 failed, the same two
cells, as predicted before running.

The sibling route is also driven directly now, by a new suite `smoke:goal-sibling-race`: two managers
in one space, one request frame delivered to both, with A's goal deliberately left in flight so a
stolen terminal has something to destroy. Removing the fence makes B commit `failed` on A's goal,
and the recorded committer is B's instance id while the message names A's, which is what makes the
attribution unambiguous.
