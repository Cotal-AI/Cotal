---
"@cotal-ai/core": patch
---

Treat a CONSUMER.DELETE timeout during membership-watch disarm as best-effort cleanup: catch it, emit an endpoint error, and continue. A live observer over a slow link must not die because cleanup did not answer in time.
