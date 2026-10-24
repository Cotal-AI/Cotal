---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

A hosted `cotal run resume` of a run recorded `completed` or `failed` is now refused `LIFECYCLE_BLOCKED` (exit 2), naming the state. Before, it printed "Workflow resumed", exited 0 and drove the finished run again under a new epoch, adding a holder activation row to its journal each time.
