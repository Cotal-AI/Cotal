---
"@cotal-ai/cli": patch
---

The `chmod` step that `cotal up` and `cotal status` name for a broker store this account cannot write printed its path as is, so a root whose name held a backtick or a space gave a command that a shell would substitute or split. The path is now quoted for the shell when it needs it, as the `--root` hints already are.
