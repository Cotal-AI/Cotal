---
"@cotal-ai/runtime": patch
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Hosted workflows stop replaying an unchanged journal while they wait for a timer or answer. The host checks the journal tail to detect takeovers and still authorizes each fire and settlement against the current journal.
