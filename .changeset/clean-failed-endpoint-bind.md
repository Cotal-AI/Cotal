---
"@cotal-ai/core": patch
---

Close a partially connected NATS transport when an endpoint bind fails, preventing retry loops from leaking one socket per attempt.
