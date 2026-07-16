---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Recover dropped Claude channel wakes without polling by reconciling pending work after activation and reapplying normal connector wake policy when an unacked durable message redelivers.
