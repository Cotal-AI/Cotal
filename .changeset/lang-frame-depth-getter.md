---
"@cotal-ai/lang": patch
---

Derive `Frame.depth` and `EngineFrame.depth` from `keys.path.length` through a getter instead of storing a separate constructor field and incrementing it in `branch`.
