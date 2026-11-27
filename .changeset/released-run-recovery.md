---
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

A manager that stops while it is retrying a released workflow run continues that recovery on its next boot, waits for a rate-limit answer, and stops at once when the authority says the request is not implemented.
