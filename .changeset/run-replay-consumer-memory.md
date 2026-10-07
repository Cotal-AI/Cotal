---
"@cotal-ai/core": patch
---

A hosted run no longer fails a step with the broker's `rename .../o.dat.tmp .../o.dat: no such file or directory` when its journal replay recreates its replay consumer while an earlier consumer of the same name is still being removed. The replay consumer is now created in memory storage, so the broker writes no consumer state files for it. A replay consumer an earlier release left in file storage is removed and remade like any other leftover, rather than refused.
