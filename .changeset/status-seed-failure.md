---
"@cotal-ai/cli": patch
---

Status now reports recorded connector setup failures and the repair step before startup guidance.
It preserves the failed package, phase and cause in JSON, exits 5 for the incomplete setup, and leaves the seed record unchanged.
