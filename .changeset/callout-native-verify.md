---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

The auth callout verifies the broker's signed request with Node's Ed25519 instead of the NATS
library's JavaScript curve. That verification cost about 6 ms of CPU per connect, and a mint paid it
twice, so one callout process served about 36 connects a second per core. It now spends about 3.5
ms per connect, and reads the minted credential's issue time from its claims instead of verifying
that credential again. Core exports `decodeNatsJwt`, which makes the same checks as `@nats-io/jwt`'s
`decode` with a native signature check.
