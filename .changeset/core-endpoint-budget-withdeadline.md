---
"@cotal-ai/core": patch
---

The endpoint budget races in the action, work, checkpoint, receipt, guard and payment-proof paths now run through the shared `withDeadline` helper instead of six private copies. Each keeps its error code and message.
