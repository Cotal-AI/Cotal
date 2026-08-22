---
"@cotal-ai/core": patch
---

Reopen the derived membership-feed KV and rearm existing membership watches after an endpoint reconnect. The feed handle and watch iterator are connection-scoped: retaining either old epoch made membership reads fail with `closed connection` or left an existing dashboard watch silently stale while the endpoint's other planes had recovered.
