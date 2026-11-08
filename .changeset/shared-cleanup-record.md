---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A refused spawn records a failed cleanup step the same way in the CLI and the manager, and both read a caught value through one helper.
