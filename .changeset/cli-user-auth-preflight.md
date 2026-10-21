---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

Add a read-only auth-provider server preflight and require it before a controller user-auth stack writes state. Validate the first IdP requirement, existing pin and first-enable JWKS through the native provider, without provisioning, pinning or granting authority. Refuse missing or unreachable IdPs with a typed cause and remedy before maintenance or trust creation, and repeat authoritative checks during preparation.
