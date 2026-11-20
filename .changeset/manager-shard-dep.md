---
"@cotal-ai/manager": patch
---

Credential renewal reads the delivery shard through its deps instead of importing the Manager class, so the manager module is no longer part of an import cycle.
