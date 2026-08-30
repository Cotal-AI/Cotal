---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Spawn failures return the lifecycle facts the manager already had (blocked op, head state, opId, remedy) instead of a connector timeout or opaque string.
