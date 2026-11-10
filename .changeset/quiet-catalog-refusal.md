---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

Daemon sign-in and space refresh now identify damaged local caches and explain how to recover.
Sign-in checks both caches before requesting device approval or saving a replacement session.
Malformed provider keys and session records receive the same cache recovery guidance.
