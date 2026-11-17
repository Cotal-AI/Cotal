---
"@cotal-ai/core": patch
---

Keep expected membership reconnects from producing false incomplete-census warnings. A sweep that started while the feed's data connection was down remains incomplete even if that connection returns before the sweep finishes.
