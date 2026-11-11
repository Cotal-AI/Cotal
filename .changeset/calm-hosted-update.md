---
"cotal-ai": patch
"@cotal-ai/auth": patch
---

Cotal update waits through short hosting outages before checking running Manager continuity.
Remote credential exchanges retry timeouts and HTTP 5xx responses within a shared two-minute budget, while HTTP 4xx denials still fail without retry. An exhausted wait names the host and asks you to run the update again without re-registering the space.
