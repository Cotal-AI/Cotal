---
"@cotal-ai/cli": patch
---

Keep post-start manager and auth-service errors bound to the pidfile path used for the readiness decision, preserving the original failure when record spellings change.
