---
"@cotal-ai/connector-core": patch
---

Serialize presence writes from one agent so they land in the order they were made, and publish departure only after every write already in flight has settled. This fixes overlapping status writes interleaving their puts (#2055) and an offline record landing before an earlier in-flight status write (#636).
