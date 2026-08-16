---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

A run can now be forked from a named step: the §8.5 cut, and the refusals that keep it honest.

`planFork` computes the cut by a dry walk over the recorded journal and stops before the step it was
asked to cut at, because the child re-runs that step and a prefix containing it would replay the very
work the fork exists to redo. The walk runs in migration mode, and that is the load-bearing part: a
resume's replay short-circuits a settled scope, so a cut inside one is never reached and the prefix
silently becomes the entire journal. The suite runs the wrong walk on purpose and shows the answer it
gives, so the claim is a comparison rather than an assertion about intent.

The child inherits the parent's pins verbatim. A run's seed defaults to its id, so a child that
resolved its own pins would be reseeded — and a reseeded prefix redecides every pure draw inside
history it was supposed to be copying, with nothing diverging to say so.

`commitFork` copies the prefix onto the child's run and writes the child's record last. A crash
between the two leaves journal entries under an id with no record, which neither `startRun` nor
`driveRun` will touch; the other order would leave a run a driver takes over with half a history.

Refused rather than approximated: a step the journal never recorded, a step this program never
reaches, a source that diverged before the cut, a fork asked to pin a new program hash (a run's spec
carries none), the fork's own worktree branches (there is no worktree plane here), and a cut
containing a `spawn`, which §8.5 would have to respawn or adopt at the frontier. The child's record
cannot yet say it is a fork of anything, and `commitFork` reports that gap rather than leaving a
reader to notice it.
