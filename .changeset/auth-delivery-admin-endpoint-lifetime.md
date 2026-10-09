---
"@cotal-ai/auth": patch
---

`cotal actor revoke` now mints its live-connection eviction credential with a 60 second lifetime instead of the supervisor profile's 24 hour default. The revoke-time eviction, the barrier evictors and the liveness oracles that call the delivery daemon's `ctl.delivery-admin` rail now share one connection helper, so the lifetime and the non-participating endpoint options are decided in one place.
