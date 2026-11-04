---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Report a TCP listener that does not offer required TLS as `tls-unsupported`, rather than unreachable. Preserve the registration and show the transport mismatch in raw connection, registration and status diagnostics. Consumers of `ProbeResult` must handle the new failure reason.
