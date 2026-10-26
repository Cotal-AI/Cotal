---
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

The auth service no longer exits when a native-key issuance cleanup pass fails because the store did
not answer, as happened when one of its connections reconnected under load. The pass is retried on a
growing wait and logged once, and the service keeps serving. Evidence that does not parse still
stops the service.
