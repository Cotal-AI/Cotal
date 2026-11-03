---
"@cotal-ai/auth": patch
---

A failed auth-service start now logs an authority-plane close failure through its diagnostic sink while preserving the original startup error. A refused or unreachable plane-claim release is no longer silently discarded.
