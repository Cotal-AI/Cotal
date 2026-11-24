---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal update --self` now skips the version check when npm is offline and the temporary cache has no registry metadata. It does not retry with network access and reports any extension promotion it recovered before the check.
