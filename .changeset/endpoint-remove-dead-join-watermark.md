---
"@cotal-ai/core": patch
---

Remove the dead chat join-watermark branch from `CotalEndpoint.pump` along with `dropWatermark` and the `joinSeq` map that remained after the per-instance chat durable was removed, while keeping `armJoin` returning the per-channel CHAT stream frontiers for `backfillArmed`.
