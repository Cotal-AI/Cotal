---
"@cotal-ai/core": patch
---

Reopen the derived membership-feed KV and rearm existing membership watches after an endpoint reconnect. The feed handle and watch iterator are connection-scoped: retaining either old epoch made membership reads fail with `closed connection` or left an existing dashboard watch silently stale while the endpoint's other planes had recovered. Replaced or stopped watches delete their ordered broker consumer rather than leaving it until the inactivity threshold; terminal self-heal records the predecessor identity and deletes it through the fresh connection; caller stop is awaitable and endpoint shutdown waits for any cancellation before draining the connection.
