---
"@cotal-ai/lang": patch
---

Preserve foreign thrown values' names and messages consistently across worker execution, inspection and the effect bridge.
Keep messages string-valued even when an Error's message property was changed to a non-string value.
