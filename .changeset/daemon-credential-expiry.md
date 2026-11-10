---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Daemon service connections now report locally expired credentials instead of an unreachable space or broker.
The renewal source preserves a fixed expiry classification, and the daemon reports `LIFECYCLE_BLOCKED`
with native code `CREDENTIAL_EXPIRED` and a clock-check remedy. Expiry checks and request replay stay unchanged.
