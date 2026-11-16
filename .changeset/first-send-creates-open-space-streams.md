---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

The first `cotal send` to an open space that runs elsewhere is now stored. The one-shot sender consumes nothing, so it never created the space's streams, and the send exited 3 with `OPERATION_UNKNOWN` until a chat session had started there. `send` now creates them before it publishes, as a chat session does. A space this machine started whose streams are gone still refuses with `TARGET_UNAVAILABLE`. The endpoint gains `ensureOpenSpaceStreams()`.
