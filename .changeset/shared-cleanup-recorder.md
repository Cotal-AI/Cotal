---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

The CLI and the manager now share one cleanup recorder, so a change to how a caught value becomes text or how a partial rollback is reported is made once.
