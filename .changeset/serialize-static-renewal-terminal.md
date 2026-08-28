---
"@cotal-ai/manager": patch
---

Serialize managed-static credential renewal with lifecycle terminalization so an accepted renewal is drained before revocation and cleanup, while renewals arriving after the terminal latch are refused.
