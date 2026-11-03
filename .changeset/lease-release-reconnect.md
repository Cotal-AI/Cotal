---
"@cotal-ai/manager": patch
---

A clean manager stop that starts while the broker connection is reconnecting now keeps trying to release its liveness lease for up to 5 s, instead of giving up after one 2 s read. An immediate same-root restart no longer waits out the rest of the lease TTL after a short outage. When the broker still does not answer, the stop prints the reason and leaves the lease to its TTL.
