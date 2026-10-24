---
"@cotal-ai/cli": patch
---

`backup create --store-dir` naming a folder that is not the cut's preserved store, such as an empty
one, now refuses `CONFLICT` and names both stores, with the way out. It was reported as an
ineligible cut with a maintenance next step.
