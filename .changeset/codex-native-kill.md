---
"@cotal-ai/connector-codex": patch
---

Remove redundant exception handlers around native child cleanup in model discovery and stop escalation. Preserve signal delivery, exit waiting, and the existing cleanup deadlines.
