---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Validate endpoint `kind` values (`"agent"` or `"endpoint"`) in `CotalEndpoint`, `configFromEnv`, and `saveAgentFile` through `assertValidKind` instead of casting `COTAL_KIND` without validation.
