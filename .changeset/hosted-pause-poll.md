---
"@cotal-ai/runtime": patch
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Hosted sleep, checkpoint, and ask steps stop replaying an unchanged journal on empty timer polls. The host uses the run's filtered consumer to detect takeovers and still authorizes each fire and settlement against the current journal.
