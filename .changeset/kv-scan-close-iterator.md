---
"@cotal-ai/core": patch
---

`liveKvEntries` now closes its scan iterator with a plain `await iter.close()`. It used to test for `close` at runtime, fall back to `stop()` when it was missing, and discard any rejection, none of which the pinned `@nats-io/jetstream` client can produce. A future client that drops `close` or rejects from it now fails the scan instead of being silently tolerated. No behavior changes with the current client.
