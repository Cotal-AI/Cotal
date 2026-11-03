---
"@cotal-ai/manager": patch
---

A hosted seat's retirement on a participant now removes the actor token, sentinel credential and health file that its enrollment wrote to the participant's secret store and disk. Before, the host released the grant and the lifecycle retired, but those files stayed behind for every hosted seat, on despawn and on a spawn's orphan rollback. A removal that fails keeps the name held instead of completing the retirement.
