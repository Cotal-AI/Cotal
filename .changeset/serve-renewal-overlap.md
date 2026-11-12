---
"@cotal-ai/core": patch
"cotal-ai": patch
---

A serving endpoint can keep command dispatch across a planned credential swap. With overlapOnConnectionRenewal, the endpoint subscribes on a second connection and flushes it before reconnecting the resident connection. The daemon's machine-status serve uses this. Endpoints that do not set the option still reconnect in place.
