---
"@cotal-ai/manager": minor
---

Add explicit pooled `ManagerOptions.execution: "none"` with no Runtime object, early seat and workflow refusals, and immutable per-instance execution admission. Native control registration, renewal, goal recovery and maintenance remain available. Genuine selected participant Managers keep their own execution and terminal custody. Default runtime behavior is unchanged.

Manager cluster revision 25 requires `execution`, `runHosting` and `terminalSessions` in status and adds custody `none`. Callers must fetch the new closed output contract.
