---
"@cotal-ai/cli": patch
---

Status checks classify missing manager registries and delivery lease streams by their structured JetStream absence code rather than matching message text. Both `managerNoService` and the delivery lease absence check now rely on `isStreamNotFound` instead of `stream not found` regular expressions.

