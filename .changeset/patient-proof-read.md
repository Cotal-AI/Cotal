---
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Retry a rate-limited IdP token read once when its advertised delay fits the original timeout. Honor Retry-After and X-Retry-After without replaying Manager startup, authority preparation or any other operation that consumes the proof.
