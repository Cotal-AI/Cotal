---
"@cotal-ai/core": patch
---

A presence writer refuses an `activity` or `attention` that is not a string, and a `condition` that does not encode as a JSON object with a string `code`, before it stores the row. The condition it stores is that encoded object, so a value that prints a string `code` and serializes to something a reader drops cannot make later heartbeats unreadable. `null` still clears a condition, and a string value is stored as given.
