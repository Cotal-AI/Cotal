---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

A sign-out whose discovered-space cleanup fails after the cached login was removed reports the login as cleared again. It had started to report that local cleanup was not confirmed. The daemon also declares the skipped Manager services list that its sign-out result already carries.
