---
"@cotal-ai/core": minor
---

Add `authorizeGuestServeGrant`, the guest-side reconstitution seam SPEC §13.6 calls for: a service that registered through the service door turns its parsed `credential` result and its own embedded contract closure into the process-local serve grant `serveEndpoint` consumes, with no store access. It proves the binding before it brands: the witness names the pinned account, the access bearer's EdDSA signature verifies under the pinned issuer's published key and its closed claims name this issuer, space, owner, the serve duty and exactly this witness, the host's closure set and artifacts are the embedded ones byte for byte, and every closure verifies as manifest and root. The store-backed `authorizeServeGrant` and the host-only `authorizeTrustedServeSnapshot` are unchanged; the §13.7 surface read `authorizeServeGrant` runs is one function now, shared with the seam.
