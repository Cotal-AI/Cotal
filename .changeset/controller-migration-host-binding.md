---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Add a retained maintenance-lock check and pre-stop controller identity observation for migration hosts.

The observation binds the controller operation, member launches, broker configuration and store identity without stopping services or admitting a migration. Controller preservation and restore commands remain unsupported.
