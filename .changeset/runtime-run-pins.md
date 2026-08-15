---
"@cotal-ai/lang": minor
---

Pin a run to its resolved seed, logical epoch and limits, and refuse a resume that disagrees.

A run was not pinned by its source alone: the seed decides pure draws, the three limits decide
whether a loop completes or raises, and the clock a resumed run started from was whatever machine
happened to be resuming it. `run()` therefore resolved a default for each of those every time it was
called, so a run resumed on a second host silently re-derived them — and a program that branches on
elapsed time took a branch determined by when someone restarted it, with nothing in the journal
recording that it had.

The resolved values are now a pin set (`seed`, `startedAt`, `yieldEvery`, `stepBudget`,
`effectCeiling`, `languageVersion`) that a fresh run resolves ONCE and hands back on its result, for
the caller to record. Passing them back in binds the resume to them: the interpreter takes every
limit from the pins rather than re-defaulting, the run clock starts at the pinned epoch so `now()`
means the same thing on any host, and `run()` now returns the `startedAt` its own signature already
advertised. A caller that supplies a pin differing from the recorded one is refused with `L5009`
naming the pin and both values, and a journal written under different interpreter semantics is
refused with `L5008`; both codes join the catalog, and `L5005`'s title now says what an author can
do about it. Refusing is the point — honouring the override would make it a different run against a
journal that was not written for it.
