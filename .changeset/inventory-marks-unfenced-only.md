---
"@cotal-ai/core": patch
---

The delivery daemon keeps its in-memory retirement mark only for a `lifecycleMemberships` inventory whose caller did not fence the lifecycle's read-ACL row first. A fenced or retired row refuses every later durable join by itself, so such an inventory leaves no mark; before, every retired alias that never retired again kept one entry per space lane until the daemon restarted. An inventory from a manager that does not fence is marked as before.
