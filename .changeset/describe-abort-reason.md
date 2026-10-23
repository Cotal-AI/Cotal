---
"@cotal-ai/core": patch
---

A `resolveService` or `describeEndpoint` call whose signal aborts while the describe waits for its
reply now rejects with the signal's reason, as an abort before the describe or between store reads
already did. It used to reject with an `unavailable` envelope error, the code a real transport
failure carries, so a caller could not tell a cancellation from an outage. A signal that aborts
with a `TimeoutError` still reports the unanswered describe deadline.
