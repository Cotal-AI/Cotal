---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal auth mint` now explains how to re-mint an exported credential when `--replace` and `--out` are used together. Leave off `--replace` and pass the existing file to both `--out` and `--identity`.
