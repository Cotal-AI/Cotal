---
"@cotal-ai/manager": patch
"@cotal-ai/core": patch
---

Prevent two broker owners during manager succession. Normal shutdown now requires authoritative seat exit proof before releasing manager authority, and crash recovery verify-evicts an orphaned static seat's broker principal before retiring its lifecycle and freeing the alias.
