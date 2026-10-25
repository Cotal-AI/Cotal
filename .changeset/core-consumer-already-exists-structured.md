---
"@cotal-ai/core": patch
---

Require a structured JetStream API error for consumer-already-exists recovery. An unrelated error
carrying code 10148 no longer causes run-journal replay to delete and recreate a durable. Genuine
broker conflicts still recover and replay the complete journal.
