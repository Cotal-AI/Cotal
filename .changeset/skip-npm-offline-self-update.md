---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal update --self` now reports a skipped version check when npm is offline and leaves the installed release in place. It does not retry with network access after a cache miss.
