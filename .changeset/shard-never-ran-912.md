---
---

Test-only: `bin/smoke/shard.mjs` breaks at its first red smoke and, until now, said nothing about
the rest of its partition - a reader had to diff the shard's own startup plan against its banners
by hand to learn that 88 of 385 suites never started at one measured head. The break path now
prints an explicit "NEVER RAN" block naming every unexecuted suite, via a new pure helper
(`bin/smoke/shard-never-ran.mjs`, gated as `smoke:shard-never-ran`, appended to the chain so no
existing suite's shard assignment moves). All the changed files are CI tooling, so no shipped
behaviour changes and no release.
