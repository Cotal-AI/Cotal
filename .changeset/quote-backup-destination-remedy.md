---
"@cotal-ai/cli": patch
---

`cotal backup create` prints a shell-quoted `chmod` command when the destination folder is not writable.
It omits the command if terminal escaping would change the folder path.
