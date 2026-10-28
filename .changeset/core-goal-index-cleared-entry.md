---
"@cotal-ai/core": patch
---

`recordGoalIndex` now refuses a same-goal record over an entry `clearGoalIndex` already deleted with `failed-precondition`, naming the goal as settled or withdrawn. It used to report that normal end state as store corruption with `internal` and "reconcile the store", which it still does for an absent or purged key.
