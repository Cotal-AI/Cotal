---
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Manager-service retirement now checks the host current-registration proof against the observed manager gate, so a later registration revision is refused. Callers send the proof activation returned instead of the lifecycle digest.
