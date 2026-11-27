---
"@cotal-ai/cli": patch
---

`cotal update --self` uses the npm shipped with the running Node when PATH has no npm, or when the npm on PATH states that it does not support that Node.
