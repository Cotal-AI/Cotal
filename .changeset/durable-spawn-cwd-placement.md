---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/core": minor
---

A durable spawn can name a physical working directory with `cwd`, pinned to one manager instance through an explicit placement target. The directory is resolved on the manager that will host the seat, journalled with the spawn step, and hashed into the step identity, so a retargeted replay diverges instead of moving a live seat. Logical `worktree` keeps its meaning and its exclusivity.
