---
"@cotal-ai/cli": patch
---

When `cotal clean` refuses a linked project folder, its retry in the original project keeps the cleanup target and options, including `--dry-run`.
