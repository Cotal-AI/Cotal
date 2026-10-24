---
"@cotal-ai/cli": patch
---

The detached manager and delivery starters read the child's pid once and use that value for the guard, the pid record and the return. They no longer fall back to pid 0 after the guard, a value a caller would have probed or signalled as its own process group.
