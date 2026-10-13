---
"@cotal-ai/auth": patch
---

`cotal actor revoke` now reads the delivery daemon's eviction reply through the same check the lifecycle barriers use. It prints `verified gone` only when the reply names the revoked principal, has well-formed counts, and reports a complete scan with no connection left. A reply for another principal, or one that claims `verifiedGone` with an incomplete scan or surviving connections, used to print `live connections closed now (1 kicked, verified gone)`; it now prints the `INCOMPLETE` line with the reason the reply was refused.
