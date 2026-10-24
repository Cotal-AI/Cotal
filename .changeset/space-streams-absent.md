---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

After a live `cotal space delete` and before `cotal up`, `cotal history` and `cotal send` on a recorded auth or user space refuse `TARGET_UNAVAILABLE` (exit 2), saying the space's streams are not on its broker and naming `cotal up` in the space's root. History used to read zero messages, and send exited 3 with `no responders`. `chatRetention` also returns whether the chat stream exists.
