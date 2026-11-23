---
"@cotal-ai/cli": patch
---

Cotal update refreshes other connectors even when one fails. It reports the completed refreshes and the failed connectors separately, and still exits nonzero if reconciliation is incomplete.
