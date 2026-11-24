---
"@cotal-ai/runtime": patch
---

`run show` checks its journal limit before suggesting how to look up a run ID, so the suggested read no longer repeats an incompatible limit and JSON format.
