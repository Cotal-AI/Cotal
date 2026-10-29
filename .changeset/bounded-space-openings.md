---
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/delivery": patch
---

Bound concurrent multi-space lane startup to four opens, preserving connection budgets and reading the current manifest before each batch. Report queued lanes separately from retries and overdue opens.
