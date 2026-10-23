---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

The service endpoint authority's `GET` answer now carries the issuer identity a guest verifies its access bearer under: `issuer`, the exact `iss` the context mints, and `keys`, the public Ed25519 coordinates of the set `GET /jwks` publishes. `parseServiceAuthorityInfo` reads them as a closed, bounded record and refuses an answer without them, and the auth provider's `serviceEndpointInfo` returns them from the registered space's pinned authority URL, tenant path included, so a service passes that answer to `authorizeGuestServeGrant` as its authenticity with nothing caller-selected. The serving smoke now brands a live credential through the seam against the real door and refuses it under another key for the same kid.
