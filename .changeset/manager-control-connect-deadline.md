---
"@cotal-ai/connector-core": patch
---

Allow manager control connections to use the caller’s remaining preparation deadline instead of timing out after two seconds. Preserve cancellation and refuse an expired preparation before opening the connection.
