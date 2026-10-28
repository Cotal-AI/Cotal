---
"@cotal-ai/lang": patch
---

Derive `Frame.depth` and `EngineFrame.depth` from `keys.path.length` as a getter instead of storing a separate constructor field and incrementing it alongside `keys.branch`.
