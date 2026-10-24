---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/manager": patch
---

`run show` names the branch a settled `race` took, and marks `not acted on` an answer whose step was in a losing branch, or whose pause was cancelled after accepting it. Such an answer used to be listed as acted on, or not at all. The journal rows carry the race's `winner` and each losing step's `lostRace` in `--json`.
