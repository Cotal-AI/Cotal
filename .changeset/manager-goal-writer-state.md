---
"@cotal-ai/manager": patch
---

Move the manager's goal-writer state (the goal-writer connection, its identity and credential, the boot goal-index reconcile flag, and the accepted-goal map) from the Manager into the goal writer, which credential renewal, the serve plane, spawn-goal, seat stop and command dispatch now read directly instead of through per-field accessors. Exports, commands and wire behaviour are unchanged.
