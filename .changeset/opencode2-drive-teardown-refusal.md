---
"@cotal-ai/connector-opencode": patch
---

The OpenCode 2.x adapter no longer starts a turn once its teardown has begun. A message handled after the disposer started, or a drive waiting on session creation when it started, used to be submitted to OpenCode as a new turn whose batch was never acked because the seat was going away. `drive` now refuses on entry and again after the session await, as the 1.x adapter does.
