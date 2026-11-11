---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
"@cotal-ai/linear": patch
"@cotal-ai/manager": patch
"@cotal-ai/runtime": patch
---

Prevent commands and services from hanging during broker connection teardown.

Share a bounded drain helper that also watches connection closure and always closes after the drain grace period. Use it across owned NATS connection finalizers so credential expiry or an unresponsive broker cannot leave shutdown waiting for a pong.
