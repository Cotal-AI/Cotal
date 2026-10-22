---
"@cotal-ai/manager": patch
---

`cotal up` relaunches a controller stack's manager after the manager was killed. The killed manager left its PID record behind, and the new manager, which claims that record create-only, exited before readiness, so `up` reported a partial start. The manager adapter now removes a record whose pid is dead before it launches the new manager. A live, foreign or unreadable record still refuses.
