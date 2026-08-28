---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Account for endpoint-plane streams in backup validation and space teardown, grant their deletion only to the ephemeral teardown credential, and recreate their canonical empty infrastructure during restore.
