---
"@cotal-ai/cli": patch
---

`cotal completion install` and `uninstall` now name a shell that `SHELL` points at but completion does not support, such as tcsh, and refuse it with `UNSUPPORTED` (exit 2), instead of calling the shell unknown and printing the whole help.
