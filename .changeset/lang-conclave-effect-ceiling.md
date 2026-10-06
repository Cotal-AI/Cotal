---
"@cotal-ai/lang": patch
---

A `conclave` now counts toward a run's `effectCeiling` (L4009). Opening one is a dispatch against the world, but it was counted neither by the live counter nor by the journal tally a resume seeds that counter from, so a program whose only effect was `conclave` could open any number of them, live or across a resume, without reaching the ceiling. It is counted once, before its entry begins, on both engines, and a resumed run reaches the ceiling at the same step as a fresh one. `spec/cotal-lang.md` §8.3 no longer excludes it.
