---
"@cotal-ai/core": patch
---

Add a client endpoint entrypoint that shares the existing implementation without eagerly loading operator provisioning, agent-file parsing or snapshot transfer modules. Preserve the root API and existing validation behavior.
