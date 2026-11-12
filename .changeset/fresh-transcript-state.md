---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-opencode": patch
---

Refuse event-enabled startup when a fresh state root reuses a principal with retained transcript frames and no local acknowledged frontier. OpenCode waits for the mesh join before announcing its managed session. Existing append expectations and broker permissions are preserved.
