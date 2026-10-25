---
"@cotal-ai/cli": patch
---

A manager command whose credential the broker refuses at connect, such as `cotal spawn --on` or `cotal ps --on` on a user-auth mesh whose auth service refuses the issued manager view, is now refused `PERMISSION_DENIED` (exit 2) and says nothing was sent to the manager. It used to end as `OPERATION_UNKNOWN` (exit 3) with only the broker's `Authorization Violation`, which read as a launch that might have happened. The message keeps the broker's reason, and on a user-auth mesh it says the space's auth service logs why. A failure after the request was sent is still reported as unknown.
