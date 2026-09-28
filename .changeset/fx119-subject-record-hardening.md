---
"@cotal-ai/connector-core": patch
---

The per-principal subject record now refuses a tip of `Number.MAX_SAFE_INTEGER` on read and write and refuses a symlinked record at open, at the re-read and before the rename.
