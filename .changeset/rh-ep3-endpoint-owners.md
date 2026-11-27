---
"@cotal-ai/core": patch
---

Internal refactor: the endpoint's status watch, connection supervisor, retry loop and KV watch bookkeeping move to its connection part, the delivery request to its control plane, the chat publish to its messaging part, and the join backfill and replay policy reads to its history part. No behaviour change.
