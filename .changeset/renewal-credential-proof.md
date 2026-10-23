---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

`ServiceEndpointRenewal.credential()` answers `ServiceEndpointCredential`: the validated `credential` result without `renewalProof` and `renewalExpiresAt`, which never leave the source, as a copy per caller. `authorizeGuestServeGrant` takes that type; it reads no renewal field. `credential()` is a required member of the interface, so an out-of-tree implementer adds it.
