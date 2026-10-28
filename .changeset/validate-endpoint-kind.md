---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

`assertValidKind` validates endpoint kinds (`"agent"` or `"endpoint"`). `CotalEndpoint`, `configFromEnv`, `loadAgentFile`, and `saveAgentFile` share it, so `COTAL_KIND` and `card.kind` refuse any other value instead of passing an unvalidated string through to the card.
