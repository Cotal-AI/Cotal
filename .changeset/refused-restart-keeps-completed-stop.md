---
"@cotal-ai/cli": patch
---

A restart refused for a busy broker port no longer discards the completed stop on record, so the stop preview before and after the refusal reports the same no-op.
