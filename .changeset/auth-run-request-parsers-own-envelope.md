---
"@cotal-ai/auth": patch
---

The run attempt and run revoke parsers now parse their own registered-manager envelope. They used to rewrite the request into a run admission with a placeholder `run` and hand it to the admission parser. A `manager-run-attempt` that carries a `run` field is now refused as an unknown field, where it was accepted and the field dropped. Attempt and revoke refusals name their own kind and carry the `manager run attempt request` or `manager run revoke request` prefix. The manager-service authority parser also refuses a `session` request whose `session` carries a key other than `id`, `endpoint`, `sessionId`, `epoch` and `exp`, and returns a session built from the checked fields, where it returned the caller's own object.
