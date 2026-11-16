---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
"@cotal-ai/linear": patch
"@cotal-ai/manager": patch
"@cotal-ai/pi": patch
"@cotal-ai/registry": patch
"@cotal-ai/runtime": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Pin the NATS client packages (`@nats-io/nats-core`, `transport-node`, `jetstream`, `kv`, `obj`) to 3.4.0, the versions every suite runs against. They were declared as `^3.4.0`, so an install made after their 3.5.0 release ran a client the product was never tested with.
