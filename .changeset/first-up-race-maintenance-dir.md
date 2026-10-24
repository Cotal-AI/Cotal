---
"@cotal-ai/workspace": patch
---

Two first `up`s started together in a fresh folder no longer let the loser fail with a raw `EEXIST`
on `.cotal/maintenance` and an unknown outcome. Both create that folder safely, and the loser refuses
`LIFECYCLE_BLOCKED` naming the other command's pid, as documented.
