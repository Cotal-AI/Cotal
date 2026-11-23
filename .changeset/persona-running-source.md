---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

`cotal personas list --running` recognizes live sessions launched from a catalog entry even when their display names differ. It reports an unknown status when a live participant could be using the entry without reporting its source.
