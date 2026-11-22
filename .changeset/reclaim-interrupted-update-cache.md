---
"@cotal-ai/cli": patch
---

The first `cotal update --self` that runs more than an hour after an interrupted update of 0.174.1 or older reclaims private scratch that contains only the Node compile cache.
