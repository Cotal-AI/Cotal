---
"@cotal-ai/cli": patch
---

`up -f` on a root that holds a stack preserved by `down --preserve-state` now refuses
`LIFECYCLE_BLOCKED` (exit 2) and names bare `cotal up`, which resumes it. It reported an unknown
outcome (exit 3) with no next step, although nothing had started.
