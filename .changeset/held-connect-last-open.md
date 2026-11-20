---
"@cotal-ai/connector-core": patch
---

A held `cotal_connect` no longer asks the host one extra time just after its hold ends. The pause that reaches the deadline is now the last one, so the hold ends with the open that follows it even when that pause's timer fires a little early.
