---
"@cotal-ai/core": patch
---

An agent with no read channels can still be started by a client older than 0.163.0. The credential may ask whether its own delivery durable exists. The durable stays absent, and the credential still cannot fetch or ack it.
