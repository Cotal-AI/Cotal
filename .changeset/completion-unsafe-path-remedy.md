---
"@cotal-ai/cli": patch
---

`cotal completion install` and `uninstall` now name the directory they refuse and why. The refusal said only that completion paths "cross a symlink, untrusted owner or writable ancestor", with no path and no next step. It now names the directory and whether it is a symlink, not a directory, owned by another user, or writable by group or others. For a writable one, Next gives `chmod go-w <path>`. Otherwise Next says to wire completion yourself from `cotal completion script <shell>`.
