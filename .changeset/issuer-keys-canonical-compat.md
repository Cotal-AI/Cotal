---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

The service authority's published keys are checked as canonical full-order Ed25519 points on the door, in `parseServiceAuthorityInfo` and in the guest seam, so a key of small order or non-canonical encoding is refused rather than letting a signature no private key made verify. The info parser accepts a door that predates the issuer identity, answering the four account fields alone, so a newer client and an older door no longer refuse each other; `serveAuthenticityOf(info)` builds the seam's authenticity from the answer and refuses when the identity is absent. The door refuses to publish more than 16 keys.
