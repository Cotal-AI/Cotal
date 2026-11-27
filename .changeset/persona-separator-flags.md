---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal persona create` now prints a command that works when a name starts with `-`: the flags come before `--` and only the name comes after it.
