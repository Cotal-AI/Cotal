---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

Keep hosted Manager registration cleanup recoverable after a local space is removed. Save the original authority and instance identity without copying credentials, retain pending and unknown outcomes across restarts and uninstall, and never automatically repeat an unconfirmed removal.
