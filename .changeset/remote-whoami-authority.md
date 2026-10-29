---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Report a remote signed-in user's current read, post, direct-message and capability grant in `cotal whoami`. The stock issuer returns the authoritative grant beside each fresh bearer, while unavailable, refused and older issuers remain unknown instead of being inferred from the token or a successful exchange.
