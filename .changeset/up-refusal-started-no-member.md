---
"@cotal-ai/cli": patch
---

A controller `cotal up` refused before any member started said "started members were kept and nothing was retried", which read as if part of the stack ran. When no member started or was reused, it now says the stack started no member.
