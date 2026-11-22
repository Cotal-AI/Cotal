---
"@cotal-ai/cli": patch
---

`cotal backup verify` and `cotal backup inspect` now report a missing manifest at the real backup directory when it is opened through a symbolic link.
