---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

`cotal personas list --running` recognizes live personas even when their agents use different display names. It matches the reported source file and shows an unknown status when a live session cannot be attributed.
