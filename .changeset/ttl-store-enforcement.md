---
"@cotal-ai/core": patch
---

Verify reconciled presence and lease TTLs with an expiring canary instead of trusting the broker's in-memory stream configuration. `cotal up` now reports a named persistence failure when a server accepts `max_age` but its backing store does not persist or enforce it.
