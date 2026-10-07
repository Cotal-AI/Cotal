---
"@cotal-ai/auth": patch
---

The `renew` arm of the manager-service authority now checks the manager gate's owner against the same actor set it mints the supervisor and executor credentials from. It recomputed its own copy before, which only matched because both copies were derived from the same instance id. No behavior changes.
