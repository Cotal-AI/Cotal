---
"@cotal-ai/runtime": patch
---

`run show` on a run that failed outside any step no longer follows the cause its status recorded
with a line saying no journal row records why. That line now shows only when the status recorded
no cause either.
