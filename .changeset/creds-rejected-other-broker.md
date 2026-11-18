---
"@cotal-ai/workspace": patch
---

A command that names a space and gives `--server` the address of another space's broker is now refused with the address `--server` named and the step that reaches the named space at its recorded broker. It used to suggest `cotal up` for a space that was already running.
