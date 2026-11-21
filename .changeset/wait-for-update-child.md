---
"cotal-ai": patch
"@cotal-ai/workspace": patch
---

On Linux, retrying a self-update waits for a surviving reconciliation child before reporting success. The updater checks the recorded child before it handles an interrupted update or decides that the installed packages are current.
