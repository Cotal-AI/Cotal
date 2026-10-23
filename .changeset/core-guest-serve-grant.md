---
"@cotal-ai/core": minor
---

Add `authorizeGuestServeGrant`, the guest-side reconstitution seam SPEC §13.9 calls for: a service that registered through the service door turns its parsed `credential` result and its own embedded contract closure into the process-local serve grant `serveEndpoint` consumes, with no store access. It proves the binding before it brands: the witness names the pinned account, the access bearer names the same witness and the serve duty, the host's closure set and artifacts are the embedded ones byte for byte, and every closure verifies as manifest and root. The store-backed `authorizeServeGrant` and the host-only `authorizeTrustedServeSnapshot` are unchanged; the §13.7 surface read they share is one function now.
