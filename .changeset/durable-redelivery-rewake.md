---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Re-announce an unacked durable message on JetStream redelivery, so a wake the host dropped (e.g. during Claude's channel startup window) recovers at the next redelivery instead of leaving the agent a zombie until an unrelated message arrives.
