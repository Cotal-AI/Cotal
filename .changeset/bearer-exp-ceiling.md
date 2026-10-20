---
"@cotal-ai/auth": patch
---

Bound an exchanged bearer by its IdP proof's expiry at signing time. The exchange now carries the proof's absolute `exp`, and a `session-caller` session's `exp`, through the credential hook to the issuer, which signs the earlier of `now + ttl` and that ceiling and refuses once it has passed. A slow `mintConnectCredential` hook could previously push the bearer, and the NATS user JWT the callout mints from it, past the proof's expiry, or mint a bearer after the proof had expired.
