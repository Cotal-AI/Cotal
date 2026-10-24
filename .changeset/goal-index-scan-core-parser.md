---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The remote manager's goal-index scan checks each returned entry with core's goal-index entry parser instead of its own copy, so a refused entry names the field at fault and a field core accepts is never refused by the scan. Core's parser now also refuses an entry with an empty coordinate, which the scan copy already refused.
