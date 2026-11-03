---
"@cotal-ai/core": patch
---

`walkKvLatest` and `walkKvEntries` now end their walk only on the `null` the pinned `@nats-io/jetstream` client returns for the stream's "no message" answer (10037). They used to also catch a thrown 10037 and accept an `undefined` answer, neither of which the pinned client can produce. A future client that throws 10037 or answers `undefined` now fails the walk instead of ending it early with a partial result. No behavior changes with the current client.
