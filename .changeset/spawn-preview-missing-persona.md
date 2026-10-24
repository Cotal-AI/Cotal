---
"@cotal-ai/cli": patch
---

`spawn --dry-run` refuses a missing persona the way the launch does. It names the catalog directory
or the file it checked, gives `--file <persona.md>` or, for a missing default, the command that
writes one, and uses `TARGET_NOT_FOUND`. It no longer reports an invalid file and points at
`cotal team deploy`.
