---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

The service endpoint authority's `GET` answer now carries the issuer identity a guest verifies its access bearer under: `issuer`, the exact `iss` the context mints, and `keys`, the public Ed25519 coordinates of the set `GET /jwks` publishes. `parseServiceAuthorityInfo` reads them, when answered, as a closed, bounded record, and the auth provider's `serviceEndpointInfo` returns them from the registered space's pinned authority URL, tenant path included, so a service passes `serveAuthenticityOf(info)` to `authorizeGuestServeGrant` as its authenticity, built from the door's own context. A door that predates the identity still parses, and a guest that needs it refuses to serve. Every key is checked as a canonical full-order Ed25519 point on the door, in the parser and in the seam, so a small-order key cannot make a signature no private key produced verify. The serving smoke now brands a live credential through the seam against the real door and refuses it under another key for the same kid.
