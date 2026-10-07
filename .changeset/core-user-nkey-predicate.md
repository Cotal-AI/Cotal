---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

`@cotal-ai/core` exports `isUserNkey`, the shape rule for a user nkey public key, and every parser in core and `@cotal-ai/auth` that checks a user nkey calls it. `mintPublicUserJwt` now refuses a non-string `publicId`, such as a boxed `String`, as every other site already did. Decisions for string ids do not change.
