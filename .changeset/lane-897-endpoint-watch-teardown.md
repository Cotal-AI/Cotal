---
"@cotal-ai/core": patch
---

Stop the presence and channel-registry KV watches on endpoint teardown. Each watch binds an
ordered JetStream push consumer whose idle-heartbeat monitor runs on its own timer, independent
of the connection; without an explicit `.stop()` before drain, that monitor keeps trying to reset
the consumer against a draining or closed connection, throwing an uncaught `DrainingConnectionError`
every 30 seconds until the process exits by some other means.
