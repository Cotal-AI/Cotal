---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
---

Add distinct keyed workflow submission and caller-confined status contracts, immutable admission-store bindings, bounded original-callback admission attempts and pinned client helpers. Preserve legacy run-start behavior and retain incomplete submissions without later repair.
Keyed requests carry a deadline of at most 30 seconds, measured on the receiving process's
monotonic clock from the new `EpServeContext.receivedAtMonotonicMs`, with the caller's authority
expiry checked on the wall clock. Launch capacity is reserved before the binding, an unfingerprintable keyed request no longer stops the issuer's observation reader, and
the client helpers refuse a reply for other submission coordinates.
