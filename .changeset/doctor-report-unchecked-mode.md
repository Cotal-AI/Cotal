---
"@cotal-ai/cli": patch
---

`doctor auth` warns when an open registration was added without checking the broker. It still skips credential inspection and repair, but no longer tells the operator that the broker authenticates nobody.
