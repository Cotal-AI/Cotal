---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/runtime": patch
"@cotal-ai/delivery": patch
---

Whether a consumer info or delete found no consumer is now decided by one predicate, `isConsumerNotFound` in `@cotal-ai/core`, which accepts only the broker's structured `ConsumerNotFound` error. It no longer accepts a bare `name` of `ConsumerNotFoundError` or a string `code`, so the run journal's replay cleanup no longer swallows those shapes. The stream, KV scan, run wait, delivery `pending` and auth scanner sites use it in place of their own copies, and `isJetStreamMissing`, the structured check it builds on, is exported beside it.
