---
"@cotal-ai/cli": patch
---

Bare `cotal completion` names a group-writable or otherwise unsafe config folder once, with the `chmod go-w` that fixes it, instead of two unnamed lines per shell. Files that do not exist under it are reported missing, so a machine with nothing installed is a complete report (exit 0), and Next offers the `chmod` first, never an `install` or `uninstall` that would refuse, and `uninstall` only when something is installed.
