---
"@cotal-ai/cli": minor
"cotal-ai": minor
---

On a controller-owned stack, `down --preserve-state`, `backup create`, `backup restore` and `up --restore` now refuse `UNSUPPORTED` (exit 2) while validating, before the confirmation, the connector seed, any write or any manager request, in every stack mode. The remedy names plain `cotal down`, which keeps the stack's store, channels and history for the next `cotal up`. Preserve, backup and restore of a controller-owned stack return in a later release. A root without a stack journal keeps its preserve, backup and restore.
