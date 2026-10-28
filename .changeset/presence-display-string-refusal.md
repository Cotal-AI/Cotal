---
"@cotal-ai/core": patch
---

A presence writer refuses an `activity`, `attention` or `condition.code` that is not a string before it stores the row. A stored object made every later heartbeat of that writer unreadable, so readers dropped the still-heartbeating peer. `null` still clears a condition, and a string value is stored as given.
