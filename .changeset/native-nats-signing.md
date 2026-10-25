---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Use Node's native Ed25519 signer for NATS user credentials, auth-callout responses and authority-client renewals, reducing signing CPU cost while preserving the existing key formats, signature bytes and authorization checks.
