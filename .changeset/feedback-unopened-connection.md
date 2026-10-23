---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal feedback` now reports a connection that never opened as not sent. A refused connection, a failed DNS lookup or a failed TLS handshake refuses `TARGET_UNAVAILABLE` (exit 2) with the native error code, such as `ECONNREFUSED`, and a next step that names the intake origin. Before, each was reported as `OPERATION_UNKNOWN` "the request may have reached the intake", which sent the user to check an intake that never received anything. A timeout or a connection that breaks after the request was written still reports that the report may have arrived.
