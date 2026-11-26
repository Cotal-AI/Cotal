---
"@cotal-ai/cli": patch
---

Interrupting a foreground restore before the manager commit is recorded stops the stack and prints how to continue the same restore, while an interrupt after that commit lets the restore finish before stopping.
