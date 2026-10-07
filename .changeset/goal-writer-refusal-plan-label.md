---
"@cotal-ai/manager": patch
---

The manager's refusal of a superseded incarnation's goal terminal no longer cites an internal plan label. The error, logged as `! goal terminal commit for <goalId> failed: ...`, now ends with `a superseded incarnation never commits a goal terminal (SPEC 13.6)`. Its code is still `expired`. The goal-writer comments in the manager name the mechanism they describe instead of the plan item.
