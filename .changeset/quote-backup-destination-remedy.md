---
"@cotal-ai/cli": patch
---

`cotal backup create` quotes paths in its `chmod` and retry commands so they can be pasted into a POSIX shell.
It gives instructions without a command if terminal escaping would change a path.
