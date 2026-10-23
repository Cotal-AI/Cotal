---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

A managed spawn on a user-auth mesh whose enrollment the host refuses, for example for a role or a
channel beyond the caller's grant, is now reported as refused with `PERMISSION_DENIED` once the
manager has removed the secrets it staged for the agent. It used to be reported as
`OPERATION_UNKNOWN`, although nothing was launched. A host that fails or does not answer still
leaves the outcome unknown.
