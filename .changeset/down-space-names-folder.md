---
"@cotal-ai/cli": patch
---

A bare `cotal down --space <name>` or `cotal down --dry-run --space <name>` run outside the folder where that space's stack is recorded now refuses the same way for both, `TARGET_NOT_FOUND` (exit 2), naming that folder and the stop or preview to run there. The stop used to exit 1 with a usage error and the whole help, and neither named the folder.
