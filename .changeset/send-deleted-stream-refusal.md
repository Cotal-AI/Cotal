---
"@cotal-ai/cli": patch
---

Refuse sends before publication when the space's streams are confirmed missing, with guidance to recreate them empty. Preserve unknown outcomes for attempted publications whose storage acknowledgement was lost, and never retry them automatically.
