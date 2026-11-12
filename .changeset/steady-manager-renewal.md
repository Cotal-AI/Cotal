---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Keep manager requests flowing while its remote serving credentials renew. Bind the replacement connection before draining the old one, and use incarnation-scoped queues to prevent duplicate execution during the handoff without widening permissions.
