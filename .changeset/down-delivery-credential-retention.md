---
"@cotal-ai/cli": patch
---

Preserve delivery credentials when a required whole-stack shutdown stop fails. Remove them only after all required stops succeed, without changing selective delivery teardown.
