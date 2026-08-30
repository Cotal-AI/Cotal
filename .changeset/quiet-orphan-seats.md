---
"@cotal-ai/manager": patch
---

Prevent manager succession from proceeding over seats whose process exit was not verified. Normal shutdown now waits for every managed seat to exit before releasing manager authority, and crash recovery verify-evicts an orphaned static seat before retiring its lifecycle and freeing the alias.
