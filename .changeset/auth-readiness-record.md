---
"@cotal-ai/cli": patch
---

When the user-auth service fails its readiness wait, the error now always carries the provider's reason and names the pidfile the wait read. Before, if a pre-upgrade pidfile spelling appeared beside the record during the wait, an "ambiguous auth-service record" error replaced the reason. If the record was renamed during the wait, the message named a file the wait never read.
