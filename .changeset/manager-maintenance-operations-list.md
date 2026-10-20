---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

`@cotal-ai/core` exports `REMOTE_MANAGER_MAINTENANCE_OPERATIONS`, the frozen list of manager-service maintenance operations, and `RemoteManagerMaintenanceRequest["operation"]` is derived from it. The auth maintenance request parser checks the operation against the same list and builds its refusal from it, so an operation added to core is admitted by the host instead of compiling cleanly and being refused at runtime with the old pair. The refusal now reads `operation must be one of evict-family-principal, reconcile-registration`.
