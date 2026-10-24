---
"@cotal-ai/cli": patch
---

`cotal down --dry-run` in the machine home now reads a stack an earlier release started there and names `cotal down --preserve-state`, its stop, or says that none of it is running. With no stack there it says there is nothing to preview, as it does in any other folder.
