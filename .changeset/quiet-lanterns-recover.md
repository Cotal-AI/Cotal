---
"@cotal-ai/cli": patch
---

Interrupting a foreground restore before activation finishes now exits with the signal's code and tells you how to continue the same restore. The command waits for its stack to stop before printing the recovery command.
