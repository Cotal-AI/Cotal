---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Remote managers recover interrupted workflow runs at startup without reading each finished run individually. The manager batches the run inventory and checks the original records only for runs still marked running. The operator credential lifetime is unchanged.
