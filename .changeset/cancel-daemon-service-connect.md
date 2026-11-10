---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Daemon disconnect and graceful shutdown cancel pending service HTTP requests instead of waiting for network timeouts.

Cancellation reaches startup metadata, registration, credential and ready requests, including sign-in proof acquisition. Explicit disconnect still forgets resume intent, while shutdown preserves it.
